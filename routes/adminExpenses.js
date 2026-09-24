const express = require('express');
const crypto = require('node:crypto');
const { auth } = require('../lib/auth');
const { ExpenseRepository } = require('../lib/expenseRepository');

const router = express.Router();
router.use(auth({ admin: true }));

const METHODS = ['Банковский перевод','Карта','USDT','Наличные','Другое'];
const STATUSES = new Set(['paid','cancelled']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function actor(req) {
  return {
    id: req.partner.id,
    name: req.partner.company_name || req.partner.email || `Администратор #${req.partner.id}`,
  };
}
function text(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function decimal(value, precision, label) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const raw = String(value).trim().replace(',', '.');
  if (!new RegExp(`^\\d{1,12}(?:\\.\\d{1,${precision}})?$`).test(raw)) throw Object.assign(new Error(`${label}: неверная сумма`), { statusCode: 400, code: 'VALIDATION_ERROR' });
  const [whole, fraction = ''] = raw.split('.');
  const minor = BigInt(whole) * 10n ** BigInt(precision) + BigInt(fraction.padEnd(precision, '0'));
  if (minor <= 0n || minor > 9000000000000n) throw Object.assign(new Error(`${label}: сумма вне допустимого диапазона`), { statusCode: 400, code: 'VALIDATION_ERROR' });
  return Number(minor);
}
function date(value, label, day = false) {
  if (!value) return null;
  const raw = String(value);
  if (day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw + 'T00:00:00Z'))) throw Object.assign(new Error(`${label}: неверная дата`), { statusCode: 400, code: 'VALIDATION_ERROR' });
    return raw;
  }
  if (!Number.isFinite(Date.parse(raw))) throw Object.assign(new Error(`${label}: неверная дата и время`), { statusCode: 400, code: 'VALIDATION_ERROR' });
  return new Date(raw).toISOString();
}

async function normalizeExpense(body, repo, current, reqActor) {
  const categories = (await repo.categories(reqActor)).map((item) => item.name);
  const allowed = current?.data?.category && !categories.includes(current.data.category)
    ? [current.data.category, ...categories] : categories;

  const commissionCurrency = text(body.commissionCurrency, 10) || 'RUB';
  const data = {
    category: text(body.category, 60),
    recipient: text(body.recipient, 160),
    description: text(body.description, 500),
    amountRub: decimal(body.amountRub, 2, 'Сумма в рублях'),
    amountUsdt: decimal(body.amountUsdt, 6, 'Сумма в USDT'),
    status: text(body.status, 20),
    paidAt: date(body.paidAt, 'Дата оплаты'),
    period: text(body.period, 120),
    method: text(body.method, 60),
    commission: decimal(body.commission, commissionCurrency === 'RUB' ? 2 : 6, 'Комиссия'),
    commissionCurrency,
    operationRef: text(body.operationRef, 200),
    comment: text(body.comment, 3000),
    cancelReason: text(body.cancelReason, 500),
  };

  if (!allowed.includes(data.category)) throw Object.assign(new Error('Выберите категорию'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  if (!data.recipient || !data.description) throw Object.assign(new Error('Укажите получателя и описание'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  if (data.amountRub === null && data.amountUsdt === null) throw Object.assign(new Error('Укажите сумму хотя бы в одной валюте'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  if (!STATUSES.has(data.status)) throw Object.assign(new Error('Неверный статус'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  if (data.method && !METHODS.includes(data.method)) throw Object.assign(new Error('Неверный способ оплаты'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  if (data.status === 'paid' && !data.paidAt) throw Object.assign(new Error('Укажите дату и время фактической оплаты'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  if (data.status === 'cancelled' && !data.cancelReason) throw Object.assign(new Error('Укажите причину отмены'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  if (current?.data?.status === 'cancelled') throw Object.assign(new Error('Отменённый расход нельзя редактировать'), { statusCode: 409, code: 'CONFLICT' });

  if (data.commission !== null) {
    if (!['RUB','USDT'].includes(data.commissionCurrency)) throw Object.assign(new Error('Выберите валюту комиссии'), { statusCode: 400, code: 'VALIDATION_ERROR' });
    const total = data.commissionCurrency === 'RUB' ? data.amountRub : data.amountUsdt;
    if (total === null || data.commission > total) throw Object.assign(new Error('Комиссия должна входить в сумму расхода в той же валюте'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  } else data.commissionCurrency = '';
  if (data.status !== 'cancelled') data.cancelReason = '';
  return data;
}

function filters(query = {}) {
  const dateField = text(query.dateField, 20) || 'paidAt';
  if (!['paidAt','createdAt'].includes(dateField)) throw Object.assign(new Error('Неверное поле даты'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  const from = date(query.from, 'Начало периода', true);
  const to = date(query.to, 'Конец периода', true);
  if (from && to && from > to) throw Object.assign(new Error('Начало периода позже окончания'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  return {
    search: text(query.search, 150), category: text(query.category, 60), status: text(query.status, 20),
    recipient: text(query.recipient, 160), dateField, from, to,
    page: Math.max(1, Math.min(100000, Math.floor(Number(query.page) || 1))),
  };
}

function attachment(body = {}) {
  const name = text(body.name, 180).replace(/[\\/\x00-\x1f]/g, '_');
  const allowed = {
    pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',txt:'text/plain',
    docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  const ext = name.split('.').pop().toLowerCase();
  if (!allowed[ext]) throw Object.assign(new Error('Разрешены PDF, PNG, JPG, WebP, TXT, DOCX и XLSX'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  if (typeof body.base64 !== 'string' || body.base64.length > 7000000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.base64)) throw Object.assign(new Error('Неверный файл'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  const bytes = Buffer.from(body.base64, 'base64');
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw Object.assign(new Error('Размер файла: от 1 байта до 5 МБ'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  return { id: crypto.randomUUID(), name, mime: allowed[ext], size: bytes.length, bytes };
}

router.get('/access', async (req, res, next) => {
  try { res.json({ success: true, allowed: await new ExpenseRepository().hasAccess(req.partner.id) }); }
  catch (error) { next(error); }
});
router.get('/meta', async (req, res, next) => {
  try {
    const repo = new ExpenseRepository(); const a = actor(req); const categories = await repo.categories(a);
    res.json({ success: true, categories: categories.map((item) => item.name), categoryItems: categories, methods: METHODS });
  } catch (error) { next(error); }
});
router.get('/categories', async (req, res, next) => {
  try { res.json({ success: true, categories: await new ExpenseRepository().categories(actor(req)) }); }
  catch (error) { next(error); }
});
router.post('/categories', async (req, res, next) => {
  try { res.status(201).json({ success: true, categories: await new ExpenseRepository().createCategory(req.body?.name, actor(req)) }); }
  catch (error) { next(error); }
});
router.patch('/categories/:id', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'Некорректный идентификатор категории' });
    res.json({ success: true, categories: await new ExpenseRepository().renameCategory(req.params.id, req.body?.name, actor(req)) });
  } catch (error) { next(error); }
});
router.delete('/categories/:id', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'Некорректный идентификатор категории' });
    res.json({ success: true, categories: await new ExpenseRepository().deleteCategory(req.params.id, actor(req)) });
  } catch (error) { next(error); }
});
router.get('/export', (req, res) => res.status(501).json({ success: false, error: 'EXPORT_NOT_READY', message: 'В V2 экспорт будет фоновым job, синхронный XLSX намеренно отключён' }));
router.get('/', async (req, res, next) => {
  try { res.json({ success: true, ...(await new ExpenseRepository().list(filters(req.query))) }); }
  catch (error) { next(error); }
});
router.post('/', async (req, res, next) => {
  try {
    if (!UUID.test(String(req.body?.requestId || ''))) return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'Некорректный идентификатор запроса' });
    const repo = new ExpenseRepository(); const a = actor(req);
    res.status(201).json({ success: true, expense: await repo.create(req.body.requestId, await normalizeExpense(req.body, repo, null, a), a) });
  } catch (error) { next(error); }
});
router.get('/:id', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Не найдено' });
    const expense = await new ExpenseRepository().get(req.params.id);
    if (!expense) return res.status(404).json({ success: false, error: 'EXPENSE_NOT_FOUND', message: 'Расход не найден' });
    res.json({ success: true, expense });
  } catch (error) { next(error); }
});
router.patch('/:id', async (req, res, next) => {
  try {
    const repo = new ExpenseRepository(); const current = await repo.get(req.params.id);
    if (!current) return res.status(404).json({ success: false, error: 'EXPENSE_NOT_FOUND', message: 'Расход не найден' });
    const a = actor(req);
    res.json({ success: true, expense: await repo.update(req.params.id, Number(req.body.version), await normalizeExpense(req.body, repo, current, a), a) });
  } catch (error) { next(error); }
});
router.post('/:id/attachments', async (req, res, next) => {
  try {
    const repo = new ExpenseRepository(); const current = await repo.get(req.params.id);
    if (!current) return res.status(404).json({ success: false, error: 'EXPENSE_NOT_FOUND', message: 'Расход не найден' });
    res.status(201).json({ success: true, expense: await repo.attach(req.params.id, Number(req.body.version), attachment(req.body), actor(req)) });
  } catch (error) { next(error); }
});
router.get('/:id/attachments/:fileId', async (req, res, next) => {
  try {
    const file = await new ExpenseRepository().file(req.params.id, req.params.fileId);
    if (!file) return res.status(404).json({ success: false, error: 'FILE_NOT_FOUND', message: 'Файл не найден' });
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.send(file.bytes);
  } catch (error) { next(error); }
});

module.exports = router;
