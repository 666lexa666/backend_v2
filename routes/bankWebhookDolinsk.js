const express=require('express');
const { processGenericBankWebhook }=require('../lib/bankWebhookProcessor');

const router=express.Router();

router.post('/',async(req,res)=>{
  try {
    const result=await processGenericBankWebhook({
      providerCode:'mtls_json',
      headers:{
        xLegalEntityId:req.headers['x-legalentityid'] || null,
        xMerchantId:req.headers['x-merchantid'] || null,
      },
      body:req.body || {},
    });
    return res.status(result.statusCode).json(result.body);
  } catch(error) {
    console.error('Ошибка endpoint /webhook-dolinsk:',error);
    return res.status(500).json({
      success:false,
      error:'WEBHOOK_PROCESSING_ERROR',
      message:'Внутренняя ошибка обработки webhook',
    });
  }
});

router.all('/',(req,res)=>res.status(405).json({
  success:false,
  error:'METHOD_NOT_ALLOWED',
  message:'Разрешен только POST запрос',
}));

module.exports=router;
