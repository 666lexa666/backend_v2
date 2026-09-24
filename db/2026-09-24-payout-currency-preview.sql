-- WHITECAPITAL V2 payout preview/recording in partner account currency.
-- Payout rows are stored in partner account currency minor units, not RUB minor units.

alter table public.partner_payout_lines
  add column if not exists opening_outstanding_minor bigint not null default 0,
  add column if not exists due_before_payment_minor bigint not null default 0,
  add column if not exists amount_paid_minor bigint not null default 0,
  add column if not exists closing_outstanding_minor bigint not null default 0;

create or replace function public.get_partner_payout_preview_v2(
  p_partner_id bigint,
  p_payout_day date default ((now() at time zone 'Europe/Moscow'))::date
)
returns jsonb
language plpgsql
stable
set search_path=''
as $$
declare
  v_partner public.partners%rowtype;
  v_last public.partner_payouts%rowtype;
  v_start timestamptz;
  v_end timestamptz;
  v_is_weekday boolean;
  v_gross bigint := 0;
  v_comm bigint := 0;
  v_refund bigint := 0;
  v_success_count bigint := 0;
  v_refund_count bigint := 0;
  v_accrued bigint := 0;
  v_opening bigint := 0;
  v_due bigint := 0;
  v_projects jsonb := '[]'::jsonb;
  v_dates jsonb := '[]'::jsonb;
begin
  select * into v_partner
  from public.partners
  where id=p_partner_id
    and is_admin=false
    and archived_at is null;

  if not found then
    raise exception using errcode='P0002',message='PARTNER_NOT_FOUND';
  end if;

  v_is_weekday := extract(isodow from p_payout_day)::int between 1 and 5;
  v_end := (p_payout_day::timestamp at time zone 'Europe/Moscow');

  select * into v_last
  from public.partner_payouts
  where partner_id=p_partner_id
  order by paid_at desc,created_at desc,id desc
  limit 1;

  if found then
    v_start := v_last.period_end;
  else
    select min(ts) into v_start
    from (
      select min(p.paid_at) ts
      from public.payments p
      where p.partner_id=p_partner_id
        and p.status='success'
        and p.paid_at is not null
      union all
      select min(r.completed_at)
      from public.payment_refunds r
      join public.payments p on p.payment_pk=r.payment_pk
      where p.partner_id=p_partner_id
        and r.status='confirmed'
        and r.completed_at is not null
    ) q;
    v_start := coalesce(v_start,v_end);
  end if;

  if v_start > v_end then
    v_start := v_end;
  end if;

  if v_start < v_end then
    select coalesce(
      jsonb_agg(to_char(d::date,'YYYY-MM-DD') order by d),
      '[]'::jsonb
    )
    into v_dates
    from generate_series(
      (v_start at time zone 'Europe/Moscow')::date,
      ((v_end - interval '1 microsecond') at time zone 'Europe/Moscow')::date,
      interval '1 day'
    ) g(d);
  end if;

  with project_finance as (
    select
      pr.id as project_id,
      pr.name as project_name,
      pr.archived_at is not null as project_archived,
      coalesce(prev.closing_outstanding_minor,0)::bigint as opening,
      coalesce(s.gross,0)::bigint as gross,
      coalesce(s.comm,0)::bigint as comm,
      coalesce(s.success_count,0)::bigint as success_count,
      coalesce(r.refund,0)::bigint as refund,
      coalesce(r.refund_count,0)::bigint as refund_count
    from public.partner_projects pr
    left join public.partner_payout_lines prev
      on v_last.id is not null
     and prev.payout_id=v_last.id
     and prev.project_id=pr.id
    left join lateral (
      select
        coalesce(sum(p.amount_currency_minor),0)::bigint gross,
        coalesce(sum(p.commission_currency_minor),0)::bigint comm,
        count(*)::bigint success_count
      from public.payments p
      where p.partner_id=p_partner_id
        and p.project_id=pr.id
        and p.status='success'
        and p.paid_at>=v_start
        and p.paid_at<v_end
    ) s on true
    left join lateral (
      select
        coalesce(sum(rr.amount_currency_minor),0)::bigint refund,
        count(*)::bigint refund_count
      from public.payment_refunds rr
      join public.payments p on p.payment_pk=rr.payment_pk
      where p.partner_id=p_partner_id
        and p.project_id=pr.id
        and rr.status='confirmed'
        and rr.completed_at>=v_start
        and rr.completed_at<v_end
    ) r on true
    where pr.partner_id=p_partner_id
  ),
  totals as (
    select
      coalesce(sum(opening),0)::bigint opening,
      coalesce(sum(gross),0)::bigint gross,
      coalesce(sum(comm),0)::bigint comm,
      coalesce(sum(refund),0)::bigint refund,
      coalesce(sum(success_count),0)::bigint success_count,
      coalesce(sum(refund_count),0)::bigint refund_count
    from project_finance
  )
  select
    t.opening,t.gross,t.comm,t.refund,t.success_count,t.refund_count,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'projectId',pf.project_id,
        'projectName',pf.project_name,
        'projectArchived',pf.project_archived,
        'currency',trim(v_partner.account_currency),
        'commissionPercent',v_partner.commission_percent,
        'openingOutstanding',pf.opening,
        'successAmount',pf.gross,
        'successCount',pf.success_count,
        'successCommission',pf.comm,
        'successNet',pf.gross-pf.comm,
        'refundAmount',pf.refund,
        'refundCount',pf.refund_count,
        'refundDeduction',pf.refund,
        'accruedAmount',pf.gross-pf.comm-pf.refund,
        'payoutAmount',pf.opening+pf.gross-pf.comm-pf.refund
      ) order by pf.project_name,pf.project_id)
      from project_finance pf
      where pf.opening<>0 or pf.gross<>0 or pf.comm<>0 or pf.refund<>0
    ),'[]'::jsonb)
  into v_opening,v_gross,v_comm,v_refund,v_success_count,v_refund_count,v_projects
  from totals t;

  v_accrued := v_gross-v_comm-v_refund;
  v_due := v_opening+v_accrued;

  return jsonb_build_object(
    'partnerId',p_partner_id,
    'partnerName',coalesce(v_partner.company_name,v_partner.email,v_partner.login,'Партнёр #'||p_partner_id),
    'partnerActive',v_partner.is_active,
    'environment',v_partner.environment,
    'currency',trim(v_partner.account_currency),
    'commissionPercent',v_partner.commission_percent,
    'payoutDay',p_payout_day,
    'isPayoutDay',v_is_weekday,
    'canExecute',v_is_weekday and v_due>0 and v_end>v_start,
    'window',jsonb_build_object(
      'from',v_start,
      'to',v_end,
      'dates',v_dates,
      'timezone','Europe/Moscow',
      'note',case
        when not v_is_weekday then 'В выходные выплаты не выполняются. Период продолжает накапливаться до следующего буднего дня.'
        when v_end=v_start then 'После последней выплаты новых расчётных операций нет.'
        else 'Расчёт идёт с момента последней выплаты до начала выбранного дня по МСК.'
      end
    ),
    'openingOutstanding',v_opening,
    'successAmount',v_gross,
    'successCount',v_success_count,
    'successCommission',v_comm,
    'successNet',v_gross-v_comm,
    'refundAmount',v_refund,
    'refundCount',v_refund_count,
    'refundDeduction',v_refund,
    'accruedAmount',v_accrued,
    'payoutAmount',v_due,
    'projects',v_projects
  );
end;
$$;

create or replace function public.get_all_partner_payout_previews_v2(
  p_payout_day date default ((now() at time zone 'Europe/Moscow'))::date
)
returns jsonb
language sql
stable
set search_path=''
as $$
  select coalesce(
    jsonb_agg(
      public.get_partner_payout_preview_v2(p.id,p_payout_day)
      order by p.id
    ),
    '[]'::jsonb
  )
  from public.partners p
  where p.is_admin=false
    and p.archived_at is null;
$$;

create or replace function public.record_partner_payout_v2(
  p_partner_id bigint,
  p_amount_paid_minor bigint,
  p_paid_at timestamptz,
  p_idempotency_key text,
  p_created_by bigint,
  p_external_ref text default null,
  p_note text default null
)
returns jsonb
language plpgsql
set search_path=''
as $$
declare
  v_day date;
  v_preview jsonb;
  v_start timestamptz;
  v_end timestamptz;
  v_opening bigint;
  v_gross bigint;
  v_comm bigint;
  v_refund bigint;
  v_accrued bigint;
  v_due bigint;
  v_closing bigint;
  v_payout public.partner_payouts%rowtype;
  v_line jsonb;
  v_line_due bigint;
  v_line_paid bigint;
  v_remaining_paid bigint;
  v_remaining_positive_due bigint;
  v_recorded_projects jsonb := '[]'::jsonb;
begin
  if p_amount_paid_minor is null or p_amount_paid_minor<=0 then
    raise exception using errcode='22023',message='PAYOUT_AMOUNT_MUST_BE_POSITIVE';
  end if;
  if nullif(btrim(coalesce(p_idempotency_key,'')),'') is null then
    raise exception using errcode='22023',message='IDEMPOTENCY_KEY_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(93211,p_partner_id::integer);

  select * into v_payout
  from public.partner_payouts
  where partner_id=p_partner_id and idempotency_key=p_idempotency_key;

  if found then
    return to_jsonb(v_payout) || jsonb_build_object('replayed',true);
  end if;

  v_day := (p_paid_at at time zone 'Europe/Moscow')::date;
  if extract(isodow from v_day)::int not between 1 and 5 then
    raise exception using errcode='22023',message='PAYOUTS_DISABLED_ON_WEEKENDS';
  end if;

  v_preview := public.get_partner_payout_preview_v2(p_partner_id,v_day);
  v_start := (v_preview->'window'->>'from')::timestamptz;
  v_end := (v_preview->'window'->>'to')::timestamptz;
  v_opening := coalesce((v_preview->>'openingOutstanding')::bigint,0);
  v_gross := coalesce((v_preview->>'successAmount')::bigint,0);
  v_comm := coalesce((v_preview->>'successCommission')::bigint,0);
  v_refund := coalesce((v_preview->>'refundAmount')::bigint,0);
  v_accrued := coalesce((v_preview->>'accruedAmount')::bigint,0);
  v_due := coalesce((v_preview->>'payoutAmount')::bigint,0);

  if v_due<=0 then
    raise exception using errcode='22023',message='NOTHING_TO_PAYOUT';
  end if;
  if p_amount_paid_minor>v_due then
    raise exception using errcode='22023',message='PAYOUT_EXCEEDS_DUE';
  end if;

  v_closing := v_due-p_amount_paid_minor;

  insert into public.partner_payouts(
    partner_id,paid_at,payout_day,period_start,period_end,
    opening_outstanding_minor,gross_success_minor,commission_minor,refund_minor,
    accrued_minor,due_before_payment_minor,amount_paid_minor,closing_outstanding_minor,
    currency,external_ref,note,idempotency_key,created_by
  ) values (
    p_partner_id,p_paid_at,v_day,v_start,v_end,
    v_opening,v_gross,v_comm,v_refund,
    v_accrued,v_due,p_amount_paid_minor,v_closing,
    coalesce(nullif(v_preview->>'currency',''),'RUB'),
    nullif(btrim(coalesce(p_external_ref,'')),''),
    nullif(btrim(coalesce(p_note,'')),''),
    p_idempotency_key,p_created_by
  ) returning * into v_payout;

  select coalesce(sum(greatest((value->>'payoutAmount')::bigint,0)),0)::bigint
  into v_remaining_positive_due
  from jsonb_array_elements(coalesce(v_preview->'projects','[]'::jsonb));

  v_remaining_paid := p_amount_paid_minor;

  for v_line in
    select value
    from jsonb_array_elements(coalesce(v_preview->'projects','[]'::jsonb))
  loop
    v_line_due := coalesce((v_line->>'payoutAmount')::bigint,0);
    v_line_paid := 0;

    if v_line_due>0 and v_remaining_paid>0 and v_remaining_positive_due>0 then
      if v_line_due=v_remaining_positive_due then
        v_line_paid := least(v_line_due,v_remaining_paid);
      else
        v_line_paid := least(
          v_line_due,
          floor((v_remaining_paid::numeric*v_line_due::numeric)/v_remaining_positive_due::numeric)::bigint
        );
      end if;
    end if;

    v_remaining_paid := v_remaining_paid-v_line_paid;
    if v_line_due>0 then
      v_remaining_positive_due := v_remaining_positive_due-v_line_due;
    end if;

    insert into public.partner_payout_lines(
      payout_id,project_id,
      opening_outstanding_minor,
      gross_success_minor,commission_minor,refund_minor,accrued_minor,
      due_before_payment_minor,amount_paid_minor,closing_outstanding_minor
    ) values (
      v_payout.id,
      (v_line->>'projectId')::uuid,
      coalesce((v_line->>'openingOutstanding')::bigint,0),
      coalesce((v_line->>'successAmount')::bigint,0),
      coalesce((v_line->>'successCommission')::bigint,0),
      coalesce((v_line->>'refundAmount')::bigint,0),
      coalesce((v_line->>'accruedAmount')::bigint,0),
      v_line_due,
      v_line_paid,
      v_line_due-v_line_paid
    );

    v_recorded_projects := v_recorded_projects || jsonb_build_array(
      v_line || jsonb_build_object(
        'amountPaid',v_line_paid,
        'closingOutstanding',v_line_due-v_line_paid
      )
    );
  end loop;

  if v_remaining_paid<>0 then
    raise exception using errcode='P0001',message='PAYOUT_PROJECT_ALLOCATION_MISMATCH';
  end if;

  return to_jsonb(v_payout)
    || jsonb_build_object(
      'replayed',false,
      'projects',v_recorded_projects
    );
end;
$$;

revoke all on function public.get_partner_payout_preview_v2(bigint,date) from public,anon,authenticated;
revoke all on function public.get_all_partner_payout_previews_v2(date) from public,anon,authenticated;
revoke all on function public.record_partner_payout_v2(bigint,bigint,timestamptz,text,bigint,text,text) from public,anon,authenticated;

grant execute on function public.get_partner_payout_preview_v2(bigint,date) to service_role;
grant execute on function public.get_all_partner_payout_previews_v2(date) to service_role;
grant execute on function public.record_partner_payout_v2(bigint,bigint,timestamptz,text,bigint,text,text) to service_role;
