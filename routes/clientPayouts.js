const express = require('express');
const { auth } = require('../lib/auth');
const { previewPartnerPayout, listPartnerPayouts } = require('../lib/payoutService');

const router = express.Router();
router.use(auth());

router.get('/preview', async (req, res, next) => {
  try {
    const payoutDay = req.query.date ? String(req.query.date) : null;
    const summary = await previewPartnerPayout(req.partner.id, payoutDay);
    return res.json({ success: true, summary });
  } catch (error) { next(error); }
});

router.get('/', async (req, res, next) => {
  try {
    const payouts = await listPartnerPayouts(req.partner.id, {
      limit: req.query.limit,
      beforePaidAt: req.query.beforePaidAt || req.query.before_paid_at || null,
      beforeId: req.query.beforeId || req.query.before_id || null,
    });
    return res.json({ success: true, payouts });
  } catch (error) { next(error); }
});

module.exports = router;
