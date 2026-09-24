const { hydrateLegacyPartner } = require('./partnerApiAuth');

function maskPrefix(prefix) {
  if (!prefix) return null;
  return `${String(prefix)}••••••••`;
}

function portalPartner(partner, { integrationReady = false, includeCommission = false } = {}) {
  const p = hydrateLegacyPartner(partner);
  const settings = p.settings && typeof p.settings === 'object' ? p.settings : {};
  const currency = String(p.account_currency || 'RUB').trim().toUpperCase();

  const result = {
    id: p.id,
    public_id: p.public_id,
    created_at: p.created_at,
    login: p.login,
    email: p.email || p.login,
    email_verified_at: p.email_verified_at,
    company_name: p.company_name,
    merchant_id: p.merchant_id,
    is_admin: Boolean(p.is_admin),
    is_active: Boolean(p.is_active),
    environment: p.environment || 'production',
    environment_revision: Number(p.environment_revision || 0),
    api_key_masked: maskPrefix(p.api_key_prefix),
    api_key_can_reveal: false,
    webhook_secret_masked: maskPrefix(p.webhook_secret_prefix),
    webhook_secret_can_reveal: !settings.webhook_secret_revealed_at,
    webhook_url: p.webhook_url || null,
    redirect_url: p.redirect_url || null,
    failure_redirect_url: p.failure_redirect_url || null,
    qr_exp_dt: Number(p.qr_exp_dt || 15),
    qr_local_exp_dt: Number(p.qr_local_exp_dt || 900),
    ext_entity_id: p.ext_entity_id || null,
    account: p.account || null,
    acc_alias: p.acc_alias || null,
    account_dr: p.account_dr || null,
    forward_payer_data: Boolean(p.forward_payer_data),
    account_currency: currency,
    currency_markup_percent: Number(p.currency_markup_percent || 0),
    latest_currency_rate_rub: p.latest_currency_rate_rub == null ? null : Number(p.latest_currency_rate_rub),
    effective_currency_rate_rub: effectiveRate(p),
    integration_ready: Boolean(integrationReady || (p.ext_entity_id && p.merchant_id && (p.account || p.acc_alias))),
    deposit_enabled: Boolean(p.deposit_enabled),
    deposit_capped: Boolean(p.deposit_capped),
    min_amount_kopecks: p.min_amount_kopecks == null ? null : Number(p.min_amount_kopecks),
    max_amount_kopecks: p.max_amount_kopecks == null ? null : Number(p.max_amount_kopecks),
    terminal_auto_distribution_enabled: Boolean(p.terminal_auto_distribution_enabled),
    terminal_analytics_enabled: Boolean(p.terminal_analytics_enabled),
    telegram_daily_reports_enabled: Boolean(p.telegram_daily_reports_enabled),
    qr_client_identity_required: Boolean(p.require_qr_client_identity),
    qr_client_phone_required: Boolean(p.require_qr_client_identity || p.purpose_use_client_phone),
  };

  if (includeCommission) {
    result.commission_percent = Number(p.commission_percent || 0);
    result.bank_id = p.bank_id || null;
    result.purpose_use_transaction_id = Boolean(p.purpose_use_transaction_id);
    result.purpose_use_client_phone = Boolean(p.purpose_use_client_phone);
    result.require_qr_client_identity = Boolean(p.require_qr_client_identity);
    result.checkout_payment_methods = p.checkout_payment_methods || null;
    result.ignore_request_terminal_id = Boolean(p.ignore_request_terminal_id);
  }

  return result;
}

function effectiveRate(p) {
  if (String(p.account_currency || 'RUB').toUpperCase() === 'RUB') return 1;
  const base = Number(p.latest_currency_rate_rub || 0);
  const markup = Number(p.currency_markup_percent || 0);
  return base > 0 ? Math.round(base * (1 + markup / 100) * 1e6) / 1e6 : null;
}

module.exports = { portalPartner };
