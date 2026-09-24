-- WHITECAPITAL V2 payment routing/read optimization and atomic payment creation.

create or replace view public.partner_payment_routes_v2
with (security_invoker = true)
as
select
  pt.id as partner_terminal_id,
  pt.partner_id,
  pt.project_id,
  pt.terminal_id,
  pt.label,
  pt.min_amount_minor,
  pt.max_amount_minor,
  pt.auto_distribution_enabled,
  pt.is_default,
  pt.is_active as assignment_active,
  pt.archived_at as assignment_archived_at,
  pt.provider_config as assignment_provider_config,
  pt.settings as assignment_settings,
  t.bank_id,
  t.name as terminal_name,
  t.company_name,
  t.payment_method,
  t.provider_terminal_key,
  t.merchant_id as catalog_merchant_id,
  t.ext_entity_id as catalog_ext_entity_id,
  t.account as catalog_account,
  t.acc_alias as catalog_acc_alias,
  t.provider_config as terminal_provider_config,
  t.supports_recurrent_payments,
  t.min_amount_minor as catalog_min_amount_minor,
  t.max_amount_minor as catalog_max_amount_minor,
  t.is_active as terminal_active,
  t.archived_at as terminal_archived_at,
  greatest(coalesce(pt.min_amount_minor,t.min_amount_minor),coalesce(t.min_amount_minor,pt.min_amount_minor)) as effective_min_amount_minor,
  least(coalesce(pt.max_amount_minor,t.max_amount_minor),coalesce(t.max_amount_minor,pt.max_amount_minor)) as effective_max_amount_minor,
  b.provider_code,
  b.payment_methods as bank_payment_methods
from public.partner_terminals pt
join public.terminals t on t.id=pt.terminal_id
join public.banks b on b.id=t.bank_id
where pt.archived_at is null
  and pt.is_active=true
  and t.archived_at is null
  and t.is_active=true
  and b.is_active=true;

revoke all on public.partner_payment_routes_v2 from anon, authenticated;
grant select on public.partner_payment_routes_v2 to service_role;

create or replace function public.create_payment_v2(
  p_partner_id bigint,
  p_project_id uuid,
  p_partner_terminal_id uuid,
  p_bank_id bigint,
  p_payment_type text,
  p_qrc_type text,
  p_partner_order_id text,
  p_amount_minor bigint,
  p_currency text,
  p_status text,
  p_commission_percent numeric,
  p_currency_rate_rub numeric,
  p_metadata jsonb,
  p_terminal_snapshot jsonb,
  p_routing_snapshot jsonb
)
returns public.payments
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_payment public.payments;
begin
  insert into public.payments(
    id,request_id,partner_id,project_id,partner_terminal_id,bank_id,payment_type,qrc_type,
    partner_order_id,amount_minor,currency,status,commission_percent_snapshot,currency_rate_rub_snapshot,metadata
  )
  values(
    gen_random_uuid(),gen_random_uuid(),p_partner_id,p_project_id,p_partner_terminal_id,p_bank_id,
    upper(p_payment_type),p_qrc_type,p_partner_order_id,p_amount_minor,
    upper(coalesce(p_currency,'RUB'))::char(3),p_status,
    coalesce(p_commission_percent,0),
    coalesce(p_currency_rate_rub,1),
    coalesce(p_metadata,'{}'::jsonb)
  )
  returning * into v_payment;

  insert into public.payment_provider_data(payment_pk,provider_code,terminal_snapshot,routing_snapshot,updated_at)
  values(v_payment.payment_pk,null,coalesce(p_terminal_snapshot,'{}'::jsonb),coalesce(p_routing_snapshot,'{}'::jsonb),now());

  return v_payment;
end;
$$;

revoke all on function public.create_payment_v2(
  bigint,uuid,uuid,bigint,text,text,text,bigint,text,text,numeric,numeric,jsonb,jsonb,jsonb
) from public, anon, authenticated;

grant execute on function public.create_payment_v2(
  bigint,uuid,uuid,bigint,text,text,text,bigint,text,text,numeric,numeric,jsonb,jsonb,jsonb
) to service_role;
