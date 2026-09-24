const crypto = require('node:crypto');
const { getSupabaseAdminClient } = require('./supabase');
const { buildPartnerWebhookPayload, sendPartnerWebhook } = require('./partnerWebhook');
const { hydrateLegacyPartner } = require('./partnerApiAuth');

async function enqueuePartnerWebhook({ paymentId, notificationType, body = {} }) {
  const db = getSupabaseAdminClient();

  const { data: payment, error: paymentError } = await db
    .from('payments')
    .select('*,payment_provider_data(*)')
    .eq('id', paymentId)
    .maybeSingle();
  if (paymentError) throw paymentError;
  if (!payment) throw new Error('Payment not found for webhook enqueue');

  const { data: partnerRow, error: partnerError } = await db
    .from('partners')
    .select('*')
    .eq('id', payment.partner_id)
    .maybeSingle();
  if (partnerError) throw partnerError;
  if (!partnerRow) throw new Error('Partner not found for webhook enqueue');

  const { data: credentials, error: credentialsError } = await db
    .from('partner_credentials')
    .select('webhook_secret')
    .eq('partner_id', partnerRow.id)
    .maybeSingle();
  if (credentialsError) throw credentialsError;

  const partner = hydrateLegacyPartner(partnerRow, credentials);
  const metadata = payment.metadata && typeof payment.metadata === 'object' ? payment.metadata : {};
  const destinationUrl = String(metadata.clientWebhookUrl || partner.webhook_url || '').trim();
  if (!destinationUrl) {
    return { queued: false, skipped: true, reason: 'PARTNER_WEBHOOK_URL_NOT_SET' };
  }

  const { data: payerData, error: payerError } = await db
    .from('payment_payer_data')
    .select('payer_reference,payer_phone_masked,payer_pam_masked,updated_at')
    .eq('payment_pk', payment.payment_pk)
    .maybeSingle();
  if (payerError) throw payerError;

  const { data: refunds, error: refundsError } = await db
    .from('payment_refunds')
    .select('id,amount_minor,status,provider_ref_id,provider_trx_id,requested_at,completed_at,updated_at,metadata')
    .eq('payment_pk', payment.payment_pk)
    .order('requested_at', { ascending: false })
    .limit(1);
  if (refundsError) throw refundsError;
  const latestRefund = refunds?.[0] || null;

  const normalizedPayment = {
    ...payment,
    provider_payment_id: payment.payment_provider_data?.provider_trx_id || payment.provider_payment_id || null,
    bank_c2b_trx_id: payment.payment_provider_data?.provider_trx_id || payment.provider_payment_id || null,
    bank_snd_pam: payerData?.payer_pam_masked || null,
    bank_snd_phone_masked: payerData?.payer_phone_masked || null,
    account_currency: payment.currency || 'RUB',
    amount_currency_minor: payment.amount_minor ?? null,
    effective_currency_rate_rub: payment.currency_rate_rub_snapshot ?? null,
    refund_amount: latestRefund?.amount_minor ?? null,
    refund_ref_id: latestRefund?.provider_ref_id || null,
    refund_status: latestRefund?.status || null,
    refund_completed_at: latestRefund?.completed_at || null,
    bank_webhook_received_at: metadata.bankWebhookReceivedAt || metadata.bank_webhook_received_at || null,
  };

  const payload = buildPartnerWebhookPayload(notificationType, normalizedPayment, body, partner);
  const eventKey = stableUuid(payload.eventId);

  const { data: row, error } = await db
    .from('webhook_outbox')
    .upsert({
      event_key: eventKey,
      payment_pk: payment.payment_pk,
      partner_id: partner.id,
      event_type: payload.eventType,
      destination_url: destinationUrl,
      payload,
      status: 'pending',
      next_attempt_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'event_key', ignoreDuplicates: true })
    .select('*')
    .maybeSingle();

  if (error) throw error;
  return {
    queued: Boolean(row),
    skipped: false,
    duplicate: !row,
    eventId: payload.eventId,
    eventKey,
  };
}

async function processPartnerWebhookBatch({ workerId, limit = 50, leaseSeconds = 120 } = {}) {
  const db = getSupabaseAdminClient();
  const id = String(workerId || `wc-webhook-${process.pid}`);

  const { data: jobs, error } = await db.rpc('claim_webhook_outbox', {
    p_worker_id: id,
    p_limit: Math.max(1, Math.min(Number(limit) || 50, 500)),
    p_lease_seconds: Math.max(30, Math.min(Number(leaseSeconds) || 120, 3600)),
  });
  if (error) throw error;

  const results = [];
  for (const job of jobs || []) {
    results.push(await deliverClaimedJob(job));
  }
  return results;
}

async function deliverClaimedJob(job) {
  const db = getSupabaseAdminClient();

  const { data: credentials, error: credentialsError } = await db
    .from('partner_credentials')
    .select('webhook_secret')
    .eq('partner_id', job.partner_id)
    .maybeSingle();
  if (credentialsError) throw credentialsError;

  const result = await sendPartnerWebhook(job.destination_url, job.payload, {
    webhookSecret: credentials?.webhook_secret || null,
    maxAttempts: 1,
  });

  if (result.delivered) {
    const { error } = await db.from('webhook_outbox').update({
      status: 'delivered',
      lease_owner: null,
      lease_token: null,
      lease_until: null,
      last_http_status: result.statusCode || null,
      last_error: null,
      delivered_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', job.id).eq('lease_token', job.lease_token);
    if (error) throw error;

    return { id: job.id, delivered: true, statusCode: result.statusCode || null };
  }

  const attempts = Number(job.attempt_count || 1);
  const terminal = attempts >= Number(process.env.PARTNER_WEBHOOK_MAX_ATTEMPTS || 8);
  const retrySeconds = Math.min(3600, Math.max(5, 5 * (2 ** Math.max(0, attempts - 1))));
  const nextAttemptAt = new Date(Date.now() + retrySeconds * 1000).toISOString();

  const { error } = await db.from('webhook_outbox').update({
    status: terminal ? 'failed' : 'retry',
    lease_owner: null,
    lease_token: null,
    lease_until: null,
    last_http_status: result.statusCode || null,
    last_error: result.error || 'CLIENT_WEBHOOK_REQUEST_FAILED',
    next_attempt_at: terminal ? job.next_attempt_at : nextAttemptAt,
    updated_at: new Date().toISOString(),
  }).eq('id', job.id).eq('lease_token', job.lease_token);
  if (error) throw error;

  return {
    id: job.id,
    delivered: false,
    terminal,
    statusCode: result.statusCode || null,
    error: result.error || null,
  };
}

function stableUuid(seed) {
  const hex = crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ['8','9','a','b'][parseInt(hex[16], 16) % 4];
  const s = hex.join('');
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}

module.exports = {
  enqueuePartnerWebhook,
  processPartnerWebhookBatch,
  stableUuid,
};
