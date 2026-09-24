const express = require('express');
const { partnerApiAuth } = require('../lib/partnerApiAuth');
const { createPaymentCore, getPartnerPayment } = require('../lib/paymentCore');

const router = express.Router();

router.post('/', partnerApiAuth(), async (req, res, next) => {
  try {
    const amount = req.body?.amount;
    const qrcType = req.body?.qrcType;
    const paymentPurpose = String(req.body?.paymentPurpose || req.body?.description || '').trim();
    const errors = [];

    if (qrcType == null || !['02', '03'].includes(String(qrcType))) {
      errors.push('qrcType обязателен и должен быть 02 или 03');
    }
    if (!/^\d{1,12}$/.test(String(amount ?? '')) || Number(amount) <= 0) {
      errors.push('amount должен быть целым числом в копейках от 1 до 12 цифр');
    }
    if (!paymentPurpose) errors.push('paymentPurpose обязателен');

    if (String(qrcType) === '03') {
      if (!req.body?.subscriptionPurpose) errors.push('subscriptionPurpose обязателен для QR-подписки qrcType=03');
      if (!req.body?.subscriptionServiceId) errors.push('subscriptionServiceId обязателен для QR-подписки qrcType=03');
      if (!req.body?.subscriptionServiceName) errors.push('subscriptionServiceName обязателен для QR-подписки qrcType=03');
    }

    if (errors.length) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Некорректные параметры QR-запроса',
        details: errors,
      });
    }

    const result = await createPaymentCore({
      apiVersion: 'v1',
      partnerId: req.partner.id,
      amountMinor: Number(amount),
      currency: 'RUB',
      method: 'SBP',
      projectId: req.body?.projectId || null,
      terminalId: req.body?.terminalId || null,
      orderId: req.body?.orderId || null,
      paymentPurpose,
      webhookUrl: req.body?.webhookUrl || null,
      redirectUrl: req.body?.redirectUrl || null,
      qrcType: String(qrcType),
      subscriptionPurpose: req.body?.subscriptionPurpose || null,
      subscriptionServiceId: req.body?.subscriptionServiceId || null,
      subscriptionServiceName: req.body?.subscriptionServiceName || null,
      clientPhone: req.body?.clientPhone || null,
      clientPam: req.body?.clientPam || null,
      commissionPercent: req.partner.commission_percent ?? null,
      legacy: { endpoint: '/qr' },
    });

    // Bank execution is intentionally delegated to the shared provider layer that will be
    // attached to both V1 and V2. Until then, preserve the V1 envelope for the created payment.
    return res.status(200).json({
      success: true,
      paymentId: result.payment.id,
      orderId: result.payment.partner_order_id || null,
      qrcId: null,
      payload: null,
      qrcType: result.payment.qrc_type,
      regTime: result.payment.created_at,
      expDt: req.partner.qr_exp_dt ?? 15,
      localExpDt: req.partner.qr_local_exp_dt ?? 900,
      redirectUrl: req.body?.redirectUrl || req.partner.redirect_url || null,
      accountCurrency: result.payment.currency || 'RUB',
      amountCurrencyMinor: Number(result.payment.amount_minor),
      effectiveCurrencyRateRub: result.payment.currency_rate_rub_snapshot || 1,
    });
  } catch (error) {
    if (error.statusCode && error.code) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.code,
        message: error.message,
      });
    }
    return next(error);
  }
});

router.get('/:paymentId/status', partnerApiAuth(), async (req, res, next) => {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(req.params.paymentId))) {
      return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'paymentId должен быть UUID' });
    }

    const payment = await getPartnerPayment(req.partner.id, req.params.paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, error: 'PAYMENT_NOT_FOUND', message: 'Платеж не найден' });
    }

    const provider = payment.payment_provider_data || {};
    const refunds = Array.isArray(payment.payment_refunds) ? payment.payment_refunds : [];
    const lastRefund = refunds.slice().sort((a,b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] || null;
    const meta = payment.metadata || {};

    return res.status(200).json({
      success: true,
      paymentId: payment.id,
      orderId: payment.partner_order_id || null,
      status: payment.status,
      qrcId: payment.qrc_id || provider.provider_qrc_id || null,
      qrcType: payment.qrc_type || null,
      paymentType: payment.payment_type || null,
      paymentPurpose: meta.paymentPurpose || null,
      amount: Number(payment.amount_minor),
      accountCurrency: payment.currency || 'RUB',
      amountCurrencyMinor: Number(payment.amount_minor),
      effectiveCurrencyRateRub: payment.currency_rate_rub_snapshot || null,
      createdAt: payment.created_at,
      updatedAt: payment.updated_at,
      paidAt: payment.paid_at || provider.provider_trx_time || null,
      trxId: provider.provider_trx_id || payment.provider_payment_id || null,
      refundStatus: lastRefund?.status || null,
      refundAmount: lastRefund ? Number(lastRefund.amount_minor) : null,
      refundCompletedAt: lastRefund?.completed_at || null,
    });
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
