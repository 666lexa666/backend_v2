const express = require('express');
const { partnerApiAuth } = require('../lib/partnerApiAuth');
const { createPaymentCore, getPartnerPayment } = require('../lib/paymentCore');

const router = express.Router();

router.post('/payments', partnerApiAuth(), async (req, res, next) => {
  try {
    const method = String(req.body?.method || 'SBP').toUpperCase();
    const amount = Number(req.body?.amount);
    const orderId = req.body?.orderId == null ? null : String(req.body.orderId).trim();
    const paymentPurpose = String(req.body?.description ?? req.body?.paymentPurpose ?? '').trim();

    const errors = [];
    if (!Number.isSafeInteger(amount) || amount <= 0) errors.push('amount должен быть положительным целым числом в копейках');
    if (!['SBP', 'CARD'].includes(method)) errors.push('method должен быть SBP или CARD');
    if (!paymentPurpose) errors.push('description обязателен');
    if (errors.length) {
      return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', details: errors });
    }

    const result = await createPaymentCore({
      apiVersion: 'v2',
      partnerId: req.partner.id,
      amountMinor: amount,
      currency: req.body?.currency || 'RUB',
      method,
      projectId: req.body?.projectId || null,
      terminalId: req.body?.terminalId || null,
      orderId,
      paymentPurpose,
      webhookUrl: req.body?.callbackUrl || null,
      redirectUrl: req.body?.redirectUrl || null,
      qrcType: method === 'SBP' ? String(req.body?.qrcType || '02') : null,
      commissionPercent: req.partner.commission_percent ?? null,
    });

    return res.status(201).json({
      success: true,
      payment: {
        id: result.payment.id,
        requestId: result.payment.request_id,
        status: result.payment.status,
        method: result.payment.payment_type,
        amount: Number(result.payment.amount_minor),
        currency: result.payment.currency,
        projectId: result.payment.project_id,
        terminalId: result.payment.partner_terminal_id,
        orderId: result.payment.partner_order_id,
        createdAt: result.payment.created_at,
      },
    });
  } catch (error) {
    if (error.statusCode && error.code) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }
    return next(error);
  }
});

router.get('/payments/:id', partnerApiAuth(), async (req, res, next) => {
  try {
    const payment = await getPartnerPayment(req.partner.id, req.params.id);
    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'PAYMENT_NOT_FOUND',
        message: 'Платеж не найден',
      });
    }

    const provider = payment.payment_provider_data || null;
    const refunds = Array.isArray(payment.payment_refunds) ? payment.payment_refunds : [];

    return res.json({
      success: true,
      payment: {
        id: payment.id,
        requestId: payment.request_id,
        status: payment.status,
        method: payment.payment_type,
        amount: Number(payment.amount_minor),
        currency: payment.currency,
        projectId: payment.project_id,
        terminalId: payment.partner_terminal_id,
        orderId: payment.partner_order_id,
        qrcId: payment.qrc_id,
        providerPaymentId: payment.provider_payment_id,
        paidAt: payment.paid_at,
        expiresAt: payment.expires_at,
        createdAt: payment.created_at,
        updatedAt: payment.updated_at,
        qr: provider ? {
          id: provider.provider_qrc_id || payment.qrc_id || null,
          payload: provider.qr_payload || null,
        } : null,
        refunds: refunds.map((row) => ({
          id: row.id,
          amount: Number(row.amount_minor),
          status: row.status,
          completedAt: row.completed_at,
        })),
      },
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
