-- Lock down the public schema for the server-only V2 architecture.
-- Frontend never talks to Supabase directly; backend uses service_role.

alter default privileges for role postgres in schema public
  revoke select, insert, update, delete, truncate, references, trigger, maintain
  on tables from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke usage, select, update
  on sequences from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, public;

revoke execute on function public.expense_row_json_v2(public.admin_expenses)
  from public, anon, authenticated;
revoke execute on function public.record_payment_status_change()
  from public, anon, authenticated;
revoke execute on function public.set_updated_at()
  from public, anon, authenticated;

grant execute on function public.expense_row_json_v2(public.admin_expenses)
  to service_role;
grant execute on function public.record_payment_status_change()
  to service_role;
grant execute on function public.set_updated_at()
  to service_role;
