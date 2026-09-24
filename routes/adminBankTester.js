const express = require('express');
const { auth } = require('../lib/auth');
const {
  listTesterTerminals,
  listTesterOperations,
  runTesterOperation,
} = require('../lib/bankTesterService');

const router = express.Router();
router.use(auth({ admin: true }));

router.get('/bank-tester/terminals', async (req, res, next) => {
  try {
    res.json({ success: true, terminals: await listTesterTerminals() });
  } catch (error) { next(error); }
});

router.get('/bank-tester/operations', async (req, res, next) => {
  try {
    const result = await listTesterOperations({
      page: req.query.page,
      pageSize: req.query.pageSize,
      terminalId: req.query.terminalId || null,
    });
    res.json({ success: true, ...result });
  } catch (error) { next(error); }
});

router.post('/bank-tester/terminals/:terminalId/operations', async (req, res, next) => {
  try {
    const operation = await runTesterOperation({
      adminId: req.partner.id,
      terminalId: String(req.params.terminalId),
      body: req.body || {},
    });
    res.json({ success: true, operation });
  } catch (error) { next(error); }
});

module.exports = router;
