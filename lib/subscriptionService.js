const https = require('node:https');
const { getSupabaseAdminClient } = require('./supabase');
const { findBankById } = require('./legacyBankAdapter');
const {
  createPaymentCore,
  setPaymentProviderResult,
  markPaymentFailed,
  loadTerminalRuntime,
} = require('./paymentCore');
const { executeQrPayment } = require('./providerQr');
const { chargeIngoBinding } = require('./ingoRecurringClient');
const { chargeCardToken } = require('./cardRecurringClient');
const { enqueuePartnerWebhook } = require('./partnerWebhookOutbox');

async function findSubscriptionInstrument({
  partnerId,
  subscriptionQrcId = null,
  cardToken = null,
  instrumentId = null,
  customerId = null,
}) {
  const db = getSupabaseAdminClient();

  let query = db
    .from('checkout_subscription_instruments')
    .select('*')
    .eq('partner_id', Number(partnerId))
    .eq('status', 'active');

  if (instrumentId) {
    query = query.eq('id', String(instrumentId));
  } else if (subscriptionQrcId) {
    query = query.eq('payment_method', 'SBP').eq('subscription_qrc_id', String(subscriptionQrcId));
  } else if (cardToken) {
    query = query.eq('payment_method', 'CARD').eq('card_token', String(cardToken));
  } else {
    return null;
  }

  if (customerId) {
    const { data: customer, error: customerError } = await db
      .from('checkout_customers')
      .select('id')
      .eq('partner_id', Number(partnerId))
      .eq('partner_customer_id', String(customerId))
      .maybeSingle();
    if (customerError) throw customerError;
    if (!customer) {
      const error = new Error('Клиент с таким customerId не найден');
      error.statusCode = 404;
      error.code = 'CUSTOMER_NOT_FOUND';
      throw error;
    }
    query = query.eq('customer_id', customer.id);
  } else {
    query = query.is('customer_id', null);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data || null;
}

async function validateSubscriptionRuntime({ partner, instrument, amount }) {
  if (!instrument?.partner_terminal_id) {
    const error = new Error('У инструмента подписки не сохранен исходный терминал. Выполните миграцию привязки терминалов подписок или создайте подписку заново');
    error.statusCode = 409;
    error.code = 'INSTRUMENT_TERMINAL_NOT_SET';
    throw error;
  }

  const runtime = await loadTerminalRuntime({ id: instrument.partner_terminal_id });
  if (!runtime) {
    const error = new Error('Исходный терминал подписки не найден или выключен');
    error.statusCode = 409;
    error.code = 'INSTRUMENT_TERMINAL_UNAVAILABLE';
    throw error;
  }

  if (String(runtime.paymentMethod || '').toUpperCase() !== String(instrument.payment_method || '').toUpperCase()) {
    const error = new Error('Способ работы исходного терминала не совпадает со способом подписки');
    error.statusCode = 409;
    error.code = 'INSTRUMENT_TERMINAL_METHOD_MISMATCH';
    throw error;
  }

  const details = [];
  const min = runtime.minAmountMinor == null ? null : Number(runtime.minAmountMinor);
  const max = runtime.maxAmountMinor == null ? null : Number(runtime.maxAmountMinor);
  if (min !== null && Number(amount) < min) {
    details.push(`Сумма меньше минимально допустимой для выбранного терминала: ${(min / 100).toFixed(2)} ₽`);
  }
  if (max !== null && Number(amount) > max) {
    details.push(`Сумма больше максимально допустимой для выбранного терминала: ${(max / 100).toFixed(2)} ₽`);
  }
  if (details.length) {
    const error = new Error('Сумма не соответствует лимитам исходного терминала подписки');
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    error.details = details;
    throw error;
  }

  const bank = await findBankById(runtime.bankId);
  if (!runtime.bankId) {
    const error = new Error('Терминалу подписки не назначен банк');
    error.statusCode = 500;
    error.code = 'INTERNAL_ERROR';
    throw error;
  }
  if (!bank) {
    const error = new Error('Банк терминала подписки не найден');
    error.statusCode = 500;
    error.code = 'INTERNAL_ERROR';
    throw error;
  }

  return { runtime, bank };
}

function recurringPaymentInput({ partner, instrument, runtime, amount, paymentPurpose, orderId, method, apiVersion }) {
  return {
    apiVersion,
    partnerId: partner.id,
    amountMinor: Number(amount),
    transactionCurrency: 'RUB',
    accountCurrency: partner.account_currency || 'RUB',
    currencyMarkupPercent: partner.currency_markup_percent || 0,
    method,
    projectId: instrument.project_id || runtime.projectId || null,
    terminalId: instrument.partner_terminal_id,
    orderId,
    paymentPurpose,
    qrcType: method === 'SBP' ? '02' : null,
    expDt: partner.qr_exp_dt ?? 15,
    localExpDt: partner.qr_local_exp_dt ?? 900,
    commissionPercent: partner.commission_percent ?? null,
    legacy: apiVersion === 'v1' ? { endpoint: '/checkout/subscriptions/charge' } : null,
  };
}

async function chargeSbpSubscription({
  partner,
  instrument,
  amount,
  paymentPurpose,
  orderId = null,
  apiVersion = 'v2',
}) {
  const { runtime, bank } = await validateSubscriptionRuntime({ partner, instrument, amount });
  const input = recurringPaymentInput({
    partner, instrument, runtime, amount, paymentPurpose, orderId, method: 'SBP', apiVersion,
  });
  const result = await createPaymentCore(input);
  const bankPurpose = partner.purpose_use_transaction_id ? String(result.payment.id) : paymentPurpose;

  if (String(bank.provider_code || '').toLowerCase() === 'ingo') {
    try {
      const bankResponse = await chargeIngoBinding({
        bank,
        runtime,
        paymentId: result.payment.id,
        partnerId: partner.id,
        instrument,
        amount,
        paymentPurpose: bankPurpose,
      });

      await setPaymentProviderResult(result.payment.payment_pk, {
        status: 'pending',
        providerCode: runtime.providerCode || bank.provider_code || null,
        providerOrderId: bankResponse.bankOrderId || null,
      });

      return {
        payment: result.payment,
        qrResponse: { qrcId: null, payload: null },
        bankResponse,
        instrument,
      };
    } catch (error) {
      await markPaymentFailed(result.payment.payment_pk, error).catch(() => {});
      error.publicCode = 'BANK_SUBSCRIPTION_CHARGE_FAILED';
      throw error;
    }
  }

  let qrResponse;
  try {
    qrResponse = await executeQrPayment({
      payment: result.payment,
      runtime: result.runtime,
      input: { ...input, paymentPurpose: bankPurpose },
    });
    await setPaymentProviderResult(result.payment.payment_pk, {
      status: 'pending',
      providerCode: runtime.providerCode || bank.provider_code || null,
      providerOrderId: qrResponse.bankOrderId || null,
      qrcId: qrResponse.qrcId || null,
      qrPayload: qrResponse.payload || null,
    });
  } catch (error) {
    await markPaymentFailed(result.payment.payment_pk, error).catch(() => {});
    error.publicCode = 'BANK_QR_REGISTER_FAILED';
    throw error;
  }

  if (!bank.sbp_subscription_pay_url) {
    const error = new Error('У банка не задан sbp_subscription_pay_url');
    await markPaymentFailed(result.payment.payment_pk, error).catch(() => {});
    error.publicCode = 'BANK_SUBSCRIPTION_CHARGE_FAILED';
    throw error;
  }

  let bankResponse;
  try {
    bankResponse = await postJsonMtls(bank, bank.sbp_subscription_pay_url, {
      subscriptionQrcId: instrument.subscription_qrc_id,
      payQrcId: qrResponse.qrcId,
      bindingId: instrument.bank_binding_id || undefined,
      amount: Number(amount),
      paymentPurpose,
      clientId: instrument.customer_id || undefined,
    });
  } catch (error) {
    await markPaymentFailed(result.payment.payment_pk, error).catch(() => {});
    error.publicCode = 'BANK_SUBSCRIPTION_CHARGE_FAILED';
    throw error;
  }

  return { payment: result.payment, qrResponse, bankResponse, instrument };
}

async function chargeCardSubscription({
  partner,
  instrument,
  amount,
  paymentPurpose,
  orderId = null,
  apiVersion = 'v1',
}) {
  const { runtime, bank } = await validateSubscriptionRuntime({ partner, instrument, amount });

  if (!instrument.card_first_payment_id) {
    const error = new Error('Для этого инструмента не сохранён first_payment_id');
    error.statusCode = 500;
    error.code = 'INTERNAL_ERROR';
    throw error;
  }
  if (!instrument.card_token) {
    const error = new Error('Для этого инструмента не сохранён cardToken');
    error.statusCode = 500;
    error.code = 'INTERNAL_ERROR';
    throw error;
  }

  const input = recurringPaymentInput({
    partner, instrument, runtime, amount, paymentPurpose, orderId, method: 'CARD', apiVersion,
  });
  const result = await createPaymentCore(input);

  let bankResponse;
  try {
    bankResponse = await chargeCardToken(bank, {
      first_payment_id: instrument.card_first_payment_id,
      terminal_id: runtime.merchantId,
      order_id: result.payment.id,
      amount: Number(amount),
      card_token: instrument.card_token,
    });
  } catch (error) {
    await markPaymentFailed(result.payment.payment_pk, error).catch(() => {});
    error.publicCode = 'BANK_SUBSCRIPTION_CHARGE_FAILED';
    throw error;
  }

  const providerStatus = String(bankResponse?.payment_status || '').toUpperCase();
  const finalStatus = providerStatus === 'SUCCESS'
    ? 'success'
    : providerStatus === 'ERROR'
      ? 'failed'
      : 'pending';

  await setPaymentProviderResult(result.payment.payment_pk, {
    status: finalStatus,
    providerCode: runtime.providerCode || bank.provider_code || null,
    providerPaymentId: bankResponse?.payment_id || null,
    providerOrderId: bankResponse?.order_id || null,
    paidAt: finalStatus === 'success' ? new Date().toISOString() : undefined,
  });

  if (finalStatus === 'success' || finalStatus === 'failed') {
    const notificationType = finalStatus === 'success' ? 'c2b_payment' : 'payment_failed';
    await enqueuePartnerWebhook({
      paymentId: result.payment.id,
      notificationType,
      body: {
        amount: Number(amount),
        cur: 'RUB',
        trxId: bankResponse?.payment_id || bankResponse?.order_id || null,
        trxTime: finalStatus === 'success' ? new Date().toISOString() : null,
        errorMessage: bankResponse?.error_message || bankResponse?.message || null,
      },
    }).catch(() => {});
  }

  return { payment: result.payment, bankResponse, instrument };
}

async function postJsonMtls(bank, endpoint, body) {
  const url = new URL(endpoint);
  const payload = JSON.stringify(body);
  const pfx = Buffer.from(bank.certificate_base64 || '', 'base64');
  if (!pfx.length) throw new Error('У банка не задан certificate_base64');

  return new Promise((resolve, reject) => {
    const req = https.request({
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
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { rawBody: raw }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`Bank subscription payment API error: ${res.statusCode}`);
          error.statusCode = res.statusCode;
          error.responseBody = parsed;
          return reject(error);
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Bank subscription payment API timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = {
  findSubscriptionInstrument,
  validateSubscriptionRuntime,
  chargeSbpSubscription,
  chargeCardSubscription,
};
