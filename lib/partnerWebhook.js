const crypto = require('node:crypto');

async function sendPartnerWebhook(url, payload, options = {}) {
  if (!url) {
    return {
      delivered: false,
      attempts: 0,
      skipped: true,
      error: 'PARTNER_WEBHOOK_URL_NOT_SET',
      statusCode: null,
    };
  }

  const maxAttempts = Number(options.maxAttempts || process.env.CLIENT_WEBHOOK_MAX_ATTEMPTS || 3);
  const timeoutMs = Number(options.timeoutMs || process.env.CLIENT_WEBHOOK_TIMEOUT_MS || 10000);
  const webhookSecret = options.webhookSecret || null;

  let lastError = null;
  let lastStatusCode = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await postJson(url, payload, timeoutMs, webhookSecret);
      lastStatusCode = result.statusCode;

      if (result.statusCode >= 200 && result.statusCode < 300) {
        return {
          delivered: true,
          attempts: attempt,
          skipped: false,
          statusCode: result.statusCode,
          error: null,
        };
      }

      lastError = `CLIENT_WEBHOOK_HTTP_${result.statusCode}`;
    } catch (error) {
      lastError = error.message || 'CLIENT_WEBHOOK_REQUEST_FAILED';
    }
  }

  return {
    delivered: false,
    attempts: maxAttempts,
    skipped: false,
    statusCode: lastStatusCode,
    error: lastError,
  };
}

async function postJson(url, payload, timeoutMs, webhookSecret) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (webhookSecret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto
      .createHmac('sha256', webhookSecret)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    // These names and the signing input are part of the V1 partner-facing contract.
    headers['X-WC-Timestamp'] = timestamp;
    headers['X-WC-Signature'] = signature;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    return { statusCode: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

function buildPartnerWebhookPayload(notificationType, payment, body = {}, partner = {}) {
  const normalizedPayment = normalizePayment(payment);
  const status = resolvePublicStatus(notificationType, body);
  const base = {
    schemaVersion: 1,
    eventId: buildPartnerWebhookEventId(normalizedPayment, status),
    eventType: publicEventType(status),
    paymentId: normalizedPayment.id,
    orderId: normalizedPayment.partner_order_id || null,
    paymentType: normalizePaymentType(normalizedPayment.payment_type || (normalizedPayment.qrc_type ? 'SBP' : null)),
    qrcId: normalizedPayment.qrc_id || body.qrcId || null,
    qrcType: body.qrcType || normalizedPayment.qrc_type || null,
    currency: normalizeCurrencyCode(body.cur || 'RUB'),
    accountCurrency: normalizedPayment.account_currency || 'RUB',
    amountCurrencyMinor: normalizedPayment.amount_currency_minor || null,
    effectiveCurrencyRateRub: normalizedPayment.effective_currency_rate_rub || null,
    occurredAt: resolveOccurredAt(notificationType, normalizedPayment, body),
  };

  if (partner.forward_payer_data) {
    base.sndPam = body.sndPam || normalizedPayment.bank_snd_pam || null;
    base.sndPhoneMasked = body.sndPhoneMasked || normalizedPayment.bank_snd_phone_masked || null;
  }

  if (notificationType === 'c2b_payment') {
    return {
      ...base,
      status,
      amount: normalizeAmount(body.amount, normalizedPayment.amount),
      createdAt: null,
      paidAt: parseIsoDateOrNull(body.trxTime) || new Date().toISOString(),
      trxId: body.trxId || normalizedPayment.bank_c2b_trx_id || null,
    };
  }

  if (notificationType === 'payment_failed') {
    return {
      ...base,
      status,
      amount: normalizeAmount(body.amount, normalizedPayment.amount),
      createdAt: null,
      paidAt: null,
      trxId: body.trxId || normalizedPayment.bank_c2b_trx_id || null,
      failureInfo: body.infoMsg || body.errorMessage || null,
    };
  }

  if (notificationType === 'subscription') {
    return {
      ...base,
      status,
      amount: normalizeAmount(body.amount, normalizedPayment.amount),
      subscriptionToken: body.subscriptionToken || null,
      subscriptionMemberId: body.memberId || null,
    };
  }

  if (notificationType === 'b2c_refund') {
    return {
      ...base,
      status,
      amount: normalizeAmount(body.amount, normalizedPayment.refund_amount || normalizedPayment.amount),
      refundRefId: normalizedPayment.refund_ref_id || null,
      refundedAt: status === 'refund_confirmed' ? base.occurredAt : null,
      refundInfo: body.infoMsg || null,
    };
  }

  if (notificationType === 'b2c_transfer') {
    return {
      ...base,
      status,
      amount: normalizeAmount(body.amount, normalizedPayment.amount),
    };
  }

  if (notificationType === 'payment_expired') {
    return {
      ...base,
      status,
      amount: normalizeAmount(body.amount, normalizedPayment.amount),
      expiredAt: base.occurredAt,
    };
  }

  return { ...base, status };
}

function normalizePayment(payment = {}) {
  const metadata = payment.metadata && typeof payment.metadata === 'object' ? payment.metadata : {};
  return {
    ...metadata,
    ...payment,
    amount: payment.amount_minor ?? metadata.amount ?? 0,
    account_currency: payment.account_currency || metadata.account_currency || 'RUB',
    amount_currency_minor: payment.amount_currency_minor ?? metadata.amount_currency_minor ?? payment.amount_minor ?? null,
    effective_currency_rate_rub: payment.effective_currency_rate_rub_snapshot ?? metadata.effective_currency_rate_rub ?? payment.currency_rate_rub_snapshot ?? null,
    bank_c2b_trx_id: metadata.bank_c2b_trx_id ?? payment.provider_payment_id ?? null,
    bank_snd_pam: metadata.bank_snd_pam ?? null,
    bank_snd_phone_masked: metadata.bank_snd_phone_masked ?? null,
    refund_amount: metadata.refund_amount ?? null,
    refund_ref_id: metadata.refund_ref_id ?? null,
    bank_webhook_received_at: metadata.bank_webhook_received_at ?? null,
  };
}

function resolvePublicStatus(notificationType, body = {}) {
  if (notificationType === 'c2b_payment') return 'success';
  if (notificationType === 'payment_failed') return 'failed';
  if (notificationType === 'payment_expired') return 'expired';
  if (notificationType === 'subscription') return normalizeSubscriptionNotificationStatus(body);
  if (notificationType === 'b2c_refund') return normalizeRefundNotificationStatus(body.status);
  if (notificationType === 'b2c_transfer') {
    return String(body.status || '').toUpperCase() === 'CONFIRMED' ? 'transfer_confirmed' : 'transfer_refused';
  }
  return 'unknown';
}

function publicEventType(status) {
  return ({
    success: 'payment.succeeded',
    failed: 'payment.failed',
    expired: 'payment.expired',
    refund_confirmed: 'refund.succeeded',
    refund_refused: 'refund.refused',
    refund_failed: 'refund.failed',
    subscription_confirmed: 'subscription.succeeded',
    subscription_rejected: 'subscription.rejected',
    subscription_failed: 'subscription.failed',
    transfer_confirmed: 'recurring_payment.succeeded',
    transfer_refused: 'recurring_payment.refused',
  })[status] || 'payment.unknown';
}

function buildPartnerWebhookEventId(payment, status) {
  const phaseKey = String(status || '').startsWith('refund_')
    ? String(payment.refund_ref_id || '')
    : '';
  const digest = crypto
    .createHash('sha256')
    .update(`wc-partner-webhook-v1:${payment.id}:${status}:${phaseKey}`)
    .digest('hex');
  return `wc_evt_${digest.slice(0, 32)}`;
}

function resolveOccurredAt(notificationType, payment, body) {
  const candidates = notificationType === 'b2c_refund'
    ? [body.refundedAt, body.refundDate, body.trxTime]
    : notificationType === 'payment_expired'
      ? [body.expiredAt]
      : [body.trxTime, body.paymentDate, body.date];

  candidates.push(payment.bank_webhook_received_at, payment.updated_at, payment.created_at);
  for (const value of candidates) {
    const parsed = parseIsoDateOrNull(value);
    if (parsed) return parsed;
  }
  return new Date().toISOString();
}

function normalizePaymentType(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return ['SBP', 'CARD'].includes(normalized) ? normalized : null;
}

function normalizeCurrencyCode(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (['643', '810', 'RUR', 'RUB'].includes(normalized)) return 'RUB';
  if (['840', 'USD'].includes(normalized)) return 'USD';
  if (['978', 'EUR'].includes(normalized)) return 'EUR';
  return normalized || 'RUB';
}

function normalizeAmount(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback || 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback || 0;
}

function parseIsoDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function isSuccessfulSubscriptionStatus(body) {
  const code = String(body.code || '').toUpperCase();
  const status = String(body.status || '').toUpperCase();
  return code === 'RQ00000' || code === 'RS00000' || status === 'CONFIRMED' || status === 'ACSC';
}

function normalizeSubscriptionNotificationStatus(body = {}) {
  if (isSuccessfulSubscriptionStatus(body)) return 'subscription_confirmed';
  const code = String(body.code || '').trim().toUpperCase();
  const status = String(body.status || '').trim().toUpperCase();
  if (code === 'RQ05030' && status === 'RJCT') return 'subscription_rejected';
  return 'subscription_failed';
}

function normalizeRefundNotificationStatus(value) {
  const status = String(value || '').trim().toUpperCase();
  if (['CONFIRMED', 'COMPLETED', 'SUCCESS', 'SUCCEEDED', 'ACSC'].includes(status)) return 'refund_confirmed';
  if (['ERROR', 'FAILED', 'FAILURE'].includes(status)) return 'refund_failed';
  return 'refund_refused';
}

module.exports = {
  sendPartnerWebhook,
  buildPartnerWebhookPayload,
  normalizePayment,
  resolvePublicStatus,
  publicEventType,
  buildPartnerWebhookEventId,
  normalizeCurrencyCode,
  normalizeSubscriptionNotificationStatus,
  normalizeRefundNotificationStatus,
};
