const crypto = require('node:crypto');
const { getSupabaseAdminClient } = require('./supabase');

async function selectTerminalForPayment({ partnerId, projectId = null, terminalId = null, method = 'SBP', amountMinor }) {
  const db = getSupabaseAdminClient();
  let query = db.from('partner_routable_terminals_v2')
    .select('*')
    .eq('partner_id', partnerId)
    .eq('payment_method', String(method).toUpperCase());

  if (projectId) query = query.eq('project_id', projectId);

  const { data, error } = await query
    .order('is_default', { ascending: false })
    .order('assigned_at', { ascending: true });
  if (error) throw error;

  const rows = data || [];
  let terminal = null;

  if (terminalId) {
    terminal = rows.find((row) => row.id === terminalId || row.terminal_id === terminalId) || null;
  } else {
    const eligible = rows.filter((row) => {
      const min = row.effective_min_amount_minor == null ? null : Number(row.effective_min_amount_minor);
      const max = row.effective_max_amount_minor == null ? null : Number(row.effective_max_amount_minor);
      const amount = Number(amountMinor);
      return (min == null || amount >= min) && (max == null || amount <= max);
    });

    terminal = eligible.find((row) => row.is_default) || eligible[0] || null;
  }

  return terminal;
}

async function loadTerminalRuntime(assignment) {
  if (!assignment) return null;
  const db = getSupabaseAdminClient();
  const { data: link, error: linkError } = await db
    .from('partner_terminals')
    .select('id,partner_id,project_id,terminal_id,provider_config,settings,min_amount_minor,max_amount_minor,is_active')
    .eq('id', assignment.id)
    .maybeSingle();
  if (linkError) throw linkError;
  if (!link) return null;

  const { data: terminal, error: terminalError } = await db
    .from('terminals')
    .select('*')
    .eq('id', link.terminal_id)
    .maybeSingle();
  if (terminalError) throw terminalError;
  if (!terminal) return null;

  const provider = {
    ...(terminal.provider_config || {}),
    ...(link.provider_config || {}),
  };
  const settings = {
    ...(terminal.settings || {}),
    ...(link.settings || {}),
  };

  return {
    assignmentId: link.id,
    partnerId: link.partner_id,
    projectId: link.project_id,
    terminalId: link.terminal_id,
    bankId: terminal.bank_id,
    paymentMethod: terminal.payment_method,
    companyName: terminal.company_name || assignment.company_name || null,
    label: link.label || assignment.label || null,
    merchantId: provider.merchant_id ?? terminal.merchant_id ?? null,
    extEntityId: provider.ext_entity_id ?? terminal.ext_entity_id ?? null,
    account: provider.account ?? terminal.account ?? null,
    accAlias: provider.acc_alias ?? terminal.acc_alias ?? null,
    supportsRecurrentPayments: Boolean(terminal.supports_recurrent_payments),
    providerConfig: provider,
    settings,
    minAmountMinor: assignment.effective_min_amount_minor ?? null,
    maxAmountMinor: assignment.effective_max_amount_minor ?? null,
  };
}

async function createPaymentCore(input) {
  const db = getSupabaseAdminClient();
  const partnerId = Number(input.partnerId);
  const amountMinor = Number(input.amountMinor);

  if (!Number.isSafeInteger(partnerId) || partnerId <= 0) {
    throw apiError(400, 'VALIDATION_ERROR', 'partnerId некорректен');
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw apiError(400, 'VALIDATION_ERROR', 'amount должен быть положительным целым числом в копейках');
  }

  const method = String(input.method || 'SBP').toUpperCase();
  if (!['SBP', 'CARD'].includes(method)) {
    throw apiError(400, 'VALIDATION_ERROR', 'method должен быть SBP или CARD');
  }

  const assignment = await selectTerminalForPayment({
    partnerId,
    projectId: input.projectId || null,
    terminalId: input.terminalId || null,
    method,
    amountMinor,
  });

  if (!assignment) {
    throw apiError(400, 'TERMINAL_NOT_AVAILABLE', 'Подходящий активный терминал не найден');
  }

  const runtime = await loadTerminalRuntime(assignment);
  if (!runtime) {
    throw apiError(409, 'TERMINAL_RUNTIME_NOT_FOUND', 'Конфигурация терминала недоступна');
  }

  const requestId = crypto.randomUUID();
  const metadata = {
    apiVersion: input.apiVersion || 'v2',
    paymentPurpose: input.paymentPurpose || null,
    clientWebhookUrl: input.webhookUrl || null,
    redirectUrl: input.redirectUrl || null,
    qrcType: input.qrcType || null,
    subscriptionPurpose: input.subscriptionPurpose || null,
    subscriptionServiceId: input.subscriptionServiceId || null,
    subscriptionServiceName: input.subscriptionServiceName || null,
    clientPhone: input.clientPhone || null,
    clientPam: input.clientPam || null,
    legacy: input.legacy || null,
  };

  const { data: payment, error } = await db.from('payments').insert({
    id: crypto.randomUUID(),
    request_id: requestId,
    partner_id: partnerId,
    project_id: runtime.projectId || input.projectId || null,
    partner_terminal_id: runtime.assignmentId,
    bank_id: runtime.bankId,
    payment_type: method,
    qrc_type: input.qrcType || null,
    partner_order_id: input.orderId || null,
    amount_minor: amountMinor,
    currency: String(input.currency || 'RUB').toUpperCase(),
    status: 'created',
    commission_percent_snapshot: input.commissionPercent ?? null,
    currency_rate_rub_snapshot: input.currencyRateRub ?? null,
    metadata,
  }).select('*').single();

  if (error) throw error;

  const snapshot = {
    assignmentId: runtime.assignmentId,
    terminalId: runtime.terminalId,
    bankId: runtime.bankId,
    companyName: runtime.companyName,
    label: runtime.label,
    merchantId: runtime.merchantId,
    extEntityId: runtime.extEntityId,
    account: runtime.account,
    accAlias: runtime.accAlias,
    paymentMethod: runtime.paymentMethod,
    supportsRecurrentPayments: runtime.supportsRecurrentPayments,
    providerConfig: runtime.providerConfig,
  };

  const { error: providerError } = await db.from('payment_provider_data').upsert({
    payment_pk: payment.payment_pk,
    provider_code: null,
    terminal_snapshot: snapshot,
    routing_snapshot: {
      requestedProjectId: input.projectId || null,
      requestedTerminalId: input.terminalId || null,
      selectedPartnerTerminalId: runtime.assignmentId,
    },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'payment_pk' });

  if (providerError) throw providerError;

  return { payment, runtime, requestId };
}

async function getPartnerPayment(partnerId, paymentId) {
  const db = getSupabaseAdminClient();
  const { data: payment, error } = await db
    .from('payments')
    .select('*,payment_provider_data(*),payment_refunds(*)')
    .eq('id', paymentId)
    .eq('partner_id', partnerId)
    .maybeSingle();

  if (error) throw error;
  return payment || null;
}

async function setPaymentProviderResult(paymentPk, update = {}) {
  const db = getSupabaseAdminClient();
  const providerUpdate = {
    provider_code: update.providerCode ?? null,
    provider_order_id: update.providerOrderId ?? null,
    provider_qrc_id: update.qrcId ?? null,
    provider_binding_id: update.providerBindingId ?? null,
    provider_trx_id: update.providerTrxId ?? null,
    provider_trx_time: update.providerTrxTime ?? null,
    qr_payload: update.qrPayload ?? null,
    subscription_token: update.subscriptionToken ?? null,
    subscription_member_id: update.subscriptionMemberId ?? null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await db.from('payment_provider_data').update(providerUpdate).eq('payment_pk', paymentPk);
  if (error) throw error;

  const paymentUpdate = {};
  if (update.status) paymentUpdate.status = update.status;
  if (update.qrcId !== undefined) paymentUpdate.qrc_id = update.qrcId;
  if (update.providerPaymentId !== undefined) paymentUpdate.provider_payment_id = update.providerPaymentId;
  if (update.paidAt !== undefined) paymentUpdate.paid_at = update.paidAt;
  if (update.expiresAt !== undefined) paymentUpdate.expires_at = update.expiresAt;
  if (Object.keys(paymentUpdate).length) {
    paymentUpdate.updated_at = new Date().toISOString();
    const { error: paymentError } = await db.from('payments').update(paymentUpdate).eq('payment_pk', paymentPk);
    if (paymentError) throw paymentError;
  }
}

function apiError(statusCode, code, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details) error.details = details;
  return error;
}

module.exports = {
  createPaymentCore,
  getPartnerPayment,
  setPaymentProviderResult,
  selectTerminalForPayment,
  loadTerminalRuntime,
  apiError,
};
