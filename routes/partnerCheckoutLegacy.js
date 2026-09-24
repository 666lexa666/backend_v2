const express = require('express');
const { partnerApiAuth } = require('../lib/partnerApiAuth');
const { findSubscriptionInstrument, chargeSbpSubscription } = require('../lib/subscriptionService');

const router = express.Router();

router.post('/subscriptions/charge', partnerApiAuth(), async (req, res, next) => {
  try {
    const amount = Math.round(Number(req.body?.amount));
    const partnerCustomerId = req.body?.customerId !== undefined && req.body?.customerId !== null
      ? String(req.body.customerId).trim()
      : '';
    const paymentPurpose = String(req.body?.paymentPurpose ?? '').trim();
    const subscriptionQrcId = req.body?.subscriptionQrcId
      ? String(req.body.subscriptionQrcId).trim()
      : null;
    const cardToken = req.body?.cardToken ? String(req.body.cardToken).trim() : null;
    const orderId = req.body?.orderId == null ? null : String(req.body.orderId).trim();

    const errors = [];
    if (!Number.isFinite(amount) || amount <= 0) errors.push('amount должен быть положительным целым числом в копейках');
    if (!paymentPurpose) errors.push('paymentPurpose обязателен');
    if (!subscriptionQrcId && !cardToken) errors.push('нужно указать subscriptionQrcId (для СБП) или cardToken (для карты)');
    if (subscriptionQrcId && cardToken) errors.push('укажите только один инструмент — subscriptionQrcId ИЛИ cardToken, не оба сразу');
    if (errors.length) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Некорректные параметры запроса',
        details: errors,
      });
    }

    if (cardToken) {
      return res.status(404).json({
        success: false,
        error: 'INSTRUMENT_NOT_FOUND',
        message: 'Инструмент подписки не найден, не активен, либо не принадлежит этому клиенту',
      });
    }

    const instrument = await findSubscriptionInstrument({
      partnerId: req.partner.id,
      subscriptionQrcId,
      customerId: partnerCustomerId || null,
    });

    if (!instrument) {
      return res.status(404).json({
        success: false,
        error: 'INSTRUMENT_NOT_FOUND',
        message: 'Инструмент подписки не найден, не активен, либо не принадлежит этому клиенту',
      });
    }

    try {
      const result = await chargeSbpSubscription({
        partner: req.partner,
        instrument,
        amount,
        paymentPurpose,
        orderId,
        apiVersion: 'v1',
      });

      return res.json({
        success: true,
        paymentId: result.payment.id,
        orderId: result.payment.partner_order_id || null,
        qrcId: result.qrResponse.qrcId,
        bankResponse: result.bankResponse,
      });
    } catch (error) {
      if (error.code === 'INSTRUMENT_TERMINAL_NOT_SET' || error.code === 'INSTRUMENT_TERMINAL_UNAVAILABLE') {
        return res.status(409).json({
          success: false,
          error: error.code,
          message: error.message,
        });
      }

      if (error.publicCode === 'BANK_QR_REGISTER_FAILED') {
        return res.status(502).json({
          success: false,
          error: 'BANK_QR_REGISTER_FAILED',
          message: 'Банк не зарегистрировал QR для списания',
          bankStatusCode: error.statusCode || null,
        });
      }

      if (error.publicCode === 'BANK_SUBSCRIPTION_CHARGE_FAILED') {
        return res.status(502).json({
          success: false,
          error: 'BANK_SUBSCRIPTION_CHARGE_FAILED',
          message: 'Банк отклонил списание по подписке',
          bankResponse: error.responseBody || null,
        });
      }

      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
