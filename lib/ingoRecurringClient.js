async function chargeIngoBinding({ bank, runtime, paymentId, partnerId, instrument, amount, paymentPurpose }) {
  const cfg = runtime?.providerConfig || {};
  const userName = cfg.ingo_api_username || bank?.api_username;
  const password = cfg.ingo_api_password || bank?.api_password;
  if (!bank?.api_base_url || !userName || !password) {
    const error = new Error('Не заполнены настройки Ingo для рекуррентного списания');
    error.code = 'TERMINAL_NOT_CONFIGURED';
    error.statusCode = 409;
    throw error;
  }
  if (!instrument?.bank_binding_id) {
    const error = new Error('Для списания Ingo не сохранён bindingId');
    error.code = 'INSTRUMENT_BINDING_NOT_SET';
    error.statusCode = 409;
    throw error;
  }

  const orderNumber = `wc-${paymentId || Date.now()}`.slice(0, 36);
  const response = await fetch(`${String(bank.api_base_url).replace(/\/$/, '')}/recurrentPayment.do`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      userName,
      password,
      orderNumber,
      language: 'RU',
      bindingId: instrument.bank_binding_id,
      amount: Number(amount),
      currency: '643',
      description: paymentPurpose || `Оплата ${orderNumber}`,
      additionalParameters: {
        clientId: instrument.customer_id || `partner-${partnerId}`,
      },
    }),
    signal: AbortSignal.timeout(Number(process.env.BANK_QR_REQUEST_TIMEOUT_MS || 30000)),
  });

  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { rawBody: raw }; }

  const applicationError = body?.errorCode != null && String(body.errorCode) !== '0';
  if (!response.ok || applicationError || body?.success === false) {
    const error = new Error('Списание по привязке Ingo отклонено');
    error.statusCode = response.status;
    error.responseBody = body;
    throw error;
  }

  return {
    ...body,
    bankOrderId: body.mdOrder || body.orderId || body.data?.orderId || null,
    orderNumber,
  };
}

module.exports = { chargeIngoBinding };
