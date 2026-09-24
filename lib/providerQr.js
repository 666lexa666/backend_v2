const https = require('node:https');
const { findBankById } = require('./legacyBankAdapter');

async function executeQrPayment({ payment, runtime, input }) {
  const bank = await findBankById(runtime.bankId);
  if (!bank) {
    const error = new Error('Банк терминала не найден');
    error.code = 'BANK_NOT_FOUND';
    throw error;
  }

  const terminal = {
    id: runtime.assignmentId,
    ingo_api_username: runtime.providerConfig?.ingo_api_username || null,
    ingo_api_password: runtime.providerConfig?.ingo_api_password || null,
    ingo_merchant_login: runtime.providerConfig?.ingo_merchant_login || null,
    ingo_tsp_merchant_id: runtime.providerConfig?.ingo_tsp_merchant_id || null,
    ingo_account: runtime.providerConfig?.ingo_account || null,
    ingo_member_id: runtime.providerConfig?.ingo_member_id || null,
  };

  const bankRequest = buildQrBankRequest(runtime, input);

  if (bank.provider_code === 'ingo') {
    return registerIngoQr(bank, bankRequest, {
      paymentId: payment.id,
      partnerId: payment.partner_id,
      terminal,
    });
  }

  return registerMtlsQr(bank, bankRequest);
}

function buildQrBankRequest(runtime, input) {
  const body = {
    extEntityId: runtime.extEntityId,
    merchantId: runtime.merchantId,
    qrcType: String(input.qrcType || '02'),
    amount: Number(input.amountMinor),
    paymentPurpose: input.paymentPurpose,
  };

  if (runtime.account) body.account = runtime.account;
  else if (runtime.accAlias) body.accAlias = runtime.accAlias;

  if (String(body.qrcType) === '02') {
    body.expDt = Number(input.expDt || 15);
    body.localExpDt = Number(input.localExpDt || 900);
  }

  if (input.redirectUrl) body.redirectUrl = input.redirectUrl;
  if (input.subscriptionPurpose) body.subscriptionPurpose = input.subscriptionPurpose;
  if (input.subscriptionServiceId) body.subscriptionServiceId = input.subscriptionServiceId;
  if (input.subscriptionServiceName) body.subscriptionServiceName = input.subscriptionServiceName;

  return body;
}

async function registerMtlsQr(bank, requestBody) {
  if (!bank.qr_register_url) {
    throw new Error('У банка не задан qr_register_url');
  }
  if (!bank.certificate_base64) {
    throw new Error('У банка не задан certificate_base64');
  }

  const url = new URL(bank.qr_register_url);
  const payload = JSON.stringify(requestBody);
  const pfx = Buffer.from(bank.certificate_base64, 'base64');

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
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      Accept: 'application/json',
    },
    timeout: Number(process.env.BANK_QR_REQUEST_TIMEOUT_MS || 30000),
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body;
        try { body = raw ? JSON.parse(raw) : {}; } catch { body = { rawBody: raw }; }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`Bank QR API error: ${res.statusCode}`);
          error.statusCode = res.statusCode;
          error.responseBody = body;
          return reject(error);
        }
        resolve(body);
      });
    });

    req.on('timeout', () => req.destroy(new Error('Bank QR API timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function registerIngoQr(bank, requestBody, context) {
  const terminal = context.terminal || {};
  assertIngoConfigured(bank, terminal);

  const paymentId = String(context.paymentId || '').trim();
  const orderNumber = `wc-${paymentId || Date.now()}`.slice(0, 36);
  const callbackBase = String(process.env.PUBLIC_API_URL || process.env.API_PUBLIC_URL || '').replace(/\/$/, '');
  const defaultReturnUrl = process.env.INGO_RETURN_URL || `${callbackBase}/`;
  const returnUrl = requestBody.redirectUrl || defaultReturnUrl;
  const failUrl = process.env.INGO_FAIL_URL || defaultReturnUrl;
  const dynamicCallbackUrl = callbackBase ? `${callbackBase}/webhook/ingo` : undefined;
  const isBinding = String(requestBody.qrcType) === '03';

  const registration = await postIngoForm(bank, '/rest/register.do', {
    userName: terminal.ingo_api_username,
    password: terminal.ingo_api_password,
    orderNumber,
    amount: Number(requestBody.amount || 0),
    returnUrl,
    failUrl,
    dynamicCallbackUrl,
    description: requestBody.paymentPurpose || `Оплата ${orderNumber}`,
    clientId: `partner-${context.partnerId}`,
    merchantLogin: terminal.ingo_merchant_login,
    features: isBinding ? ['SBP_BINDING'] : undefined,
  }, terminal);

  const mdOrder = registration.orderId || registration.data?.orderId;
  if (!mdOrder) {
    const error = new Error('Ingo не вернул orderId');
    error.responseBody = registration;
    throw error;
  }

  const qr = await postIngoForm(bank, '/rest/sbp/c2b/qr/dynamic/get.do', {
    userName: terminal.ingo_api_username,
    password: terminal.ingo_api_password,
    mdOrder,
    account: terminal.ingo_account,
    paymentServiceIds: 'PS0000000001',
    memberId: terminal.ingo_member_id,
    tspMerchantId: terminal.ingo_tsp_merchant_id,
    paymentPurpose: requestBody.paymentPurpose || `Оплата ${orderNumber}`,
    redirectUrl: returnUrl,
    qrHeight: 300,
    qrWidth: 300,
    qrFormat: 'image',
    createSubscription: isBinding ? 'true' : 'false',
  }, terminal);

  return {
    qrcId: qr.qrId || qr.qrcId || null,
    payload: qr.payload || null,
    qrcType: requestBody.qrcType,
    regTime: new Date().toISOString(),
    expDt: requestBody.expDt || null,
    localExpDt: requestBody.localExpDt || null,
    bankOrderId: mdOrder,
    orderNumber,
    renderedQr: qr.renderedQr || null,
    registration,
    qr,
  };
}

async function postIngoForm(bank, endpoint, fields) {
  const base = String(bank.api_base_url || '').replace(/\/$/, '');
  const url = `${base}${endpoint}`;
  const form = new URLSearchParams();

  for (const [key, value] of Object.entries(fields || {})) {
    if (Array.isArray(value)) value.forEach((item) => append(form, key, item));
    else append(form, key, value);
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(Number(process.env.INGO_QR_ATTEMPT_TIMEOUT_MS || 4500)),
  });

  const raw = await response.text();
  let parsed;
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { rawBody: raw }; }

  const applicationError = parsed.errorCode != null && String(parsed.errorCode) !== '0';
  if (!response.ok || applicationError) {
    const error = new Error('Ingo QR request failed');
    error.statusCode = response.status;
    error.responseBody = parsed;
    throw error;
  }
  return parsed;
}

function append(form, key, value) {
  if (value !== undefined && value !== null && value !== '') form.append(key, String(value));
}

function assertIngoConfigured(bank, terminal) {
  const missing = [];
  if (!bank?.api_base_url) missing.push('api_base_url');
  if (!terminal.ingo_api_username) missing.push('ingo_api_username');
  if (!terminal.ingo_api_password) missing.push('ingo_api_password');
  if (!terminal.ingo_merchant_login) missing.push('ingo_merchant_login');
  if (!terminal.ingo_tsp_merchant_id) missing.push('ingo_tsp_merchant_id');
  if (missing.length) {
    const error = new Error(`Не заполнены настройки Ingo: ${missing.join(', ')}`);
    error.code = 'BANK_CONFIG_ERROR';
    throw error;
  }
}

module.exports = {
  executeQrPayment,
  buildQrBankRequest,
};
