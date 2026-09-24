const express = require('express');
const { auth } = require('../lib/auth');
const {
  listAdminCatalog,
  createCatalog,
  updateCatalog,
  setCatalogArchived,
  listAdminPartnerTerminals,
  createPartnerTerminal,
  updatePartnerTerminal,
  setPartnerTerminalArchived,
} = require('../lib/terminalService');

const router = express.Router();
router.use(auth({ admin: true }));

router.get('/terminals', async (req, res, next) => {
  try {
    res.json({ success: true, terminals: await listAdminCatalog(), monthly_totals_available: false });
  } catch (error) { next(error); }
});

router.post('/terminals', async (req, res, next) => {
  try {
    const terminal = await createCatalog(req.body || {});
    res.status(201).json({ success: true, terminal });
  } catch (error) { next(error); }
});

router.patch('/terminals/:terminalId', async (req, res, next) => {
  try {
    const terminal = await updateCatalog(String(req.params.terminalId), req.body || {});
    res.json({ success: true, terminal });
  } catch (error) { next(error); }
});

router.patch('/terminals/:terminalId/archive', async (req, res, next) => {
  try {
    const archived = req.body?.isArchived ?? req.body?.is_archived ?? req.body?.archived;
    if (typeof archived !== 'boolean') return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'isArchived должен быть boolean' });
    const terminal = await setCatalogArchived(
      String(req.params.terminalId),
      archived,
      req.partner.id,
      req.body?.reason == null ? null : String(req.body.reason).slice(0, 500),
    );
    res.json({ success: true, terminal: { ...terminal, is_archived: Boolean(terminal?.archived_at) } });
  } catch (error) { next(error); }
});

router.get('/partners/:partnerId/terminals', async (req, res, next) => {
  try {
    const partnerId = Number(req.params.partnerId);
    if (!Number.isSafeInteger(partnerId) || partnerId <= 0) return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'Некорректный ID партнёра' });
    res.json({ success: true, terminals: await listAdminPartnerTerminals(partnerId) });
  } catch (error) { next(error); }
});

router.post('/partners/:partnerId/terminals', async (req, res, next) => {
  try {
    const partnerId = Number(req.params.partnerId);
    if (!Number.isSafeInteger(partnerId) || partnerId <= 0) return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'Некорректный ID партнёра' });
    const terminal = await createPartnerTerminal(partnerId, req.body || {});
    res.status(201).json({ success: true, terminal });
  } catch (error) { next(error); }
});

router.patch('/partners/:partnerId/terminals/:terminalId', async (req, res, next) => {
  try {
    const partnerId = Number(req.params.partnerId);
    if (!Number.isSafeInteger(partnerId) || partnerId <= 0) return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'Некорректный ID партнёра' });
    const terminal = await updatePartnerTerminal(partnerId, String(req.params.terminalId), req.body || {});
    res.json({ success: true, terminal });
  } catch (error) { next(error); }
});

router.patch('/partners/:partnerId/terminals/:terminalId/archive', async (req, res, next) => {
  try {
    const partnerId = Number(req.params.partnerId);
    const archived = req.body?.isArchived ?? req.body?.is_archived ?? req.body?.archived;
    if (!Number.isSafeInteger(partnerId) || partnerId <= 0 || typeof archived !== 'boolean') {
      return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'Некорректные параметры архива' });
    }
    const terminal = await setPartnerTerminalArchived(
      partnerId,
      String(req.params.terminalId),
      archived,
      req.partner.id,
      req.body?.reason == null ? null : String(req.body.reason).slice(0, 500),
    );
    res.json({ success: true, terminal: { ...terminal, is_archived: Boolean(terminal?.archived_at) } });
  } catch (error) { next(error); }
});

module.exports = router;
