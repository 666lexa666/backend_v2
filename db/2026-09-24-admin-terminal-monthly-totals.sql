-- Admin terminal monthly totals from hourly aggregates.
-- Uses payment_stats_hourly instead of scanning raw payments.

create or replace function public.get_terminal_monthly_totals_v2()
returns table(
  catalog_terminal_id uuid,
  successful_count bigint,
  successful_amount_minor bigint
)
language sql
security invoker
set search_path=''
as $$
  select
    pt.terminal_id as catalog_terminal_id,
    coalesce(sum(s.count),0)::bigint as successful_count,
    coalesce(sum(s.amount_minor),0)::bigint as successful_amount_minor
  from public.payment_stats_hourly s
  join public.partner_terminals pt
    on pt.id = s.partner_terminal_id
  where s.status = 'success'
    and s.bucket_start >= (
      date_trunc('month', timezone('Europe/Moscow', now()))
      at time zone 'Europe/Moscow'
    )
  group by pt.terminal_id;
$$;

revoke all on function public.get_terminal_monthly_totals_v2()
from public, anon, authenticated;

grant execute on function public.get_terminal_monthly_totals_v2()
to service_role;
