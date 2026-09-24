const express = require('express');
const { cors } = require('./lib/cors');

const app = express();
const PORT = Number(process.env.PORT || 3100);
const HOST = String(process.env.HOST || '0.0.0.0');

app.disable('x-powered-by');
app.use(cors);
app.use(express.json({
  limit: '8mb',
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'whitecapital-backend-v2',
    database: 'WHITECAPITAL',
    version: 'v2',
  });
});

app.use('/webhook', require('./routes/bankWebhook'));
app.use('/webhook-dolinsk', require('./routes/bankWebhookDolinsk'));

app.use('/qr', require('./routes/partnerQrLegacy'));
app.use('/card', require('./routes/partnerCardLegacy'));
app.use('/refund', require('./routes/partnerRefundLegacy'));
app.use('/currency-rate', require('./routes/partnerCurrencyRate'));
app.use('/checkout', require('./routes/partnerCheckoutLegacy'));
app.use('/v2', require('./routes/partnerApiV2'));
app.use('/v2', require('./routes/partnerRefundV2'));
// /balance is intentionally removed in V2.

app.use('/admin', require('./routes/adminAuth'));
app.use('/admin', require('./routes/adminPortal'));
app.use('/admin', require('./routes/adminPayments'));
app.use('/admin', require('./routes/adminTerminals'));
app.use('/admin/payouts', require('./routes/adminPayouts'));
app.use('/admin/expenses', require('./routes/adminExpenses'));
app.use('/client', require('./routes/clientPortal'));
app.use('/client', require('./routes/clientTerminals'));
app.use('/client/payouts', require('./routes/clientPayouts'));

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Маршрут не найден' });
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_JSON',
      message: 'Неправильный JSON-запрос',
    });
  }

  const status = Number(error.statusCode || error.status || 500);
  const safeStatus = status >= 400 && status <= 599 ? status : 500;

  if (safeStatus >= 500) {
    console.error('[whitecapital-v2:error]', {
      method: req.method,
      path: req.path,
      code: error.code || null,
      message: error.message || String(error),
    });
  }

  res.status(safeStatus).json({
    success: false,
    error: error.code || (safeStatus === 409 ? 'CONFLICT' : safeStatus === 403 ? 'FORBIDDEN' : 'V2_ERROR'),
    message: safeStatus >= 500 ? 'Внутренняя ошибка сервера' : (error.message || 'Ошибка запроса'),
  });
});

async function runStartupSelfCheck() {
  try {
    const { getSupabaseAdminClient } = require('./lib/supabase');
    const db = getSupabaseAdminClient();

    const partnersResult = await db.from('partners').select('id', { count: 'exact', head: true });
    if (partnersResult.error) throw partnersResult.error;

    const routesResult = await db.from('partner_payment_routes_v2')
      .select('partner_terminal_id', { count: 'exact', head: true });
    if (routesResult.error) throw routesResult.error;

    const banksResult = await db.from('banks').select('id', { count: 'exact', head: true });
    if (banksResult.error) throw banksResult.error;

    console.log('[startup-self-check:ok]', {
      database: 'WHITECAPITAL',
      partners: Number(partnersResult.count || 0),
      routableTerminals: Number(routesResult.count || 0),
      banks: Number(banksResult.count || 0),
    });
  } catch (error) {
    console.error('[startup-self-check:error]', {
      message: error?.message || String(error),
      code: error?.code || null,
    });
  }
}

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`WHITECAPITAL V2 listening on ${HOST}:${PORT}`);
    runStartupSelfCheck();
  });
}

module.exports = app;
