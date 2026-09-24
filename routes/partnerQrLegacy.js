const express = require('express');
const { partnerApiAuth } = require('../lib/partnerApiAuth');
const { getSupabaseAdminClient } = require('../lib/supabase');
const {
  createPaymentCore,
  getPartnerPayment,
  setPaymentProviderResult,
  markPaymentFailed,
  loadTerminalRuntime,
} = require('../lib/paymentCore');
const { executeQrPayment } = require('../lib/providerQr');
const {
  normalizePartnerOrderId,
  normalizeUrlValue,
  isAsciiHttpUrl,
  resolveBankPaymentPurpose,
  resolveLegacyTerminalAssignment,
  validateLegacyQrRequest,
} = require('../lib/legacyPartnerCompatibility');

const router = express.Router();

router.post('/', partnerApiAuth(), async (req, res, next) => {
  try {
    const db = getSupabaseAdminClient();
    const partnerOrderId = normalizePartnerOrderId(req.body?.orderId);
    if (partnerOrderId.error) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Некорректные параметры QR-запроса',
        details: [partnerOrderId.error],
      });
    }

    const rawWebhookUrl = normalizeUrlValue(req.body?.webhookUrl);
    if (rawWebhookUrl && (rawWebhookUrl.length > 2048 || !isAsciiHttpUrl(rawWebhookUrl))) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Некорректные параметры QR-запроса',
        details: ['webhookUrl должен быть корректным HTTP(S) URL длиной не более 2048 символов'],
      });
    }

    const terminalSelection = await resolveLegacyTerminalAssignment({
      db,
      partner: req.partner,
      terminalId: req.body?.terminalId,
      projectId: req.body?.projectId || null,
      amountMinor: req.body?.amount,
      method: 'SBP',
    });

    if (terminalSelection.reason === 'method_mismatch') {
      return res.status(400).json({
        success: false,
        error: 'TERMINAL_PAYMENT_METHOD_MISMATCH',
        message: 'Указанный terminalId предназначен для карточных платежей и не может использоваться в /qr',
      });
    }

    if (!terminalSelection.assignment) {
      const detail = terminalSelection.effectiveTerminalId
        ? 'terminalId не найден, не принадлежит партнеру или выключен'
        : (req.partner.terminal_auto_distribution_enabled
          ? 'Сумма не подходит под лимиты ни одного активного терминала, участвующего в автораспределении'
          : 'У партнера не настроен ни один терминал');
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Некорректные параметры QR-запроса',
        details: [detail],
      });
    }

    const runtime = await loadTerminalRuntime(terminalSelection.assignment);
    const validation = validateLegacyQrRequest({
      body: req.body || {},
      partner: req.partner,
      assignment: terminalSelection.assignment,
      runtime,
    });

    if (validation.errors.length) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Некорректные параметры QR-запроса',
        details: validation.errors,
      });
    }

    const normalized = validation.normalized;
    const input = {
      apiVersion: 'v1',
      partnerId: req.partner.id,
      amountMinor: normalized.amountMinor,
      transactionCurrency: 'RUB',
      accountCurrency: req.partner.account_currency || 'RUB',
      currencyMarkupPercent: req.partner.currency_markup_percent || 0,
      method: 'SBP',
      projectId: req.body?.projectId || terminalSelection.assignment.project_id || null,
      terminalId: terminalSelection.assignment.partner_terminal_id,
      orderId: partnerOrderId.value,
      paymentPurpose: normalized.paymentPurpose,
      webhookUrl: rawWebhookUrl || null,
      redirectUrl: normalized.redirectUrl,
      qrcType: normalized.qrcType,
      expDt: normalized.expDt,
      localExpDt: normalized.localExpDt,
      subscriptionPurpose: normalized.subscriptionPurpose,
      subscriptionServiceId: normalized.subscriptionServiceId,
      subscriptionServiceName: normalized.subscriptionServiceName,
      clientPhone: normalized.clientPhone,
      clientPam: normalized.clientPam,
      commissionPercent: req.partner.commission_percent ?? null,
      preselectedAssignment: terminalSelection.assignment,
      preselectedRuntime: runtime,
      legacy: { endpoint: '/qr' },
    };

    const result = await createPaymentCore(input);
    const providerInput = {
      ...input,
      paymentPurpose: resolveBankPaymentPurpose({
        originalPurpose: normalized.paymentPurpose,
        paymentId: result.payment.id,
        clientPhone: normalized.clientPhone,
        useClientPhone: req.partner.purpose_use_client_phone,
        useTransactionId: req.partner.purpose_use_transaction_id,
      }),
    };

    let bankResponse;
    try {
      bankResponse = await executeQrPayment({
        payment: result.payment,
        runtime: result.runtime,
        input: providerInput,
      });
      const expiresAt = bankResponse.expDt
        ? new Date(Date.now() + Number(bankResponse.expDt) * 60_000).toISOString()
        : null;

      await setPaymentProviderResult(result.payment.payment_pk, {
        status: 'pending',
        providerCode: result.runtime.providerCode || null,
        providerOrderId: bankResponse.bankOrderId || null,
        qrcId: bankResponse.qrcId || null,
        qrPayload: bankResponse.payload || null,
        expiresAt,
      });
    } catch (error) {
      await markPaymentFailed(result.payment.payment_pk, error).catch(() => {});
      return res.status(502).json({
        success: false,
        error: 'BANK_QR_REGISTER_FAILED',
        message: 'Банк не зарегистрировал QR-код',
        paymentId: result.payment.id,
        bankStatusCode: error.statusCode || null,
      });
    }

    return res.status(200).json({
      success: true,
      paymentId: result.payment.id,
      orderId: result.payment.partner_order_id || null,
      qrcId: bankResponse.qrcId || null,
      payload: bankResponse.payload || null,
      qrcType: bankResponse.qrcType || normalized.qrcType,
      regTime: bankResponse.regTime || null,
      expDt: bankResponse.expDt ?? (normalized.qrcType === '02' ? normalized.expDt : null),
      localExpDt: bankResponse.localExpDt ?? (normalized.qrcType === '02' ? normalized.localExpDt : null),
      redirectUrl: normalized.redirectUrl || null,
      amount: normalized.amountMinor,
      accountCurrency: result.payment.account_currency || 'RUB',
      amountCurrencyMinor: Number(result.payment.amount_currency_minor),
      effectiveCurrencyRateRub: Number(result.payment.effective_currency_rate_rub_snapshot || 1),
      currencyMarkupPercent: Number(result.payment.currency_markup_percent_snapshot || 0),
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

router.get('/:paymentId/status', partnerApiAuth(), async (req, res, next) => {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(req.params.paymentId))) {
      return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'paymentId должен быть UUID' });
    }

    const payment = await getPartnerPayment(req.partner.id, req.params.paymentId);
    if (!payment) return res.status(404).json({ success: false, error: 'PAYMENT_NOT_FOUND', message: 'Платеж не найден' });

    const provider = payment.payment_provider_data || {};
    const refunds = Array.isArray(payment.payment_refunds) ? payment.payment_refunds : [];
    const lastRefund = refunds.slice().sort((a,b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] || null;
    const meta = payment.metadata || {};

    return res.status(200).json({
      success: true,
      paymentId: payment.id,
      orderId: payment.partner_order_id || null,
      status: legacyPaymentStatus(payment,lastRefund),
      qrcId: payment.qrc_id || provider.provider_qrc_id || null,
      qrcType: payment.qrc_type || null,
      paymentType: payment.payment_type || null,
      paymentPurpose: meta.paymentPurpose || null,
      amount: Number(payment.amount_minor),
      accountCurrency: payment.account_currency || 'RUB',
      amountCurrencyMinor: Number(payment.amount_currency_minor),
      effectiveCurrencyRateRub: payment.effective_currency_rate_rub_snapshot || null,
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

function legacyPaymentStatus(payment,lastRefund){
  if(lastRefund){
    const s=String(lastRefund.status || '').toLowerCase();
    if(s==='requested') return 'refund_requested';
    if(s==='processing') return 'refund_processing';
    if(s==='confirmed') return 'refund_confirmed';
    if(s==='refused') return 'refund_refused';
    if(s==='failed') return 'refund_failed';
    if(s==='cancelled') return 'refund_refused';
  }
  const status=String(payment?.status || '');
  if(status==='creating') return 'creating_qr';
  if(payment?.qrc_type==='03' && status==='failed') return 'subscription_failed';
  return status;
}

module.exports = router;
