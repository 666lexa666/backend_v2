const { getSupabaseAdminClient } = require('./supabase');

async function findBankById(bankId, client = getSupabaseAdminClient()) {
  if (!bankId) return null;
  const { data, error } = await client
    .from('banks')
    .select('*')
    .eq('id', bankId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const config = data.config && typeof data.config === 'object' ? data.config : {};
  return {
    ...config,
    ...data,
    // Keep the V1 internal field names available to the public compatibility layer.
    qr_register_url: config.qr_register_url ?? null,
    refund_url: config.refund_url ?? null,
    certificate_base64: config.certificate_base64 ?? null,
    certificate_password: config.certificate_password ?? null,
    tls_reject_unauthorized: config.tls_reject_unauthorized !== false,
    sbp_subscription_pay_url: config.sbp_subscription_pay_url ?? null,
    api_base_url: config.api_base_url ?? null,
    api_username: config.api_username ?? null,
    api_password: config.api_password ?? null,
    callback_token: config.callback_token ?? null,
    card_terminal_id: config.card_terminal_id ?? null,
    card_init_url: config.card_init_url ?? null,
    card_finish_url: config.card_finish_url ?? null,
    card_submit3ds_url: config.card_submit3ds_url ?? null,
    card_reversal_url: config.card_reversal_url ?? null,
    card_refund_url: config.card_refund_url ?? null,
  };
}

module.exports = { findBankById };
