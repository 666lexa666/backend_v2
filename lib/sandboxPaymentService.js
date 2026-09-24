const crypto = require('node:crypto');
const { getSupabaseAdminClient } = require('./supabase');
const { buildPaymentCurrencySnapshot } = require('./currencySnapshot');

function isSandboxPartner(partner) {
  return String(partner?.environment || '').toLowerCase() === 'test';
}

async function createSandboxPayment({
  partner,
  input,
  runtime = null,
  status = 'pending',
  extra = {},
}) {
  const db = getSupabaseAdminClient();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const method = String(input.method || 'SBP').toUpperCase();
  const currencySnapshot = await buildPaymentCurrencySnapshot({
    db,
    partnerId: partner.id,
    amountMinor: Number(input.amountMinor),
    accountCurrency: partner.account_currency || 'RUB',
    markupPercent: partner.currency_markup_percent || 0,
  });

  const qrcId = method === 'SBP'
    ? `SBX${id.replace(/-/g, '').slice(0, 29).toUpperCase()}`
    : null;
  const bankOrderId = method === 'CARD' ? `sandbox-${id}` : null;
  const payload = method === 'SBP'
    ? `https://sandbox.whitecapital.tech/pay/${id}`
    : null;
  const formUrl = method === 'CARD'
    ? `https://sandbox.whitecapital.tech/card/${id}`
    : null;

  const data = {
    schemaVersion: 1,
    environment: 'test',
    id,
    requestId: crypto.randomUUID(),
    partnerId: Number(partner.id),
    projectId: input.projectId || runtime?.projectId || null,
    partnerTerminalId: runtime?.assignmentId || input.terminalId || null,
    catalogTerminalId: runtime?.terminalId || null,
    bankId: runtime?.bankId || null,
    providerCode: 'sandbox',
    paymentType: method,
    qrcType: input.qrcType || null,
    partnerOrderId: input.orderId || null,
    amountMinor: Number(input.amountMinor),
    currency: 'RUB',
    accountCurrency: currencySnapshot.accountCurrency,
    amountCurrencyMinor: currencySnapshot.amountCurrencyMinor,
    currencyRateRubSnapshot: currencySnapshot.officialRateRub,
    currencyMarkupPercentSnapshot: currencySnapshot.markupPercent,
    effectiveCurrencyRateRubSnapshot: currencySnapshot.effectiveRateRub,
    commissionPercentSnapshot: Number(input.commissionPercent || 0),
    paymentPurpose: input.paymentPurpose || null,
    webhookUrl: input.webhookUrl || null,
    redirectUrl: input.redirectUrl || null,
    clientPhone: input.clientPhone || null,
    clientPam: input.clientPam || null,
    subscriptionPurpose: input.subscriptionPurpose || null,
    subscriptionServiceId: input.subscriptionServiceId || null,
    subscriptionServiceName: input.subscriptionServiceName || null,
    qrcId,
    qrPayload: payload,
    bankOrderId,
    formUrl,
    status,
    paidAt: null,
    expiresAt: method === 'SBP' && input.expDt
      ? new Date(Date.now() + Number(input.expDt) * 60_000).toISOString()
      : null,
    createdAt: now,
    updatedAt: now,
    refund: null,
    events: [{
      type: 'sandbox.payment.created',
      status,
      at: now,
    }],
    ...extra,
  };

  const { data: row, error } = await db
    .from('sandbox_payments')
    .insert({
      id,
      partner_id: Number(partner.id),
      project_id: data.projectId,
      version: 1,
      data,
      created_at: now,
      updated_at: now,
    })
    .select('*')
    .single();
  if (error) throw error;

  return normalizeSandboxRow(row);
}

async function getSandboxPayment(partnerId, paymentId) {
  const db = getSupabaseAdminClient();
  const { data, error } = await db
    .from('sandbox_payments')
    .select('*')
    .eq('id', String(paymentId))
    .eq('partner_id', Number(partnerId))
    .maybeSingle();
  if (error) throw error;
  return data ? normalizeSandboxRow(data) : null;
}

async function updateSandboxPayment(partnerId, paymentId, mutator) {
  const db = getSupabaseAdminClient();
  const current = await getSandboxPayment(partnerId, paymentId);
  if (!current) return null;

  const now = new Date().toISOString();
  const nextData = await mutator(structuredClone(current.data), current);
  nextData.updatedAt = now;
  const nextVersion = Number(current.version || 1) + 1;

  const { data, error } = await db
    .from('sandbox_payments')
    .update({
      data: nextData,
      version: nextVersion,
      updated_at: now,
    })
    .eq('id', String(paymentId))
    .eq('partner_id', Number(partnerId))
    .eq('version', Number(current.version || 1))
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const conflict = new Error('Sandbox payment was modified concurrently');
    conflict.code = 'SANDBOX_VERSION_CONFLICT';
    conflict.statusCode = 409;
    throw conflict;
  }
  return normalizeSandboxRow(data);
}

async function simulateSandboxStatus({ partnerId, paymentId, status }) {
  const allowed = new Set([
    'pending',
    'success',
    'failed',
    'expired',
    'subscription_confirmed',
    'subscription_rejected',
    'subscription_failed',
    'transfer_confirmed',
    'transfer_refused',
    'refund_confirmed',
    'refund_refused',
    'refund_failed',
  ]);
  if (!allowed.has(status)) {
    const error = new Error('Unsupported sandbox status');
    error.code = 'INVALID_SANDBOX_STATUS';
    error.statusCode = 400;
    throw error;
  }

  return updateSandboxPayment(partnerId, paymentId, (data) => {
    const now = new Date().toISOString();
    if (status.startsWith('refund_')) {
      data.refund = {
        ...(data.refund || {
          amountMinor: data.amountMinor,
          amountCurrencyMinor: data.amountCurrencyMinor,
          requestedAt: now,
        }),
        status,
        completedAt: status === 'refund_confirmed' ? now : null,
      };
    } else {
      data.status = status;
      if (status === 'success' || status === 'transfer_confirmed') data.paidAt = now;
    }
    data.events = [
      ...(Array.isArray(data.events) ? data.events : []),
      { type: 'sandbox.status.changed', status, at: now },
    ];
    return data;
  });
}

async function requestSandboxRefund({ partner, paymentId, amount = null, remitInfo = null }) {
  const current = await getSandboxPayment(partner.id, paymentId);
  if (!current) {
    const error = new Error('Платеж не найден или не принадлежит этому партнеру');
    error.code = 'PAYMENT_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }

  const data = current.data;
  const details = [];
  if (String(data.status) !== 'success') details.push('Возврат можно запрашивать только после успешной оплаты');
  if (data.refund && !['refund_failed', 'refund_refused'].includes(String(data.refund.status))) {
    details.push('Возврат по этому платежу уже запрошен');
  }
  if (amount != null && Number(amount) !== Number(data.amountMinor)) {
    details.push('Поддерживается только полный возврат исходной суммы платежа');
  }
  if (details.length) {
    const error = new Error('Возврат по этому платежу невозможен');
    error.code = 'REFUND_NOT_ALLOWED';
    error.statusCode = 400;
    error.details = details;
    throw error;
  }

  const refundRefId = crypto.randomUUID();
  const internalTxId = crypto.randomUUID().replace(/-/g, '');
  const updated = await updateSandboxPayment(partner.id, paymentId, (next) => {
    const now = new Date().toISOString();
    next.refund = {
      refundRefId,
      internalTxId,
      amountMinor: Number(next.amountMinor),
      amountCurrencyMinor: Number(next.amountCurrencyMinor),
      remitInfo: remitInfo || null,
      status: 'refund_requested',
      requestedAt: now,
      completedAt: null,
    };
    next.events = [
      ...(Array.isArray(next.events) ? next.events : []),
      { type: 'sandbox.refund.requested', status: 'refund_requested', at: now },
    ];
    return next;
  });

  return { payment: updated, refund: updated.data.refund };
}

function sandboxQrCreateResponse(row, input) {
  const p = row.data;
  return {
    success: true,
    paymentId: p.id,
    orderId: p.partnerOrderId || null,
    qrcId: p.qrcId,
    payload: p.qrPayload,
    qrcType: p.qrcType,
    regTime: p.createdAt,
    expDt: p.qrcType === '02' ? Number(input.expDt || 15) : null,
    localExpDt: p.qrcType === '02' ? Number(input.localExpDt || 900) : null,
    redirectUrl: p.redirectUrl || null,
    amount: p.amountMinor,
    accountCurrency: p.accountCurrency,
    amountCurrencyMinor: p.amountCurrencyMinor,
    effectiveCurrencyRateRub: p.effectiveCurrencyRateRubSnapshot,
    currencyMarkupPercent: p.currencyMarkupPercentSnapshot,
  };
}

function sandboxV1StatusResponse(row) {
  const p = row.data;
  const refundStatus = p.refund?.status || null;
  return {
    success: true,
    paymentId: p.id,
    orderId: p.partnerOrderId || null,
    status: refundStatus || p.status,
    qrcId: p.qrcId || null,
    qrcType: p.qrcType || null,
    paymentType: p.paymentType || null,
    paymentPurpose: p.paymentPurpose || null,
    amount: Number(p.amountMinor),
    accountCurrency: p.accountCurrency || 'RUB',
    amountCurrencyMinor: Number(p.amountCurrencyMinor),
    effectiveCurrencyRateRub: p.effectiveCurrencyRateRubSnapshot || 1,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    paidAt: p.paidAt || null,
    trxId: p.providerTransactionId || null,
    refundStatus,
    refundAmount: p.refund ? Number(p.refund.amountMinor) : null,
    refundCompletedAt: p.refund?.completedAt || null,
  };
}

function normalizeSandboxRow(row) {
  return {
    id: row.id,
    partner_id: row.partner_id,
    project_id: row.project_id,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    data: row.data || {},
  };
}

module.exports = {
  isSandboxPartner,
  createSandboxPayment,
  getSandboxPayment,
  updateSandboxPayment,
  simulateSandboxStatus,
  requestSandboxRefund,
  sandboxQrCreateResponse,
  sandboxV1StatusResponse,
};
