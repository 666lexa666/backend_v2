const express = require('express');
const { enqueueApplication } = require('../lib/applicationService');

const router = express.Router();

router.post('/', async (req, res, next) => {
  try {
    await enqueueApplication(req.body || {}, req);
    return res.status(200).json({ success: true });
  } catch (error) {
    return next(error);
  }
});

router.all('/', (req, res) => res.status(405).json({
  success: false,
  error: 'METHOD_NOT_ALLOWED',
  message: 'Разрешен только POST запрос',
}));

module.exports = router;
