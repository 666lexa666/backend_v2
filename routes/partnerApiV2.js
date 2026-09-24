const express = require('express');
const { partnerApiAuth } = require('../lib/partnerApiAuth');
const { createPaymentCore, getPartnerPayment, setPaymentProviderResult, markPaymentFailed } = require('../lib/paymentCore');
const { executeQrPayment } = require('../lib/providerQr');
const { executeCardPayment } = require('../lib/providerCard');
const { findSubscriptionInstrument, chargeSbpSubscription } = require('../lib/subscriptionService');

const router = express.Router();

router.post('/payments', partnerApiAuth(), async (req, res, next) => {
  try {
    const method = String(req.body?.method || 'SBP').toUpperCase();
    const amount = Number(req.body?.amount);
    const currency = String(req.body?.currency || 'RUB').trim().toUpperCase();
    const orderId = req.body?.orderId == null ? null : String(req.body.orderId).trim();
    const paymentPurpose = String(req.body?.description ?? req.body?.paymentPurpose ?? '').trim();

    const errors = [];
    if (!Number.isSafeInteger(amount) || amount <= 0) errors.push('amount должен быть положительным целым числом в копейках');
    if (!['SBP', 'CARD'].includes(method)) errors.push('method должен быть SBP или CARD');
    if (currency !== 'RUB') errors.push('currency должен быть RUB');
    if (!paymentPurpose) errors.push('description обязателен');
    if (errors.length) return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', details: errors });

    const input = {
      apiVersion: 'v2',
      partnerId: req.partner.id,
      amountMinor: amount,
      transactionCurrency: currency,
      accountCurrency: req.partner.account_currency || 'RUB',
      currencyMarkupPercent: req.partner.currency_markup_percent || 0,
      method,
      projectId: req.body?.projectId || null,
      terminalId: req.body?.terminalId || null,
      orderId,
      paymentPurpose,
      webhookUrl: req.body?.callbackUrl || null,
      redirectUrl: req.body?.redirectUrl || null,
      qrcType: method === 'SBP' ? String(req.body?.qrcType || '02') : null,
      expDt: req.partner.qr_exp_dt ?? 15,
      localExpDt: req.partner.qr_local_exp_dt ?? 900,
      commissionPercent: req.partner.commission_percent ?? null,
    };

    const result = await createPaymentCore(input);
    let providerResponse = null;

    try {
      if (method === 'SBP') {
        providerResponse = await executeQrPayment({ payment: result.payment, runtime: result.runtime, input });
        await setPaymentProviderResult(result.payment.payment_pk, {
          status: 'pending',
          providerCode: result.runtime.providerCode || null,
          providerOrderId: providerResponse.bankOrderId || null,
          qrcId: providerResponse.qrcId || null,
          qrPayload: providerResponse.payload || null,
        });
      } else {
        providerResponse = await executeCardPayment({ payment: result.payment, runtime: result.runtime, input });
        await setPaymentProviderResult(result.payment.payment_pk, {
          status: 'pending',
          providerCode: result.runtime.providerCode || null,
          providerOrderId: providerResponse.bankOrderId || null,
        });
      }
    } catch (error) {
      await markPaymentFailed(result.payment.payment_pk, error).catch(() => {});
      return res.status(502).json({
        success: false,
        error: 'PROVIDER_PAYMENT_FAILED',
        message: 'Платежный провайдер отклонил создание платежа',
        paymentId: result.payment.id,
      });
    }

    return res.status(201).json({
      success: true,
      payment: {
        id: result.payment.id,
        requestId: result.payment.request_id,
        status: 'pending',
        method: result.payment.payment_type,
        amount: Number(result.payment.amount_minor),
        currency: result.payment.currency,
        accountCurrency: result.payment.account_currency,
        amountCurrencyMinor: Number(result.payment.amount_currency_minor),
        effectiveCurrencyRateRub: Number(result.payment.effective_currency_rate_rub_snapshot || 1),
        projectId: result.payment.project_id,
        terminalId: result.payment.partner_terminal_id,
        orderId: result.payment.partner_order_id,
        qr: method === 'SBP' ? {
          id: providerResponse?.qrcId || null,
          payload: providerResponse?.payload || null,
        } : null,
        card: method === 'CARD' ? {
          bankOrderId: providerResponse?.bankOrderId || null,
          formUrl: providerResponse?.formUrl || null,
        } : null,
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
    if (!payment) return res.status(404).json({ success: false, error: 'PAYMENT_NOT_FOUND', message: 'Платеж не найден' });

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
        accountCurrency: payment.account_currency,
        amountCurrencyMinor: Number(payment.amount_currency_minor),
        effectiveCurrencyRateRub: Number(payment.effective_currency_rate_rub_snapshot || 1),
        projectId: payment.project_id,
        terminalId: payment.partner_terminal_id,
        orderId: payment.partner_order_id,
        qrcId: payment.qrc_id,
        providerPaymentId: payment.provider_payment_id,
        paidAt: payment.paid_at,
        expiresAt: payment.expires_at,
        createdAt: payment.created_at,
        updatedAt: payment.updated_at,
        qr: provider ? { id: provider.provider_qrc_id || payment.qrc_id || null, payload: provider.qr_payload || null } : null,
        card: String(payment.payment_type).toUpperCase() === 'CARD' && provider ? {
          bankOrderId: provider.provider_order_id || null,
        } : null,
        refunds: refunds.map((row) => ({ id: row.id, amount: Number(row.amount_minor), status: row.status, completedAt: row.completed_at })),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/subscriptions/charge', partnerApiAuth(), async (req, res, next) => {
  try {
    const amount = Number(req.body?.amount);
    const paymentPurpose = String(req.body?.description ?? req.body?.paymentPurpose ?? '').trim();
    const instrumentId = req.body?.instrumentId ? String(req.body.instrumentId) : null;
    const subscriptionQrcId = req.body?.subscriptionQrcId ? String(req.body.subscriptionQrcId) : null;

    const errors = [];
    if (!Number.isSafeInteger(amount) || amount <= 0) errors.push('amount должен быть положительным целым числом в копейках');
    if (!paymentPurpose) errors.push('description обязателен');
    if (!instrumentId && !subscriptionQrcId) errors.push('instrumentId или subscriptionQrcId обязателен');
    if (errors.length) return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', details: errors });

    const instrument = await findSubscriptionInstrument({
      partnerId: req.partner.id,
      instrumentId,
      subscriptionQrcId,
      customerId: req.body?.customerId || null,
    });

    if (!instrument) {
      return res.status(404).json({
        success: false,
        error: 'SUBSCRIPTION_NOT_FOUND',
        message: 'Активная подписка не найдена',
      });
    }

    const result = await chargeSbpSubscription({
      partner: req.partner,
      instrument,
      amount,
      paymentPurpose,
      orderId: req.body?.orderId || null,
      apiVersion: 'v2',
    });

    return res.status(201).json({
      success: true,
      payment: {
        id: result.payment.id,
        status: 'pending',
        method: 'SBP',
        amount: Number(result.payment.amount_minor),
        currency: result.payment.currency,
        orderId: result.payment.partner_order_id,
        qr: {
          id: result.qrResponse.qrcId || null,
          payload: result.qrResponse.payload || null,
        },
        providerResponse: result.bankResponse,
      },
    });
  } catch (error) {
    if (error.statusCode && error.code) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.code,
        message: error.message,
      });
    }
    if (error.publicCode) {
      return res.status(502).json({
        success: false,
        error: 'PROVIDER_SUBSCRIPTION_CHARGE_FAILED',
        message: 'Провайдер отклонил списание по подписке',
      });
    }
    return next(error);
  }
});

module.exports = router;
