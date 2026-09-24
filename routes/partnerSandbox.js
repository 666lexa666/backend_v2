const express = require('express');
const { partnerApiAuth } = require('../lib/partnerApiAuth');
const {
  isSandboxPartner,
  getSandboxPayment,
  simulateSandboxStatus,
  sandboxV1StatusResponse,
} = require('../lib/sandboxPaymentService');

const router = express.Router();
router.use(partnerApiAuth());

router.use((req,res,next)=>{
  if (!isSandboxPartner(req.partner)) {
    return res.status(404).json({ success:false,error:'NOT_FOUND',message:'Not found' });
  }
  next();
});

router.get('/payments/:id', async (req,res,next)=>{
  try {
    const payment=await getSandboxPayment(req.partner.id,req.params.id);
    if(!payment) return res.status(404).json({success:false,error:'PAYMENT_NOT_FOUND',message:'Платеж не найден'});
    return res.json({success:true,payment:payment.data,v1:sandboxV1StatusResponse(payment)});
  } catch(error){ return next(error); }
});

router.post('/payments/:id/simulate', async (req,res,next)=>{
  try {
    const status=String(req.body?.status || '').trim();
    const payment=await simulateSandboxStatus({
      partnerId:req.partner.id,
      paymentId:req.params.id,
      status,
    });
    if(!payment) return res.status(404).json({success:false,error:'PAYMENT_NOT_FOUND',message:'Платеж не найден'});
    return res.json({success:true,payment:payment.data,v1:sandboxV1StatusResponse(payment)});
  } catch(error){
    if(error.statusCode && error.code){
      return res.status(error.statusCode).json({success:false,error:error.code,message:error.message});
    }
    return next(error);
  }
});

module.exports=router;
