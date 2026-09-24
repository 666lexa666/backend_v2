const express=require('express');
const { processGenericBankWebhook, processIngoWebhook }=require('../lib/bankWebhookProcessor');

const router=express.Router();
const ingoParser=express.urlencoded({
  extended:false,
  limit:'1mb',
  verify(req,res,buf){ req.ingoRawBody=buf?.toString('utf8') || ''; },
});

router.all('/ingo', ingoParser, async (req,res)=>{
  try {
    const result=await processIngoWebhook({
      method:req.method,
      query:req.query || {},
      body:req.body || {},
      rawBody:req.ingoRawBody || req.rawBody || '',
    });
    return res.status(result.statusCode).send(result.text);
  } catch (error) {
    console.error('Ошибка endpoint /webhook/ingo:',error);
    return res.status(500).send('PROCESSING_ERROR');
  }
});

router.post('/', async (req,res)=>{
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
  } catch (error) {
    console.error('Ошибка endpoint /webhook:',error);
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
