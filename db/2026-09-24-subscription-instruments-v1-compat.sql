-- V1 recurring instrument compatibility.
-- SBP instruments use subscription_qrc_id / bank_binding_id.
-- CARD instruments additionally persist the partner-facing cardToken and the first bank payment id.

alter table public.checkout_subscription_instruments
  add column if not exists card_token uuid,
  add column if not exists card_first_payment_id text;

create unique index if not exists checkout_instruments_card_token_uidx
  on public.checkout_subscription_instruments(partner_id, card_token)
  where card_token is not null;

-- Operational cutover note:
-- checkout_subscription_instruments is live data in the legacy database and continues to drift
-- until traffic is switched. Run the idempotent subscription-instrument delta sync immediately
-- before production cutover; preserve ids, partner_id, project_id, customer_id,
-- origin_session_id and terminal assignment UUIDs.
