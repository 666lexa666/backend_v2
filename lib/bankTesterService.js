const crypto = require('node:crypto');
const https = require('node:https');
const { getSupabaseAdminClient } = require('./supabase');
const { findBankById } = require('./legacyBankAdapter');
const { executeQrPayment } = require('./providerQr');

async function listTesterTerminals() {
  const db = getSupabaseAdminClient();
  const { data, error } = await db.from('admin_terminal_catalog_v2').select('*').order('company_name').order('name');
  if (error) throw error;

  const bankIds = [...new Set((data || []).map((row) => row.bank_id).filter(Boolean))];
  const banks = new Map();
  await Promise.all(bankIds.map(async (id) => banks.set(Number(id), await findBankById(id, db))));

  return (data || []).map((row) => {
    const bank = banks.get(Number(row.bank_id));
    const cfg = row.provider_config || {};
    const available = testerAvailability(row, bank);
    return {
      id: row.id,
      catalog_terminal_id: row.id,
      label: row.name,
      company_name: row.company_name || row.name,
      bank_id: row.bank_id,
      bank_name: row.bank_name,
      provider_code: row.provider_code,
      bank: bank ? {
        id: bank.id,
        name: bank.name,
        code: bank.code,
        provider_code: bank.provider_code,
      } : null,
      payment_method: row.payment_method,
      merchant_id: row.merchant_id,
      ext_entity_id: row.ext_entity_id,
      ingo_tsp_merchant_id: cfg.ingo_tsp_merchant_id || null,
      ingo_merchant_login: cfg.ingo_merchant_login || null,
      tester_available: available.ok,
      tester_unavailable_reason: available.reason,
      supports_recurrent_payments: Boolean(row.supports_recurrent_payments),
      is_active: row.is_active !== false && !row.archived_at,
    };
  });
}

async function listTesterOperations({ page = 1, pageSize = 25, terminalId = null }) {
  const db = getSupabaseAdminClient();
  const safePage = Math.max(1, Number(page) || 1);
  const safeSize = Math.min(100, Math.max(1, Number(pageSize) || 25));
  const from = (safePage - 1) * safeSize;

  let query = db.from('admin_bank_tester_operations').select('*')
    .order('created_at', { ascending: false })
    .range(from, from + safeSize);
  if (terminalId) query = query.contains('metadata', { catalog_terminal_id: String(terminalId) });

  const { data, error } = await query;
  if (error) throw error;
  const rows = data || [];

  const paymentPks = [...new Set(rows.map((row) => row.payment_pk).filter(Boolean))];
  let paymentMap = new Map();
  if (paymentPks.length) {
    const { data: payments, error: paymentError } = await db.from('payments').select('payment_pk,id').in('payment_pk', paymentPks);
    if (paymentError) throw paymentError;
    paymentMap = new Map((payments || []).map((row) => [Number(row.payment_pk), row.id]));
  }

  return {
    operations: rows.slice(0, safeSize).map((row) => publicOperation(row, paymentMap.get(Number(row.payment_pk)))),
    hasNext: rows.length > safeSize,
    page: safePage,
    pageSize: safeSize,
  };
}

async function runTesterOperation({ adminId, terminalId, body }) {
  const db = getSupabaseAdminClient();
  const terminal = await loadCatalogTerminal(terminalId);
  const bank = await findBankById(terminal.bank_id, db);
  if (!bank) throw apiError(404, 'BANK_NOT_FOUND', 'Банк терминала не найден');

  const operation = String(body?.operation || '').trim();
  const allowed = ['dynamic_qr','subscription_qr','subscription_charge','refund','payment_status','refund_status'];
  if (!allowed.includes(operation)) throw apiError(400, 'VALIDATION_ERROR', 'Неизвестная операция банковского тестера');

  const realPayment = await findRealPayment(body || {});
  const amount = body?.amount == null || body.amount === '' ? null : Number(body.amount);
  const opId = crypto.randomUUID();

  const baseMetadata = {
    catalog_terminal_id: terminal.id,
    ...(realPayment?.id ? { real_payment_id: realPayment.id } : {}),
    ...(body?.qrcId ? { qrc_id: String(body.qrcId) } : {}),
    ...(body?.trxId ? { trx_id: String(body.trxId) } : {}),
    ...(body?.bankOrderId ? { bank_order_id: String(body.bankOrderId) } : {}),
    ...(body?.internalTxId ? { refund_internal_tx_id: String(body.internalTxId) } : {}),
  };

  const { data: created, error: createError } = await db.from('admin_bank_tester_operations').insert({
    id: opId,
    operation,
    status: 'created',
    bank_id: terminal.bank_id,
    admin_id: adminId || null,
    partner_id: realPayment?.partner_id || null,
    project_id: realPayment?.project_id || null,
    partner_terminal_id: realPayment?.partner_terminal_id || null,
    payment_pk: realPayment?.payment_pk || null,
    amount_minor: Number.isSafeInteger(amount) ? amount : (realPayment?.amount_minor || null),
    payment_purpose: body?.paymentPurpose || null,
    request_body: sanitizeTesterRequest(body || {}),
    steps: [],
    metadata: baseMetadata,
  }).select('*').single();
  if (createError) throw createError;

  const steps = [];
  try {
    const result = await executeOperation({ operation, terminal, bank, body: body || {}, realPayment, opId, steps });
    const metadata = { ...baseMetadata, ...(result.metadata || {}) };
    const { data: updated, error } = await db.from('admin_bank_tester_operations').update({
      status: result.status || 'success',
      response_body: result.response || {},
      steps,
      error_message: null,
      metadata,
      updated_at: new Date().toISOString(),
    }).eq('id', opId).select('*').single();
    if (error) throw error;

    return publicOperation(updated, realPayment?.id || null);
  } catch (error) {
    steps.push({ name: 'error', ok: false, error: serializeError(error) });
    const status = error.testerStatus || inferFailureStatus(operation);
    const response = serializeError(error);
    const metadata = { ...baseMetadata, ...(error.metadata || {}) };
    const { data: failed, error: updateError } = await db.from('admin_bank_tester_operations').update({
      status,
      response_body: response,
      steps,
      error_message: error.message || String(error),
      metadata,
      updated_at: new Date().toISOString(),
    }).eq('id', opId).select('*').single();
    if (updateError) throw updateError;
    return publicOperation(failed, realPayment?.id || null);
  }
}

async function executeOperation(ctx) {
  switch (ctx.operation) {
    case 'dynamic_qr': return testQr(ctx, '02');
    case 'subscription_qr': return testQr(ctx, '03');
    case 'subscription_charge': return testSubscriptionCharge(ctx);
    case 'payment_status': return testPaymentStatus(ctx);
    case 'refund': return testRefund(ctx);
    case 'refund_status': return testRefundStatus(ctx);
    default: throw apiError(400, 'VALIDATION_ERROR', 'Неизвестная операция');
  }
}

async function testQr({ terminal, bank, body, opId, steps }) {
  if (String(terminal.payment_method).toUpperCase() !== 'SBP') throw apiError(400, 'TERMINAL_PAYMENT_METHOD_MISMATCH', 'Для QR нужен SBP-терминал');
  const qrcType = body.operation === 'subscription_qr' ? '03' : '02';
  const amount = body.amount == null ? 0 : Number(body.amount);
  if (qrcType === '02' && (!Number.isSafeInteger(amount) || amount <= 0)) throw apiError(400, 'VALIDATION_ERROR', 'amount обязателен для динамического QR');

  const input = {
    amountMinor: Number.isSafeInteger(amount) ? amount : 0,
    qrcType,
    paymentPurpose: String(body.paymentPurpose || 'Bank tester').slice(0, 140),
    redirectUrl: body.redirectUrl || null,
    subscriptionPurpose: body.subscriptionPurpose || null,
    subscriptionServiceId: body.subscriptionServiceId || null,
    subscriptionServiceName: body.subscriptionServiceName || null,
    expDt: 15,
    localExpDt: 900,
  };
  const runtime = catalogRuntime(terminal, bank);
  const response = await executeQrPayment({
    payment: { id: opId, partner_id: 0 },
    runtime,
    input,
  });
  steps.push({ name: 'create_qr', ok: true, response: safeProviderBody(response) });
  return {
    status: 'success',
    response: safeProviderBody(response),
    metadata: {
      qrc_id: response.qrcId || null,
      qr_payload: response.payload || null,
      bank_order_id: response.bankOrderId || null,
    },
  };
}

async function testSubscriptionCharge({ terminal, bank, body, opId, steps }) {
  const amount = Number(body.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw apiError(400, 'VALIDATION_ERROR', 'amount обязателен');
  const runtime = catalogRuntime(terminal, bank);

  if (bank.provider_code === 'ingo') {
    const bindingId = String(body.bindingId || '').trim();
    if (!bindingId) throw apiError(400, 'VALIDATION_ERROR', 'bindingId обязателен для Ingo');
    const response = await ingoJson(bank, runtime.providerConfig, '/recurrentPayment.do', {
      userName: runtime.providerConfig.ingo_api_username,
      password: runtime.providerConfig.ingo_api_password,
      orderNumber: ('tester-' + opId).slice(0, 36),
      language: 'RU',
      bindingId,
      amount,
      currency: '643',
      description: String(body.paymentPurpose || 'Bank tester subscription').slice(0, 140),
      additionalParameters: { clientId: 'bank-tester' },
    });
    steps.push({ name: 'subscription_charge', ok: true, response: safeProviderBody(response) });
    return { status: 'success', response: safeProviderBody(response), metadata: { bank_order_id: response.mdOrder || response.orderId || null } };
  }

  const subscriptionQrcId = String(body.subscriptionQrcId || '').trim();
  if (!subscriptionQrcId) throw apiError(400, 'VALIDATION_ERROR', 'subscriptionQrcId обязателен');
  if (!bank.sbp_subscription_pay_url) throw apiError(400, 'BANK_CONFIG_ERROR', 'У банка не настроен subscription endpoint');

  const qr = await executeQrPayment({
    payment: { id: opId, partner_id: 0 },
    runtime,
    input: {
      amountMinor: amount,
      qrcType: '02',
      paymentPurpose: String(body.paymentPurpose || 'Bank tester subscription').slice(0, 140),
      redirectUrl: body.redirectUrl || null,
      expDt: 15,
      localExpDt: 900,
    },
  });
  steps.push({ name: 'create_pay_qr', ok: true, response: safeProviderBody(qr) });

  const response = await mtlsJson(bank, bank.sbp_subscription_pay_url, 'POST', {
    subscriptionQrcId,
    payQrcId: qr.qrcId,
    amount,
    paymentPurpose: String(body.paymentPurpose || 'Bank tester subscription').slice(0, 140),
  });
  steps.push({ name: 'subscription_charge', ok: true, response: response.body, statusCode: response.statusCode });
  return {
    status: 'success',
    response: response.body,
    metadata: { qrc_id: qr.qrcId || null, qr_payload: qr.payload || null },
  };
}

async function testPaymentStatus({ terminal, bank, body, realPayment, steps }) {
  const ids = paymentIdentifiers(realPayment, body);
  let response;

  if (bank.provider_code === 'ingo') {
    if (!ids.bankOrderId) throw apiError(400, 'VALIDATION_ERROR', 'bankOrderId или realPaymentId обязателен для Ingo');
    response = await ingoForm(bank, terminal.provider_config || {}, '/rest/getOrderStatusExtended.do', {
      orderId: ids.bankOrderId,
      language: 'ru',
    });
  } else {
    if (!ids.qrcId) throw apiError(400, 'VALIDATION_ERROR', 'qrcId или realPaymentId обязателен');
    if (!bank.qr_status_url_template) throw apiError(400, 'BANK_CONFIG_ERROR', 'У банка не настроен QR status URL');
    response = (await mtlsJson(bank, renderTemplate(bank.qr_status_url_template, '{id}', ids.qrcId), 'GET')).body;
  }

  steps.push({ name: 'payment_status', ok: true, response: safeProviderBody(response) });
  if (realPayment) await syncPaymentStatus(realPayment, response, bank.provider_code);

  return {
    status: 'success',
    response: safeProviderBody(response),
    metadata: { qrc_id: ids.qrcId, trx_id: ids.trxId, bank_order_id: ids.bankOrderId },
  };
}

async function testRefund({ terminal, bank, body, realPayment, steps }) {
  const ids = paymentIdentifiers(realPayment, body);
  const amount = Number(body.amount ?? realPayment?.amount_minor);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw apiError(400, 'VALIDATION_ERROR', 'Не удалось определить сумму возврата');

  const refId = ('rf-' + crypto.randomUUID().replace(/-/g, '')).slice(0, 36);
  const internalTxId = crypto.randomUUID().replace(/-/g, '');
  let response;
  let statusCode = 200;

  if (bank.provider_code === 'ingo') {
    if (!ids.bankOrderId) throw apiError(400, 'VALIDATION_ERROR', 'bankOrderId или realPaymentId обязателен для Ingo');
    response = await ingoForm(bank, terminal.provider_config || {}, '/rest/refund.do', {
      orderId: ids.bankOrderId,
      amount,
      language: 'ru',
      currency: '643',
      externalRefundId: refId,
    });
  } else {
    const refData = ids.trxId || ids.qrcId;
    if (!refData) throw apiError(400, 'VALIDATION_ERROR', 'trxId/qrcId или realPaymentId обязателен');
    const request = {
      longWait: false,
      internalTxId,
      refId,
      refType: ids.trxId ? 'trxId' : 'qrcId',
      refData,
      amount,
      ...(body.remitInfo ? { remitInfo: String(body.remitInfo).slice(0, 140) } : {}),
    };
    const result = await mtlsJson(bank, bank.refund_url, 'POST', request);
    response = result.body;
    statusCode = result.statusCode;
  }

  steps.push({ name: 'create_refund', ok: true, response: safeProviderBody(response), statusCode });

  if (realPayment) {
    await saveRealRefund({
      payment: realPayment,
      amount,
      refId,
      internalTxId,
      providerResponse: response,
    });
  }

  return {
    status: statusCode === 202 ? 'refund_requested' : 'refund_requested',
    response: safeProviderBody(response),
    metadata: {
      qrc_id: ids.qrcId,
      trx_id: ids.trxId,
      refund_ref_id: refId,
      refund_internal_tx_id: internalTxId,
      bank_order_id: ids.bankOrderId,
    },
  };
}

async function testRefundStatus({ terminal, bank, body, realPayment, steps }) {
  const db = getSupabaseAdminClient();
  let refund = null;
  if (realPayment) {
    const { data, error } = await db.from('payment_refunds').select('*').eq('payment_pk', realPayment.payment_pk)
      .order('requested_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    refund = data;
  }

  const internalTxId = String(body.internalTxId || refund?.metadata?.internalTxId || '').trim();
  let response;

  if (bank.provider_code === 'ingo') {
    const ids = paymentIdentifiers(realPayment, body);
    const amount = Number(refund?.amount_minor || body.amount || realPayment?.amount_minor);
    const externalRefundId = String(refund?.provider_ref_id || '').slice(0, 36);
    if (!ids.bankOrderId || !externalRefundId || !amount) throw apiError(400, 'VALIDATION_ERROR', 'Для Ingo нужен реальный платеж с сохраненным возвратом');
    response = await ingoForm(bank, terminal.provider_config || {}, '/rest/refund.do', {
      orderId: ids.bankOrderId,
      amount,
      language: 'ru',
      currency: '643',
      externalRefundId,
    });
  } else {
    if (!internalTxId) throw apiError(400, 'VALIDATION_ERROR', 'internalTxId обязателен');
    if (!bank.refund_status_url_template) throw apiError(400, 'BANK_CONFIG_ERROR', 'У банка не настроен refund status URL');
    response = (await mtlsJson(bank, renderTemplate(bank.refund_status_url_template, '{internalTxId}', internalTxId), 'GET')).body;
  }

  steps.push({ name: 'refund_status', ok: true, response: safeProviderBody(response) });
  if (refund) await syncRefundStatus(refund, response);

  return {
    status: 'success',
    response: safeProviderBody(response),
    metadata: {
      refund_ref_id: refund?.provider_ref_id || null,
      refund_internal_tx_id: internalTxId || refund?.metadata?.internalTxId || null,
    },
  };
}

async function loadCatalogTerminal(id) {
  const db = getSupabaseAdminClient();
  const { data, error } = await db.from('terminals').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw apiError(404, 'TERMINAL_NOT_FOUND', 'Терминал не найден');
  return data;
}

async function findRealPayment(body) {
  const db = getSupabaseAdminClient();
  if (body.realPaymentId) {
    const { data, error } = await db.from('payments').select('*,payment_provider_data(*)').eq('id', String(body.realPaymentId)).maybeSingle();
    if (error) throw error;
    return data || null;
  }
  if (body.qrcId) {
    const { data, error } = await db.from('payments').select('*,payment_provider_data(*)').eq('qrc_id', String(body.qrcId))
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    if (data) return data;
  }
  if (body.trxId || body.bankOrderId) {
    let query = db.from('payment_provider_data').select('payment_pk');
    query = body.trxId ? query.eq('provider_trx_id', String(body.trxId)) : query.eq('provider_order_id', String(body.bankOrderId));
    const { data: provider, error } = await query.limit(1).maybeSingle();
    if (error) throw error;
    if (provider?.payment_pk) {
      const { data, error: paymentError } = await db.from('payments').select('*,payment_provider_data(*)').eq('payment_pk', provider.payment_pk).maybeSingle();
      if (paymentError) throw paymentError;
      return data || null;
    }
  }
  return null;
}

function paymentIdentifiers(payment, body) {
  const provider = payment?.payment_provider_data || {};
  return {
    qrcId: String(body.qrcId || payment?.qrc_id || provider.provider_qrc_id || '').trim() || null,
    trxId: String(body.trxId || provider.provider_trx_id || payment?.provider_payment_id || '').trim() || null,
    bankOrderId: String(body.bankOrderId || provider.provider_order_id || '').trim() || null,
  };
}

async function syncPaymentStatus(payment, response, providerCode) {
  const db = getSupabaseAdminClient();
  const raw = response?.status || response?.qrStatus || response?.orderStatus || response?.order_status;
  let status = null;
  if (providerCode === 'ingo') {
    const n = Number(raw);
    if (n === 2) status = 'success';
    else if ([3,6].includes(n)) status = 'cancelled';
  } else {
    const code = String(raw || '').toUpperCase();
    if (code === 'ACWP') status = 'success';
    else if (['NTST','RJCT'].includes(code)) status = 'cancelled';
    else if (code === 'RCVD') status = 'pending';
  }
  if (!status) return;
  const update = { status, updated_at: new Date().toISOString() };
  if (status === 'success' && !payment.paid_at) update.paid_at = new Date().toISOString();
  const { error } = await db.from('payments').update(update).eq('payment_pk', payment.payment_pk);
  if (error) throw error;
}

async function saveRealRefund({ payment, amount, refId, internalTxId, providerResponse }) {
  const db = getSupabaseAdminClient();
  const { error } = await db.from('payment_refunds').insert({
    id: crypto.randomUUID(),
    payment_pk: payment.payment_pk,
    idempotency_key: crypto.randomUUID(),
    amount_minor: amount,
    status: 'requested',
    provider_ref_id: refId,
    provider_trx_id: providerResponse?.trxId || null,
    requested_at: new Date().toISOString(),
    metadata: { internalTxId, bankResponse: safeProviderBody(providerResponse), source: 'admin_bank_tester' },
  });
  if (error) throw error;
}

async function syncRefundStatus(refund, response) {
  const db = getSupabaseAdminClient();
  const raw = String(response?.status || response?.state || '').toUpperCase();
  let status = null;
  if (['CONFIRMED','COMPLETED','SUCCESS','SUCCEEDED','ACSC'].includes(raw)) status = 'confirmed';
  else if (['REFUSED','REJECTED','RJCT'].includes(raw)) status = 'refused';
  else if (['ERROR','FAILED','FAILURE'].includes(raw)) status = 'failed';
  if (!status) return;
  const { error } = await db.from('payment_refunds').update({
    status,
    completed_at: status === 'confirmed' ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
    metadata: { ...(refund.metadata || {}), testerStatusResponse: safeProviderBody(response) },
  }).eq('id', refund.id);
  if (error) throw error;
}

function catalogRuntime(terminal, bank) {
  return {
    assignmentId: null,
    terminalId: terminal.id,
    bankId: terminal.bank_id,
    providerCode: bank.provider_code,
    paymentMethod: terminal.payment_method,
    companyName: terminal.company_name,
    merchantId: terminal.merchant_id,
    extEntityId: terminal.ext_entity_id,
    account: terminal.account,
    accAlias: terminal.acc_alias,
    providerConfig: terminal.provider_config || {},
    settings: terminal.settings || {},
  };
}

function testerAvailability(terminal, bank) {
  if (!terminal || terminal.archived_at || terminal.is_active === false) return { ok: false, reason: 'Терминал выключен или в архиве' };
  if (!bank || bank.is_active === false) return { ok: false, reason: 'Банк выключен или не найден' };
  if (bank.provider_code === 'ingo') {
    const cfg = terminal.provider_config || {};
    if (!bank.api_base_url || !cfg.ingo_api_username || !cfg.ingo_api_password || !cfg.ingo_merchant_login) {
      return { ok: false, reason: 'Не заполнены настройки Ingo' };
    }
    if (String(terminal.payment_method).toUpperCase() === 'SBP' && !cfg.ingo_tsp_merchant_id) {
      return { ok: false, reason: 'Не задан ingo_tsp_merchant_id' };
    }
    return { ok: true, reason: null };
  }
  if (!bank.certificate_base64) return { ok: false, reason: 'Не загружен сертификат банка' };
  if (!bank.qr_register_url || !terminal.merchant_id || !terminal.ext_entity_id || (!terminal.account && !terminal.acc_alias)) {
    return { ok: false, reason: 'Терминал настроен не полностью' };
  }
  return { ok: true, reason: null };
}

async function mtlsJson(bank, endpoint, method, body = null) {
  if (!endpoint) throw apiError(400, 'BANK_CONFIG_ERROR', 'Endpoint банка не настроен');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') throw apiError(400, 'BANK_CONFIG_ERROR', 'Bank URL должен использовать HTTPS');
  const payload = body == null ? null : JSON.stringify(body);
  const options = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || 443,
    path: `${url.pathname}${url.search}`,
    method,
    pfx: Buffer.from(bank.certificate_base64 || '', 'base64'),
    passphrase: bank.certificate_password || '',
    rejectUnauthorized: bank.tls_reject_unauthorized !== false,
    headers: { Accept: 'application/json', ...(payload ? { 'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload) } : {}) },
    timeout: Number(process.env.BANK_TESTER_TIMEOUT_MS || 30000),
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed; try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { rawBody: raw }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`Bank API error: ${res.statusCode}`);
          error.statusCode = res.statusCode;
          error.responseBody = parsed;
          return reject(error);
        }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Bank tester timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function ingoForm(bank, terminalConfig, endpoint, fields) {
  const base = String(bank.api_base_url || '').replace(/\/$/, '');
  const userName = terminalConfig.ingo_api_username || bank.api_username;
  const password = terminalConfig.ingo_api_password || bank.api_password;
  if (!base || !userName || !password) throw apiError(400, 'BANK_CONFIG_ERROR', 'Не заполнены Ingo credentials');
  const form = new URLSearchParams({ userName: String(userName), password: String(password) });
  for (const [key, value] of Object.entries(fields || {})) if (value !== undefined && value !== null && value !== '') form.append(key, String(value));
  const response = await fetch(base + endpoint, {
    method: 'POST',
    headers: { 'content-type':'application/x-www-form-urlencoded', accept:'application/json' },
    body: form.toString(),
    signal: AbortSignal.timeout(Number(process.env.BANK_TESTER_TIMEOUT_MS || 30000)),
  });
  const raw = await response.text();
  let parsed; try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { rawBody: raw }; }
  if (!response.ok || (parsed.errorCode != null && String(parsed.errorCode) !== '0')) {
    const error = new Error('Ingo request failed');
    error.statusCode = response.status;
    error.responseBody = parsed;
    throw error;
  }
  return parsed;
}

async function ingoJson(bank, terminalConfig, endpoint, payload) {
  const base = String(bank.api_base_url || '').replace(/\/$/, '');
  if (!base) throw apiError(400, 'BANK_CONFIG_ERROR', 'Не задан api_base_url Ingo');
  const response = await fetch(base + endpoint, {
    method: 'POST',
    headers: { 'content-type':'application/json', accept:'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Number(process.env.BANK_TESTER_TIMEOUT_MS || 30000)),
  });
  const raw = await response.text();
  let parsed; try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { rawBody: raw }; }
  if (!response.ok || parsed?.success === false) {
    const error = new Error('Ingo recurrent payment failed');
    error.statusCode = response.status;
    error.responseBody = parsed;
    throw error;
  }
  return parsed;
}

function renderTemplate(template, token, value) {
  const raw = String(template || '');
  return raw.includes(token) ? raw.replaceAll(token, encodeURIComponent(String(value))) : raw.replace(/\/$/, '') + '/' + encodeURIComponent(String(value));
}

function publicOperation(row, realPaymentId = null) {
  const metadata = row.metadata || {};
  return {
    ...row,
    amount: row.amount_minor == null ? null : Number(row.amount_minor),
    qrc_id: metadata.qrc_id || null,
    qr_payload: metadata.qr_payload || null,
    trx_id: metadata.trx_id || null,
    refund_ref_id: metadata.refund_ref_id || null,
    refund_internal_tx_id: metadata.refund_internal_tx_id || null,
    real_payment_id: realPaymentId || metadata.real_payment_id || metadata.legacy_real_payment_id || null,
    catalog_terminal_id: metadata.catalog_terminal_id || null,
  };
}

function sanitizeTesterRequest(body) {
  const copy = { ...(body || {}) };
  delete copy.card;
  return copy;
}

function safeProviderBody(value) {
  if (!value || typeof value !== 'object') return value;
  const clone = JSON.parse(JSON.stringify(value));
  redact(clone);
  return clone;
}

function redact(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    if (/password|certificate|secret|token$/i.test(key) && !/subscriptionToken/i.test(key)) obj[key] = '[REDACTED]';
    else if (obj[key] && typeof obj[key] === 'object') redact(obj[key]);
  }
}

function serializeError(error) {
  return {
    message: error?.message || String(error),
    code: error?.code || null,
    statusCode: error?.statusCode || null,
    responseBody: safeProviderBody(error?.responseBody || null),
  };
}

function inferFailureStatus(operation) {
  return operation === 'refund' ? 'refund_failed' : 'failed';
}

function apiError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

module.exports = {
  listTesterTerminals,
  listTesterOperations,
  runTesterOperation,
};
