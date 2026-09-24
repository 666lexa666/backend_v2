const crypto = require('node:crypto');
const https = require('node:https');
const { getSupabaseAdminClient } = require('./supabase');
const { findBankById } = require('./legacyBankAdapter');
const { getPartnerPayment, loadTerminalRuntime } = require('./paymentCore');

async function refundPayment({ partner, paymentId, amount = null, remitInfo = null }) {
  const db = getSupabaseAdminClient();
  const payment = await getPartnerPayment(partner.id, paymentId);
  if (!payment) {
    const error = new Error('Платеж не найден или не принадлежит этому партнеру');
    error.statusCode = 404;
    error.code = 'PAYMENT_NOT_FOUND';
    throw error;
  }

  const provider = payment.payment_provider_data || {};
  const refunds = Array.isArray(payment.payment_refunds) ? payment.payment_refunds : [];
  const requestedAmount = Number(payment.amount_minor);

  const validation = validatePaymentForRefund(payment, provider, amount);
  if (validation.length) {
    const error = new Error('Возврат по этому платежу невозможен');
    error.statusCode = 400;
    error.code = 'REFUND_NOT_ALLOWED';
    error.details = validation;
    throw error;
  }

  const existing = refunds.find((row) => ['requested','processing','confirmed'].includes(String(row.status || '').toLowerCase()));
  if (existing) {
    return {
      existing: true,
      payment,
      refund: existing,
      response: {
        success: true,
        paymentId: payment.id,
        status: existing.status,
        refundRefId: existing.provider_ref_id || null,
        internalTxId: existing.metadata?.internalTxId || null,
        amount: Number(existing.amount_minor || requestedAmount),
        message: 'Запрос на возврат уже был принят ранее',
      },
    };
  }

  const runtime = payment.partner_terminal_id
    ? await loadTerminalRuntime({ id: payment.partner_terminal_id })
    : null;
  const bank = await findBankById(payment.bank_id || runtime?.bankId || partner.bank_id);
  if (!bank) {
    const error = new Error('У партнера не назначен банк для проведения возврата');
    error.statusCode = 500;
    error.code = 'INTERNAL_ERROR';
    throw error;
  }

  const refundId = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  const refId = `rf-${crypto.randomUUID().replace(/-/g,'')}`;
  const internalTxId = crypto.randomUUID().replace(/-/g,'');
  const refData = provider.provider_trx_id || payment.provider_payment_id || payment.qrc_id || provider.provider_qrc_id || null;
  const bankRequest = {
    longWait: false,
    internalTxId,
    refId,
    refType: (provider.provider_trx_id || payment.provider_payment_id) ? 'trxId' : 'qrcId',
    refData,
    amount: requestedAmount,
  };
  if (remitInfo) bankRequest.remitInfo = remitInfo;

  const { data: refund, error: insertError } = await db.from('payment_refunds').insert({
    id: refundId,
    payment_pk: payment.payment_pk,
    idempotency_key: idempotencyKey,
    amount_minor: requestedAmount,
    status: 'requested',
    provider_ref_id: refId,
    requested_at: new Date().toISOString(),
    metadata: {
      internalTxId,
      remitInfo: remitInfo || null,
      bankRequest,
    },
  }).select('*').single();
  if (insertError) throw insertError;

  let bankResponse;
  try {
    bankResponse = bank.provider_code === 'ingo'
      ? await refundIngo(bank, runtime, provider, bankRequest, payment)
      : await refundMtls(bank, bankRequest);
  } catch (error) {
    await db.from('payment_refunds').update({
      status: 'failed',
      metadata: {
        ...(refund.metadata || {}),
        providerError: {
          message: error.message,
          statusCode: error.statusCode || null,
          responseBody: error.responseBody || null,
        },
      },
      updated_at: new Date().toISOString(),
    }).eq('id', refund.id);

    const publicError = new Error('Банк отклонил запрос на возврат');
    publicError.statusCode = 502;
    publicError.code = 'BANK_REFUND_FAILED';
    publicError.paymentId = payment.id;
    publicError.refundRefId = refId;
    publicError.internalTxId = internalTxId;
    publicError.bankStatusCode = error.statusCode || null;
    throw publicError;
  }

  const httpStatus = Number(bankResponse.statusCode || 200);
  const responseBody = bankResponse.body || {};
  const status = httpStatus >= 200 && httpStatus < 300 ? 'requested' : 'failed';
  const completedAt = status === 'confirmed' ? new Date().toISOString() : null;

  await db.from('payment_refunds').update({
    status,
    provider_ref_id: responseBody.refId || refId,
    provider_trx_id: responseBody.trxId || null,
    completed_at: completedAt,
    metadata: {
      ...(refund.metadata || {}),
      internalTxId: responseBody.internalTxId || internalTxId,
      bankResponse: responseBody,
      bankStatusCode: httpStatus,
    },
    updated_at: new Date().toISOString(),
  }).eq('id', refund.id);

  await db.from('payments').update({
    status: 'refund_requested',
    updated_at: new Date().toISOString(),
  }).eq('payment_pk', payment.payment_pk);

  return {
    existing: false,
    payment,
    refund: {
      ...refund,
      status,
      provider_ref_id: responseBody.refId || refId,
      provider_trx_id: responseBody.trxId || null,
      metadata: {
        ...(refund.metadata || {}),
        internalTxId: responseBody.internalTxId || internalTxId,
      },
    },
    bankResponse: {
      statusCode: httpStatus,
      body: responseBody,
    },
  };
}

function validatePaymentForRefund(payment, provider, requestAmount) {
  const errors = [];
  const type = String(payment.payment_type || 'SBP').toUpperCase();

  if (type === 'CARD') {
    if (!provider.provider_order_id) errors.push('У карточного платежа не сохранен bank_order_id для возврата');
  } else {
    if (payment.qrc_type !== '02') errors.push('Возврат разрешен только по динамическому QR qrcType=02');
    if (!payment.qrc_id && !provider.provider_trx_id && !provider.qr_payload && !provider.provider_order_id) {
      errors.push('У платежа нет qrcId, trxId, payload или bank_order_id для поиска исходного платежа в банке');
    }
  }

  if (!['success','refund_failed'].includes(String(payment.status || ''))) {
    errors.push(`Текущий статус платежа не позволяет возврат: ${payment.status}`);
  }
  if (String(payment.status || '') !== 'success') {
    errors.push('Возврат можно запрашивать только после успешной оплаты');
  }
  if (!Number.isSafeInteger(Number(payment.amount_minor)) || Number(payment.amount_minor) <= 0) {
    errors.push('Сумма возврата должна быть целым числом в копейках');
  }
  if (requestAmount !== null && requestAmount !== undefined && Number(requestAmount) !== Number(payment.amount_minor)) {
    errors.push('Поддерживается только полный возврат: amount должен быть равен сумме исходного платежа или не передаваться');
  }
  return errors;
}

async function refundMtls(bank, body) {
  if (!bank.refund_url) throw new Error('У банка не задан refund_url');
  const url = new URL(bank.refund_url);
  const payload = JSON.stringify(body);
  const pfx = Buffer.from(bank.certificate_base64 || '', 'base64');
  if (!pfx.length) throw new Error('У банка не задан certificate_base64');

  const options = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || 443,
    path: `${url.pathname}${url.search}`,
    method: 'POST',
    pfx,
    passphrase: bank.certificate_password,
    rejectUnauthorized: bank.tls_reject_unauthorized === false ? false : true,
    headers: {
      'Content-Type':'application/json',
      'Content-Length':Buffer.byteLength(payload),
      Accept:'application/json',
    },
    timeout:Number(process.env.BANK_REFUND_REQUEST_TIMEOUT_MS || 30000),
  };

  return new Promise((resolve,reject)=>{
    const req=https.request(options,(res)=>{
      const chunks=[];
      res.on('data',(chunk)=>chunks.push(chunk));
      res.on('end',()=>{
        const raw=Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed=raw?JSON.parse(raw):{}; } catch { parsed={rawBody:raw}; }
        if (res.statusCode<200 || res.statusCode>=300) {
          const error=new Error(`Bank refund API error: ${res.statusCode}`);
          error.statusCode=res.statusCode;
          error.responseBody=parsed;
          return reject(error);
        }
        resolve({statusCode:res.statusCode,body:parsed});
      });
    });
    req.on('timeout',()=>req.destroy(new Error('Bank refund API timeout')));
    req.on('error',reject);
    req.write(payload);
    req.end();
  });
}

async function refundIngo(bank, runtime, provider, body, payment) {
  const username = runtime?.providerConfig?.ingo_api_username || bank.api_username;
  const password = runtime?.providerConfig?.ingo_api_password || bank.api_password;
  const base = String(bank.api_base_url || '').replace(/\/$/, '');
  const orderId = provider.provider_order_id;
  if (!base || !username || !password || !orderId) throw new Error('Не заполнены настройки Ingo для возврата');

  const form = new URLSearchParams();
  const fields = {
    userName: username,
    password,
    orderId,
    amount: Number(payment.amount_minor),
    language: 'ru',
    currency: '643',
    externalRefundId: String(body.refId).slice(0,36),
  };
  for (const [key,value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== '') form.append(key,String(value));
  }

  const response = await fetch(`${base}/rest/refund.do`, {
    method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},
    body:form.toString(),
    signal:AbortSignal.timeout(Number(process.env.BANK_REFUND_REQUEST_TIMEOUT_MS || 30000)),
  });
  const raw=await response.text();
  let parsed;
  try { parsed=raw?JSON.parse(raw):{}; } catch { parsed={rawBody:raw}; }
  if (!response.ok || (parsed.errorCode != null && String(parsed.errorCode)!=='0')) {
    const error=new Error('Возврат Ingo отклонён');
    error.statusCode=response.status;
    error.responseBody=parsed;
    throw error;
  }
  return {statusCode:200,body:{...parsed,amount:Number(payment.amount_minor)}};
}

module.exports = { refundPayment };
