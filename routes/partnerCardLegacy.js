const express=require('express');
const { partnerApiAuth }=require('../lib/partnerApiAuth');
const { getSupabaseAdminClient }=require('../lib/supabase');
const {
  createPaymentCore,
  getPartnerPayment,
  setPaymentProviderResult,
  markPaymentFailed,
  loadTerminalRuntime,
}=require('../lib/paymentCore');
const { executeCardPayment }=require('../lib/providerCard');
const { isSandboxPartner,createSandboxPayment,getSandboxPayment,sandboxV1StatusResponse }=require('../lib/sandboxPaymentService');
const { findBankById }=require('../lib/legacyBankAdapter');
const {
  normalizePartnerOrderId,
  normalizeUrlValue,
  resolveQrRedirectUrl,
  isAsciiHttpUrl,
  resolveLegacyTerminalAssignment,
}=require('../lib/legacyPartnerCompatibility');

const router=express.Router();

router.post('/',partnerApiAuth(),async(req,res,next)=>{
  try{
    const db=getSupabaseAdminClient();
    const amount=req.body?.amount;
    const paymentPurpose=String(req.body?.paymentPurpose || req.body?.description || '').trim();
    const rawWebhookUrl=normalizeUrlValue(req.body?.webhookUrl);
    const redirectUrl=resolveQrRedirectUrl(req.body?.redirectUrl,req.partner.redirect_url);
    const partnerOrderId=normalizePartnerOrderId(req.body?.orderId);
    const requestErrors=[];

    if(partnerOrderId.error) requestErrors.push(partnerOrderId.error);
    if(!/^\d{1,12}$/.test(String(amount??'')) || Number(amount)<=0){
      requestErrors.push('amount должен быть целым числом в копейках от 1 до 12 цифр');
    }
    if(!paymentPurpose) requestErrors.push('paymentPurpose обязателен');
    if(paymentPurpose.length>140) requestErrors.push('paymentPurpose не должен быть длиннее 140 символов');
    if(rawWebhookUrl && (rawWebhookUrl.length>2048 || !isAsciiHttpUrl(rawWebhookUrl))){
      requestErrors.push('webhookUrl должен быть корректным HTTP(S) URL длиной не более 2048 символов');
    }
    if(redirectUrl && (redirectUrl.length>1024 || !isAsciiHttpUrl(redirectUrl))){
      requestErrors.push('redirectUrl должен быть корректным ASCII HTTP(S) URL длиной не более 1024 символов');
    }
    if(requestErrors.length){
      return res.status(400).json({
        success:false,
        error:'VALIDATION_ERROR',
        message:'Некорректные параметры карточного платежа',
        details:requestErrors,
      });
    }

    const selection=await resolveLegacyTerminalAssignment({
      db,
      partner:req.partner,
      terminalId:req.body?.terminalId,
      projectId:req.body?.projectId || null,
      amountMinor:Number(amount),
      method:'CARD',
    });

    if(selection.reason==='method_mismatch'){
      return res.status(400).json({
        success:false,
        error:'TERMINAL_PAYMENT_METHOD_MISMATCH',
        message:'Выбранный терминал не поддерживает карточные платежи',
      });
    }

    if(!selection.assignment){
      return res.status(400).json({
        success:false,
        error:'CARD_TERMINAL_NOT_FOUND',
        message:selection.effectiveTerminalId
          ? 'terminalId не найден, не принадлежит партнёру или выключен'
          : (req.partner.terminal_auto_distribution_enabled
            ? 'Сумма не подходит под лимиты ни одного активного карточного терминала, участвующего в автораспределении'
            : 'У партнёра не настроен активный карточный терминал по умолчанию'),
      });
    }

    const min=selection.assignment.effective_min_amount_minor==null
      ? null:Number(selection.assignment.effective_min_amount_minor);
    const max=selection.assignment.effective_max_amount_minor==null
      ? null:Number(selection.assignment.effective_max_amount_minor);
    if(min!==null && Number(amount)<min){
      return amountLimitError(res,`Сумма меньше минимально допустимой: ${(min/100).toFixed(2)} ₽`);
    }
    if(max!==null && Number(amount)>max){
      return amountLimitError(res,`Сумма больше максимально допустимой: ${(max/100).toFixed(2)} ₽`);
    }

    const runtime=await loadTerminalRuntime(selection.assignment);
    if(isSandboxPartner(req.partner)){
      const input={
        apiVersion:'v1',
        partnerId:req.partner.id,
        amountMinor:Number(amount),
        transactionCurrency:'RUB',
        accountCurrency:req.partner.account_currency || 'RUB',
        currencyMarkupPercent:req.partner.currency_markup_percent || 0,
        method:'CARD',
        projectId:req.body?.projectId || selection.assignment.project_id || null,
        terminalId:selection.assignment.partner_terminal_id,
        orderId:partnerOrderId.value,
        paymentPurpose,
        webhookUrl:rawWebhookUrl || null,
        redirectUrl,
        commissionPercent:req.partner.commission_percent ?? null,
      };
      const sandbox=await createSandboxPayment({partner:req.partner,input,runtime});
      return res.status(200).json({
        success:true,
        paymentId:sandbox.data.id,
        orderId:sandbox.data.partnerOrderId || null,
        terminalId:sandbox.data.partnerTerminalId || null,
        bankOrderId:sandbox.data.bankOrderId,
        formUrl:sandbox.data.formUrl,
        redirectUrl:sandbox.data.redirectUrl || null,
        amount:Number(sandbox.data.amountMinor),
        accountCurrency:sandbox.data.accountCurrency || 'RUB',
        amountCurrencyMinor:Number(sandbox.data.amountCurrencyMinor),
        effectiveCurrencyRateRub:Number(sandbox.data.effectiveCurrencyRateRubSnapshot || 1),
        status:'pending',
      });
    }

    const bank=await findBankById(runtime?.bankId,db);
    if(!bank){
      return res.status(500).json({
        success:false,
        error:'BANK_NOT_CONFIGURED',
        message:'Для терминала не настроен банк',
      });
    }
    if(bank.provider_code!=='ingo'){
      return res.status(400).json({
        success:false,
        error:'CARD_BANK_NOT_SUPPORTED',
        message:'Карточная оплата недоступна на выбранном терминале',
      });
    }

    const cfg=runtime?.providerConfig || {};
    const terminalErrors=[];
    if(!cfg.ingo_merchant_login) terminalErrors.push('Merchant Login обязателен');
    if(!cfg.ingo_api_username) terminalErrors.push('API логин обязателен');
    if(!cfg.ingo_api_password) terminalErrors.push('API пароль обязателен');
    if(!cfg.ingo_callback_token) terminalErrors.push('Callback token обязателен');
    if(terminalErrors.length){
      return res.status(400).json({
        success:false,
        error:'TERMINAL_NOT_CONFIGURED',
        message:'Карточный терминал настроен не полностью',
        details:terminalErrors,
      });
    }

    const input={
      apiVersion:'v1',
      partnerId:req.partner.id,
      amountMinor:Number(amount),
      transactionCurrency:'RUB',
      accountCurrency:req.partner.account_currency || 'RUB',
      currencyMarkupPercent:req.partner.currency_markup_percent || 0,
      method:'CARD',
      projectId:req.body?.projectId || selection.assignment.project_id || null,
      terminalId:selection.assignment.partner_terminal_id,
      orderId:partnerOrderId.value,
      paymentPurpose,
      webhookUrl:rawWebhookUrl || null,
      redirectUrl,
      commissionPercent:req.partner.commission_percent ?? null,
      preselectedAssignment:selection.assignment,
      preselectedRuntime:runtime,
      legacy:{endpoint:'/card'},
    };

    const result=await createPaymentCore(input);
    const providerInput={
      ...input,
      paymentPurpose:req.partner.purpose_use_transaction_id
        ? String(result.payment.id)
        : paymentPurpose,
    };

    let bankResponse;
    try{
      bankResponse=await executeCardPayment({
        payment:result.payment,
        runtime:result.runtime,
        input:providerInput,
      });
      await setPaymentProviderResult(result.payment.payment_pk,{
        status:'pending',
        providerOrderId:bankResponse.bankOrderId,
      });
    }catch(error){
      await markPaymentFailed(result.payment.payment_pk,error).catch(()=>{});
      return res.status(502).json({
        success:false,
        error:'BANK_CARD_REGISTER_FAILED',
        message:'Банк не зарегистрировал карточный платёж',
        paymentId:result.payment.id,
        bankStatusCode:error.statusCode || null,
      });
    }

    return res.status(200).json({
      success:true,
      paymentId:result.payment.id,
      orderId:result.payment.partner_order_id || null,
      terminalId:result.payment.partner_terminal_id || null,
      bankOrderId:bankResponse.bankOrderId,
      formUrl:bankResponse.formUrl,
      redirectUrl:input.redirectUrl || bankResponse.returnUrl || null,
      amount:Number(amount),
      accountCurrency:result.payment.account_currency || 'RUB',
      amountCurrencyMinor:Number(result.payment.amount_currency_minor),
      effectiveCurrencyRateRub:Number(result.payment.effective_currency_rate_rub_snapshot || 1),
      status:'pending',
    });
  }catch(error){
    if(error.statusCode && error.code){
      return res.status(error.statusCode).json({
        success:false,
        error:error.code,
        message:error.message,
        ...(error.details?{details:error.details}:{}),
      });
    }
    return next(error);
  }
});

router.get('/:paymentId/status',partnerApiAuth(),async(req,res,next)=>{
  try{
    const id=String(req.params.paymentId || '');
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)){
      return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'paymentId должен быть UUID'});
    }
    if(isSandboxPartner(req.partner)){
      const sandbox=await getSandboxPayment(req.partner.id,id);
      if(!sandbox || String(sandbox.data.paymentType).toUpperCase()!=='CARD'){
        return res.status(404).json({success:false,error:'PAYMENT_NOT_FOUND',message:'Карточный платёж не найден'});
      }
      return res.json({
        ...sandboxV1StatusResponse(sandbox),
        terminalId:sandbox.data.partnerTerminalId || null,
        bankOrderId:sandbox.data.bankOrderId || null,
        paymentType:'CARD',
      });
    }

    const payment=await getPartnerPayment(req.partner.id,id);
    if(!payment || String(payment.payment_type).toUpperCase()!=='CARD'){
      return res.status(404).json({success:false,error:'PAYMENT_NOT_FOUND',message:'Карточный платёж не найден'});
    }
    const provider=payment.payment_provider_data || {};
    const refunds=Array.isArray(payment.payment_refunds)?payment.payment_refunds:[];
    const lastRefund=refunds.slice().sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at)))[0] || null;
    const meta=payment.metadata || {};

    return res.json({
      success:true,
      paymentId:payment.id,
      orderId:payment.partner_order_id || null,
      terminalId:payment.partner_terminal_id || null,
      bankOrderId:provider.provider_order_id || null,
      status:legacyPaymentStatus(payment,lastRefund),
      paymentType:'CARD',
      paymentPurpose:meta.paymentPurpose || null,
      amount:Number(payment.amount_minor),
      accountCurrency:payment.account_currency || 'RUB',
      amountCurrencyMinor:Number(payment.amount_currency_minor),
      effectiveCurrencyRateRub:payment.effective_currency_rate_rub_snapshot || null,
      createdAt:payment.created_at,
      updatedAt:payment.updated_at,
      paidAt:payment.paid_at || provider.provider_trx_time || null,
      trxId:provider.provider_trx_id || payment.provider_payment_id || null,
      refundStatus:lastRefund?.status || null,
      refundAmount:lastRefund?Number(lastRefund.amount_minor):null,
      refundCompletedAt:lastRefund?.completed_at || null,
    });
  }catch(error){return next(error);}
});

router.all('/',(req,res)=>res.status(405).json({
  success:false,error:'METHOD_NOT_ALLOWED',message:'Разрешён только POST запрос',
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
  return status;
}

function amountLimitError(res,detail){
  return res.status(400).json({
    success:false,
    error:'VALIDATION_ERROR',
    message:'Сумма не соответствует лимитам карточного терминала',
    details:[detail],
  });
}

module.exports=router;
