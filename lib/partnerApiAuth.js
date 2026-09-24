const { getSupabaseAdminClient } = require('./supabase');
const { sha256 } = require('./security');

function getApiKey(req) {
  const authorization = req.headers.authorization;
  if (authorization && authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }

  const headerApiKey = req.headers['x-api-key'];
  if (typeof headerApiKey === 'string' && headerApiKey.trim()) {
    return headerApiKey.trim();
  }

  return null;
}

async function findPartnerByApiKey(apiKey, client = getSupabaseAdminClient()) {
  if (!apiKey) return null;

  const { data: partner, error } = await client
    .from('partners')
    .select('*')
    .eq('api_key_hash', sha256(apiKey))
    .eq('is_admin', false)
    .maybeSingle();

  if (error) throw error;
  if (!partner) return null;

  const { data: credentials, error: credentialsError } = await client
    .from('partner_credentials')
    .select('webhook_secret')
    .eq('partner_id', partner.id)
    .maybeSingle();

  if (credentialsError) throw credentialsError;

  return hydrateLegacyPartner(partner, credentials);
}

function hydrateLegacyPartner(partner, credentials = null) {
  const settings = partner && typeof partner.settings === 'object' && partner.settings
    ? partner.settings
    : {};

  // Compatibility object used only inside the public Partner API.
  // Internal /admin and /client routes should use the normalized V2 schema directly.
  return {
    ...settings,
    ...partner,
    webhook_secret: credentials?.webhook_secret || null,
    bank_id: nullableNumber(settings.bank_id),
    qr_exp_dt: nullableNumber(settings.qr_exp_dt),
    qr_local_exp_dt: nullableNumber(settings.qr_local_exp_dt),
    currency_markup_percent: nullableNumber(settings.currency_markup_percent),
    latest_currency_rate_rub: nullableNumber(settings.latest_currency_rate_rub),
    min_amount_kopecks: nullableNumber(settings.min_amount_kopecks),
    max_amount_kopecks: nullableNumber(settings.max_amount_kopecks),
    ext_entity_id: settings.ext_entity_id ?? null,
    account: settings.account ?? null,
    acc_alias: settings.acc_alias ?? null,
    account_dr: settings.account_dr ?? null,
    forward_payer_data: Boolean(settings.forward_payer_data),
    deposit_enabled: Boolean(settings.deposit_enabled),
    deposit_capped: Boolean(settings.deposit_capped),
    purpose_use_transaction_id: Boolean(settings.purpose_use_transaction_id),
    purpose_use_client_phone: Boolean(settings.purpose_use_client_phone),
    require_qr_client_identity: Boolean(settings.require_qr_client_identity),
    terminal_auto_distribution_enabled: Boolean(settings.terminal_auto_distribution_enabled),
    ignore_request_terminal_id: Boolean(settings.ignore_request_terminal_id),
    checkout_payment_methods: settings.checkout_payment_methods || null,
  };
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function partnerApiAuth(options = {}) {
  const client = options.client || getSupabaseAdminClient();

  return async function authenticatePartnerApi(req, res, next) {
    try {
      const apiKey = getApiKey(req);
      if (!apiKey) {
        return res.status(401).json({
          success: false,
          error: 'UNAUTHORIZED',
          message: 'Передайте API-ключ в Authorization: Bearer <api_key> или X-API-Key',
        });
      }

      const partner = await findPartnerByApiKey(apiKey, client);
      if (!partner) {
        return res.status(401).json({
          success: false,
          error: 'INVALID_API_KEY',
          message: 'Неверный API-ключ',
        });
      }

      if (partner.is_active === false) {
        return res.status(403).json({
          success: false,
          error: 'PARTNER_DISABLED',
          message: 'Работа партнера временно приостановлена',
        });
      }

      req.partner = partner;
      req.partnerApiKey = apiKey;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = {
  getApiKey,
  findPartnerByApiKey,
  hydrateLegacyPartner,
  partnerApiAuth,
};
