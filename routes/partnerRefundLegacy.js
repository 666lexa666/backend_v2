const express = require('express');
const { partnerApiAuth } = require('../lib/partnerApiAuth');
const { refundPayment } = require('../lib/refundService');
const { isSandboxPartner,requestSandboxRefund }=require('../lib/sandboxPaymentService');

const router = express.Router();

router.post('/', partnerApiAuth(), async (req,res,next)=>{
  try {
    const paymentId = req.body?.paymentId == null ? '' : String(req.body.paymentId).trim();
    const amount = req.body?.amount === undefined || req.body?.amount === null || req.body?.amount === ''
      ? null
      : Number(req.body.amount);
    const remitInfo = req.body?.remitInfo == null ? null : String(req.body.remitInfo).trim();
    const errors=[];

    if (!paymentId) errors.push('paymentId обязателен');
    else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(paymentId)) errors.push('paymentId должен быть UUID');

    if (amount !== null && (!Number.isSafeInteger(amount) || amount <= 0 || String(amount).length > 12)) {
      errors.push('amount должен быть целым числом в копейках от 1 до 12 цифр');
    }
    if (remitInfo && remitInfo.length > 140) errors.push('remitInfo не должен быть длиннее 140 символов');

    if (errors.length) {
      return res.status(400).json({
        success:false,
        error:'VALIDATION_ERROR',
        message:'Некорректные параметры запроса возврата',
        details:errors,
      });
    }

    try {
      if(isSandboxPartner(req.partner)){
        const result=await requestSandboxRefund({partner:req.partner,paymentId,amount,remitInfo});
        return res.status(202).json({
          success:true,
          paymentId:result.payment.data.id,
          status:'refund_requested',
          refundRefId:result.refund.refundRefId,
          internalTxId:result.refund.internalTxId,
          amount:Number(result.refund.amountMinor),
          bankStatusCode:202,
          refundBankStatus:null,
          message:'Возврат запрошен',
        });
      }

      const result=await refundPayment({partner:req.partner,paymentId,amount,remitInfo});
      if (result.existing) return res.status(202).json(result.response);

      const bankResponse=result.bankResponse || {statusCode:200,body:{}};
      const body=bankResponse.body || {};
      return res.status(bankResponse.statusCode===202?202:200).json({
        success:true,
        paymentId:result.payment.id,
        status:'refund_requested',
        refundRefId:result.refund.provider_ref_id || null,
        internalTxId:result.refund.metadata?.internalTxId || null,
        amount:Number(result.refund.amount_minor),
        bankStatusCode:bankResponse.statusCode,
        refundBankStatus:body.status ?? null,
        message:'Возврат запрошен',
      });
    } catch (error) {
      if (error.code==='PAYMENT_NOT_FOUND') {
        return res.status(404).json({
          success:false,
          error:'PAYMENT_NOT_FOUND',
          message:'Платеж не найден или не принадлежит этому партнеру',
        });
      }
      if (error.code==='REFUND_NOT_ALLOWED') {
        return res.status(400).json({
          success:false,
          error:'REFUND_NOT_ALLOWED',
          message:'Возврат по этому платежу невозможен',
          details:error.details || [],
        });
      }
      if (error.code==='BANK_REFUND_FAILED') {
        return res.status(502).json({
          success:false,
          error:'BANK_REFUND_FAILED',
          message:'Банк отклонил запрос на возврат',
          paymentId:error.paymentId,
          refundRefId:error.refundRefId,
          internalTxId:error.internalTxId,
          bankStatusCode:error.bankStatusCode,
        });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

router.all('/',(req,res)=>res.status(405).json({
  success:false,
  error:'METHOD_NOT_ALLOWED',
  message:'Разрешен только POST запрос',
}));

module.exports=router;
