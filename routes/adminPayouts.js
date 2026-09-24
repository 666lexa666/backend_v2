const express = require('express');
const { auth } = require('../lib/auth');
const {
  previewPartnerPayout,
  previewAllPartnerPayouts,
  recordPartnerPayout,
  listPartnerPayouts,
} = require('../lib/payoutService');

const router = express.Router();
router.use(auth({ admin: true }));

function partnerId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    const error = new Error('Некорректный ID партнёра');
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
  return id;
}

router.get('/preview', async (req, res, next) => {
  try {
    const payoutDay = req.query.date ? String(req.query.date) : null;
    if (req.query.partnerId || req.query.partner_id) {
      const id = partnerId(req.query.partnerId ?? req.query.partner_id);
      return res.json({ success: true, summary: await previewPartnerPayout(id, payoutDay) });
    }
    return res.json({ success: true, partners: await previewAllPartnerPayouts(payoutDay) });
  } catch (error) { next(error); }
});

router.get('/partners/:partnerId', async (req, res, next) => {
  try {
    const id = partnerId(req.params.partnerId);
    const rows = await listPartnerPayouts(id, {
      limit: req.query.limit,
      beforePaidAt: req.query.beforePaidAt || req.query.before_paid_at || null,
      beforeId: req.query.beforeId || req.query.before_id || null,
    });
    return res.json({ success: true, payouts: rows });
  } catch (error) { next(error); }
});

router.post('/partners/:partnerId', async (req, res, next) => {
  try {
    const id = partnerId(req.params.partnerId);
    const idempotencyKey = req.headers['idempotency-key']
      || req.body?.idempotencyKey
      || req.body?.requestId
      || null;

    const payout = await recordPartnerPayout({
      partnerId: id,
      amountRub: req.body?.amountRub,
      amountMinor: req.body?.amountMinor,
      paidAt: req.body?.paidAt,
      idempotencyKey,
      actorId: req.partner.id,
      externalRef: req.body?.externalRef,
      note: req.body?.note,
    });

    return res.status(201).json({ success: true, payout });
  } catch (error) { next(error); }
});

module.exports = router;
