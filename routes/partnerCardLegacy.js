const express=require('express');
const { partnerApiAuth }=require('../lib/partnerApiAuth');
const { createPaymentCore,getPartnerPayment,setPaymentProviderResult,markPaymentFailed }=require('../lib/paymentCore');
const { executeCardPayment }=require('../lib/providerCard');

const router=express.Router();

router.post('/',partnerApiAuth(),async(req,res,next)=>{
  try{
    const amount=req.body?.amount;
    const paymentPurpose=String(req.body?.paymentPurpose || req.body?.description || '').trim();
    const webhookUrl=req.body?.webhookUrl==null?'':String(req.body.webhookUrl).trim();
    const redirectUrl=req.body?.redirectUrl || req.partner.redirect_url || null;
    const orderId=req.body?.orderId==null?null:String(req.body.orderId).trim();
    const errors=[];

    if(!/^\d{1,12}$/.test(String(amount??'')) || Number(amount)<=0) errors.push('amount должен быть целым числом в копейках от 1 до 12 цифр');
    if(!paymentPurpose) errors.push('paymentPurpose обязателен');
    if(paymentPurpose.length>140) errors.push('paymentPurpose не должен быть длиннее 140 символов');
    if(webhookUrl && !isAsciiHttpUrl(webhookUrl)) errors.push('webhookUrl должен быть корректным HTTP(S) URL длиной не более 2048 символов');
    if(redirectUrl && !isAsciiHttpUrl(redirectUrl)) errors.push('redirectUrl должен быть корректным ASCII HTTP(S) URL длиной не более 1024 символов');
    if(errors.length) return res.status(400).json({
      success:false,error:'VALIDATION_ERROR',message:'Некорректные параметры карточного платежа',details:errors,
    });

    const input={
      apiVersion:'v1',
      partnerId:req.partner.id,
      amountMinor:Number(amount),
      currency:req.partner.account_currency || 'RUB',
      method:'CARD',
      projectId:req.body?.projectId || null,
      terminalId:req.body?.terminalId || null,
      orderId,
      paymentPurpose,
      webhookUrl:webhookUrl || null,
      redirectUrl,
      commissionPercent:req.partner.commission_percent ?? null,
      currencyRateRub:req.partner.latest_currency_rate_rub || 1,
      legacy:{endpoint:'/card'},
    };

    let result;
    try{
      result=await createPaymentCore(input);
    }catch(error){
      if(error.code==='TERMINAL_NOT_AVAILABLE'){
        return res.status(400).json({
          success:false,
          error:'CARD_TERMINAL_NOT_FOUND',
          message:req.body?.terminalId
            ? 'terminalId не найден, не принадлежит партнёру или выключен'
            : (req.partner.terminal_auto_distribution_enabled
              ? 'Сумма не подходит под лимиты ни одного активного карточного терминала, участвующего в автораспределении'
              : 'У партнёра не настроен активный карточный терминал по умолчанию'),
        });
      }
      throw error;
    }

    let bankResponse;
    try{
      bankResponse=await executeCardPayment({payment:result.payment,runtime:result.runtime,input});
      await setPaymentProviderResult(result.payment.payment_pk,{
        status:'pending',
        providerOrderId:bankResponse.bankOrderId,
      });
    }catch(error){
      await markPaymentFailed(result.payment.payment_pk,error).catch(()=>{});
      if(error.code==='CARD_BANK_NOT_SUPPORTED'){
        return res.status(400).json({success:false,error:'CARD_BANK_NOT_SUPPORTED',message:'Карточная оплата недоступна на выбранном терминале'});
      }
      if(error.code==='TERMINAL_NOT_CONFIGURED'){
        return res.status(400).json({
          success:false,error:'TERMINAL_NOT_CONFIGURED',message:'Карточный терминал настроен не полностью',details:error.details || [],
        });
      }
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
      accountCurrency:req.partner.account_currency || 'RUB',
      amountCurrencyMinor:Number(amount),
      effectiveCurrencyRateRub:req.partner.latest_currency_rate_rub || 1,
      status:'pending',
    });
  }catch(error){
    return next(error);
  }
});

router.get('/:paymentId/status',partnerApiAuth(),async(req,res,next)=>{
  try{
    const id=String(req.params.paymentId || '');
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)){
      return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'paymentId должен быть UUID'});
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
      status:payment.status,
      paymentType:'CARD',
      paymentPurpose:meta.paymentPurpose || null,
      amount:Number(payment.amount_minor),
      accountCurrency:payment.currency || 'RUB',
      amountCurrencyMinor:Number(payment.amount_minor),
      effectiveCurrencyRateRub:payment.currency_rate_rub_snapshot || null,
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

function isAsciiHttpUrl(value){
  if(String(value).length>2048 || !/^[\x00-\x7F]+$/.test(String(value))) return false;
  try{
    const url=new URL(String(value));
    return url.protocol==='http:' || url.protocol==='https:';
  }catch{return false;}
}

module.exports=router;
