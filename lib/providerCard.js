const { findBankById } = require('./legacyBankAdapter');

async function executeCardPayment({ payment, runtime, input }) {
  const bank=await findBankById(runtime.bankId);
  if(!bank){
    const error=new Error('Для терминала не настроен банк');
    error.code='BANK_NOT_CONFIGURED';
    throw error;
  }
  if(bank.provider_code!=='ingo'){
    const error=new Error('Карточная оплата недоступна на выбранном терминале');
    error.code='CARD_BANK_NOT_SUPPORTED';
    error.statusCode=400;
    throw error;
  }

  const cfg=runtime.providerConfig || {};
  const username=cfg.ingo_api_username || bank.api_username;
  const password=cfg.ingo_api_password || bank.api_password;
  const merchantLogin=cfg.ingo_merchant_login || null;
  if(!bank.api_base_url || !username || !password || !merchantLogin){
    const error=new Error('Карточный терминал настроен не полностью');
    error.code='TERMINAL_NOT_CONFIGURED';
    error.statusCode=400;
    error.details=[
      !username?'Не задан ingo_api_username':null,
      !password?'Не задан ingo_api_password':null,
      !merchantLogin?'Не задан ingo_merchant_login':null,
    ].filter(Boolean);
    throw error;
  }

  const paymentId=String(payment.id);
  const orderNumber=`wc-${paymentId}`.slice(0,36);
  const callbackBase=String(process.env.PUBLIC_API_URL || process.env.API_PUBLIC_URL || '').replace(/\/$/,'');
  const defaultReturnUrl=process.env.INGO_RETURN_URL || `${callbackBase}/`;
  const returnUrl=input.redirectUrl || defaultReturnUrl;
  const failUrl=process.env.INGO_FAIL_URL || defaultReturnUrl;
  const dynamicCallbackUrl=callbackBase ? `${callbackBase}/webhook/ingo` : undefined;

  const form=new URLSearchParams();
  const fields={
    userName:username,
    password,
    orderNumber,
    amount:Number(input.amountMinor),
    currency:'643',
    returnUrl,
    failUrl,
    dynamicCallbackUrl,
    description:input.paymentPurpose || `Оплата ${orderNumber}`,
    language:'ru',
    merchantLogin,
  };
  for(const [key,value] of Object.entries(fields)){
    if(value!==undefined && value!==null && value!=='') form.append(key,String(value));
  }

  const response=await fetch(`${String(bank.api_base_url).replace(/\/$/,'')}/rest/register.do`,{
    method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},
    body:form.toString(),
    signal:AbortSignal.timeout(Number(process.env.CARD_GATEWAY_TIMEOUT_MS || 30000)),
  });

  const raw=await response.text();
  let parsed;
  try{parsed=raw?JSON.parse(raw):{};}catch{parsed={rawBody:raw};}
  const applicationError=parsed.errorCode!=null && String(parsed.errorCode)!=='0';
  if(!response.ok || applicationError){
    const error=new Error('Банк не зарегистрировал карточный платёж');
    error.statusCode=response.status;
    error.responseBody=parsed;
    throw error;
  }

  const bankOrderId=parsed.orderId || parsed.data?.orderId || null;
  const formUrl=parsed.formUrl || parsed.data?.formUrl || null;
  if(!bankOrderId || !formUrl){
    const error=new Error('Ingo не вернул orderId или formUrl');
    error.responseBody=parsed;
    throw error;
  }

  return {bankOrderId,formUrl,orderNumber,regTime:new Date().toISOString(),returnUrl,failUrl,registration:parsed};
}

module.exports={executeCardPayment};
