const express = require('express');
const { partnerApiAuth } = require('../lib/partnerApiAuth');
const { refundPayment } = require('../lib/refundService');
const { isSandboxPartner,requestSandboxRefund }=require('../lib/sandboxPaymentService');

const router=express.Router();

router.post('/refunds', partnerApiAuth(), async (req,res,next)=>{
  try {
    const paymentId=String(req.body?.paymentId || '').trim();
    const amount=req.body?.amount == null ? null : Number(req.body.amount);
    if (!paymentId) return res.status(400).json({success:false,error:'VALIDATION_ERROR',details:['paymentId обязателен']});

    if(isSandboxPartner(req.partner)){
      const result=await requestSandboxRefund({
        partner:req.partner,
        paymentId,
        amount,
        remitInfo:req.body?.reason || req.body?.remitInfo || null,
      });
      return res.status(202).json({
        success:true,
        refund:{
          id:result.refund.refundRefId,
          paymentId:result.payment.data.id,
          amount:Number(result.refund.amountMinor),
          status:result.refund.status,
          providerRefId:result.refund.refundRefId,
        },
      });
    }

    const result=await refundPayment({
      partner:req.partner,
      paymentId,
      amount,
      remitInfo:req.body?.reason || req.body?.remitInfo || null,
    });

    if (result.existing) {
      return res.status(202).json({
        success:true,
        refund:{
          id:result.refund.id,
          paymentId:result.payment.id,
          amount:Number(result.refund.amount_minor),
          status:result.refund.status,
        },
      });
    }

    return res.status(result.bankResponse?.statusCode===202?202:201).json({
      success:true,
      refund:{
        id:result.refund.id,
        paymentId:result.payment.id,
        amount:Number(result.refund.amount_minor),
        status:result.refund.status,
        providerRefId:result.refund.provider_ref_id || null,
      },
    });
  } catch (error) {
    if (error.statusCode && error.code) {
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

module.exports=router;
