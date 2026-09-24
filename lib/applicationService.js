const { getSupabaseAdminClient } = require('./supabase');

async function enqueueApplication(application, req) {
  const db = getSupabaseAdminClient();
  const message = buildApplicationTelegramText(application || {}, req);
  const { data, error } = await db.from('application_delivery_queue').insert({
    message,
    status: 'pending',
    attempts: 0,
    chunks_delivered: 0,
    next_attempt_at: new Date().toISOString(),
  }).select('id').single();
  if (error) throw error;
  return data;
}

async function processApplicationDeliveryBatch({ workerId, limit = 10, leaseSeconds = 120 } = {}) {
  const botToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!botToken || !chatId) return { configured: false, claimed: 0, delivered: 0, failed: 0 };

  const db = getSupabaseAdminClient();
  const { data: rows, error } = await db.rpc('claim_application_delivery_queue', {
    p_worker_id: String(workerId || 'application-worker'),
    p_limit: Math.max(1, Math.min(Number(limit) || 10, 100)),
    p_lease_seconds: Math.max(30, Math.min(Number(leaseSeconds) || 120, 3600)),
  });
  if (error) throw error;

  let delivered = 0;
  let failed = 0;
  for (const row of rows || []) {
    try {
      const chunks = splitText(String(row.message || ''), 3900);
      for (let i = Number(row.chunks_delivered || 0); i < chunks.length; i += 1) {
        await sendTelegramChunk(botToken, chatId, chunks[i]);
        const { error: progressError } = await db.from('application_delivery_queue').update({
          chunks_delivered: i + 1,
        }).eq('id', row.id).eq('lease_token', row.lease_token);
        if (progressError) throw progressError;
      }

      const { error: doneError } = await db.from('application_delivery_queue').update({
        status: 'delivered',
        delivered_at: new Date().toISOString(),
        lease_token: null,
        lease_until: null,
        last_error: null,
      }).eq('id', row.id).eq('lease_token', row.lease_token);
      if (doneError) throw doneError;
      delivered += 1;
    } catch (error) {
      const terminal = Number(row.attempts || 1) >= Number(process.env.APPLICATION_MAX_ATTEMPTS || 8);
      const delaySeconds = Math.min(3600, 10 * (2 ** Math.max(0, Number(row.attempts || 1) - 1)));
      const { error: failError } = await db.from('application_delivery_queue').update({
        status: terminal ? 'failed' : 'retry',
        next_attempt_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
        lease_token: null,
        lease_until: null,
        last_error: error?.message || String(error),
      }).eq('id', row.id).eq('lease_token', row.lease_token);
      if (failError) throw failError;
      failed += 1;
    }
  }

  return { configured: true, claimed: (rows || []).length, delivered, failed };
}

function buildApplicationTelegramText(application, req) {
  const serviceType = application.serviceType || 'Не указан';
  const fields = serviceType === 'Агентские услуги'
    ? [
        ['Тип услуги', application.serviceType],
        ['Название компании', application.companyName],
        ['Страна регистрации', application.countryOfRegistration],
        ['Поручение', application.requestedInstruction],
        ['Страна иностранного поставщика', application.foreignSupplierCountry],
        ['Тип товаров/услуг', application.goodsServicesType],
        ['Ожидаемая сумма операции', application.expectedTransactionAmount],
        ['Тип клиента', application.clientType],
        ['Счет/инвойс доступен', application.invoiceAvailable],
        ['Контактное лицо', application.contactPerson],
        ['Email', application.email],
        ['Телефон / мессенджер', application.phoneMessenger],
        ['Подтверждение', application.confirmation],
      ]
    : [
        ['Тип услуги', application.serviceType],
        ['Название компании', application.companyName],
        ['Страна регистрации', application.countryOfRegistration],
        ['Регистрационный номер', application.registrationNumber],
        ['Платежный ресурс', application.paymentResource],
        ['Категория бизнеса', application.businessCategory],
        ['Описание товаров/услуг', application.goodsDescription],
        ['Ожидаемый оборот в месяц', application.expectedMonthlyTurnover],
        ['Средняя сумма транзакции', application.averageTransactionAmount],
        ['Необходимые методы оплаты', application.requiredPaymentMethods],
        ['Контактное лицо', application.contactPerson],
        ['Email', application.email],
        ['Телефон / мессенджер', application.phoneMessenger],
        ['Подтверждение', application.confirmation],
      ];

  const known = new Set([
    'serviceType','companyName','countryOfRegistration','registrationNumber','paymentResource',
    'businessCategory','goodsDescription','expectedMonthlyTurnover','averageTransactionAmount',
    'requiredPaymentMethods','requestedInstruction','foreignSupplierCountry','goodsServicesType',
    'expectedTransactionAmount','clientType','invoiceAvailable','contactPerson','email',
    'phoneMessenger','confirmation',
  ]);

  const lines = ['🟡 <b>Новая заявка WHITECAPITAL</b>', '', ...formatFields(fields)];
  const extras = Object.entries(application || {}).filter(([key]) => !known.has(key));
  if (extras.length) {
    lines.push('', '<b>Дополнительные поля:</b>');
    for (const [key, value] of extras) lines.push(`${escapeHtml(key)}: ${escapeHtml(formatValue(value))}`);
  }
  lines.push('', `<b>IP:</b> ${escapeHtml(clientIp(req))}`);
  lines.push(`<b>User-Agent:</b> ${escapeHtml(req?.headers?.['user-agent'] || 'Не указан')}`);
  return lines.join('\n');
}

async function sendTelegramChunk(botToken, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(Number(process.env.APPLICATION_TELEGRAM_TIMEOUT_MS || 15000)),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Telegram API error: ${response.status} ${body.slice(0,500)}`);
  }
}

function formatFields(fields) {
  return fields
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => `<b>${escapeHtml(label)}:</b> ${escapeHtml(formatValue(value))}`);
}

function formatValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clientIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req?.ip || req?.socket?.remoteAddress || 'Не указан';
}

function splitText(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let current = text;
  while (current.length > maxLength) {
    let splitAt = current.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) splitAt = maxLength;
    chunks.push(current.slice(0, splitAt));
    current = current.slice(splitAt).trimStart();
  }
  if (current) chunks.push(current);
  return chunks;
}

module.exports = {
  enqueueApplication,
  processApplicationDeliveryBatch,
  buildApplicationTelegramText,
};
