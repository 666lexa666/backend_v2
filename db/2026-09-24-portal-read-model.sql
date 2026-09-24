-- Portal read model for frontend_v2. Service-role only.
create or replace view public.portal_payments_v2
with (security_invoker = true)
as
select
  p.id,p.payment_pk,p.partner_id,p.project_id,pr.name as project_name,
  p.partner_terminal_id,p.partner_terminal_id as terminal_id,
  coalesce(pt.label,t.name) as terminal_label,
  coalesce(t.company_name,t.name) as terminal_tsp_name,
  p.bank_id,b.name as bank_name,b.code as bank_code,p.payment_type,p.qrc_type,
  p.partner_order_id,p.amount_minor as amount,p.amount_minor,
  p.currency as account_currency,
  coalesce((p.metadata->>'amount_currency_minor')::bigint,p.amount_minor) as amount_currency_minor,
  p.currency_rate_rub_snapshot as effective_currency_rate_rub,p.status,p.qrc_id,
  pd.qr_payload,pd.provider_code,pd.provider_order_id as bank_order_id,
  pd.provider_trx_id as trx_id,pd.provider_trx_time,pd.terminal_snapshot,
  p.provider_payment_id,p.paid_at,p.expires_at,p.created_at,p.updated_at,
  p.metadata->>'paymentPurpose' as payment_purpose,
  p.metadata->>'clientPhone' as client_phone,
  p.metadata->>'clientPam' as client_pam,
  payer.payer_pam_masked as bank_snd_pam,
  payer.payer_phone_masked as bank_snd_phone_masked,
  rf.status as refund_status,rf.amount_minor as refund_amount,
  rf.provider_ref_id as refund_ref_id,rf.provider_trx_id as refund_trx_id,
  rf.completed_at as refund_completed_at,
  wo.status as client_webhook_status,wo.last_http_status as client_webhook_http_status,
  wo.attempt_count as client_webhook_attempt_count
from public.payments p
left join public.partner_projects pr on pr.id=p.project_id
left join public.partner_terminals pt on pt.id=p.partner_terminal_id
left join public.terminals t on t.id=pt.terminal_id
left join public.banks b on b.id=p.bank_id
left join public.payment_provider_data pd on pd.payment_pk=p.payment_pk
left join public.payment_payer_data payer on payer.payment_pk=p.payment_pk
left join lateral (
  select r.status,r.amount_minor,r.provider_ref_id,r.provider_trx_id,r.completed_at
  from public.payment_refunds r where r.payment_pk=p.payment_pk
  order by r.requested_at desc limit 1
) rf on true
left join lateral (
  select w.status,w.last_http_status,w.attempt_count
  from public.webhook_outbox w where w.payment_pk=p.payment_pk
  order by w.created_at desc,w.id desc limit 1
) wo on true;

create or replace view public.portal_refunds_v2
with (security_invoker = true)
as
select r.id,r.payment_pk,p.partner_id,p.project_id,p.partner_terminal_id,
       r.amount_minor,r.status,r.provider_ref_id,r.provider_trx_id,
       r.requested_at,r.completed_at,r.updated_at
from public.payment_refunds r
join public.payments p on p.payment_pk=r.payment_pk;

revoke all on public.portal_payments_v2 from anon,authenticated;
revoke all on public.portal_refunds_v2 from anon,authenticated;
grant select on public.portal_payments_v2 to service_role;
grant select on public.portal_refunds_v2 to service_role;
