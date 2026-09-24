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

app.use('/admin', require('./routes/adminAuth'));
app.use('/admin', require('./routes/adminTerminals'));
app.use('/admin/payouts', require('./routes/adminPayouts'));
app.use('/admin/expenses', require('./routes/adminExpenses'));
app.use('/client', require('./routes/clientTerminals'));
app.use('/client/payouts', require('./routes/clientPayouts'));

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Маршрут не найден' });
});

app.use((error, req, res, next) => {
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

if (require.main === module) {
  app.listen(PORT, HOST, () => console.log(`WHITECAPITAL V2 listening on ${HOST}:${PORT}`));
}

module.exports = app;
