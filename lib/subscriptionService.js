const https = require('node:https');
const { getSupabaseAdminClient } = require('./supabase');
const { findBankById } = require('./legacyBankAdapter');
const {
  createPaymentCore,
  setPaymentProviderResult,
  markPaymentFailed,
  loadTerminalRuntime,
} = require('./paymentCore');
const { executeQrPayment } = require('./providerQr');

async function findSubscriptionInstrument({ partnerId, subscriptionQrcId = null, instrumentId = null, customerId = null }) {
  const db = getSupabaseAdminClient();

  let query = db
    .from('checkout_subscription_instruments')
    .select('*')
    .eq('partner_id', partnerId)
    .eq('payment_method', 'SBP')
    .eq('status', 'active');

  if (instrumentId) query = query.eq('id', instrumentId);
  else if (subscriptionQrcId) query = query.eq('subscription_qrc_id', subscriptionQrcId);
  else return null;

  if (customerId) {
    const { data: customer, error: customerError } = await db
      .from('checkout_customers')
      .select('id')
      .eq('partner_id', partnerId)
      .eq('partner_customer_id', customerId)
      .maybeSingle();
    if (customerError) throw customerError;
    if (!customer) {
      const error = new Error('Клиент с таким customerId не найден');
      error.statusCode = 404;
      error.code = 'CUSTOMER_NOT_FOUND';
      throw error;
    }
    query = query.eq('customer_id', customer.id);
  } else {
    query = query.is('customer_id', null);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data || null;
}

async function chargeSbpSubscription({ partner,instrument,amount,paymentPurpose,orderId=null,apiVersion='v2' }) {
  if (!instrument?.partner_terminal_id) {
    const error=new Error('У инструмента подписки не сохранен исходный терминал. Создайте подписку заново');
    error.statusCode=409; error.code='INSTRUMENT_TERMINAL_NOT_SET'; throw error;
  }

  const runtime=await loadTerminalRuntime({ id:instrument.partner_terminal_id });
  if (!runtime) {
    const error=new Error('Исходный терминал подписки не найден');
    error.statusCode=409; error.code='INSTRUMENT_TERMINAL_UNAVAILABLE'; throw error;
  }

  const input={
    apiVersion,
    partnerId:partner.id,
    amountMinor:amount,
    transactionCurrency:'RUB',
    accountCurrency:partner.account_currency || 'RUB',
    currencyMarkupPercent:partner.currency_markup_percent || 0,
    method:'SBP',
    projectId:instrument.project_id || runtime.projectId || null,
    terminalId:instrument.partner_terminal_id,
    orderId,
    paymentPurpose,
    qrcType:'02',
    expDt:partner.qr_exp_dt ?? 15,
    localExpDt:partner.qr_local_exp_dt ?? 900,
    commissionPercent:partner.commission_percent ?? null,
    legacy:apiVersion==='v1'?{endpoint:'/checkout/subscriptions/charge'}:null,
  };

  const result=await createPaymentCore(input);

  let qrResponse;
  try {
    qrResponse=await executeQrPayment({payment:result.payment,runtime:result.runtime,input});
    await setPaymentProviderResult(result.payment.payment_pk,{
      status:'pending',
      providerOrderId:qrResponse.bankOrderId || null,
      qrcId:qrResponse.qrcId || null,
      qrPayload:qrResponse.payload || null,
    });
  } catch(error) {
    await markPaymentFailed(result.payment.payment_pk,error).catch(()=>{});
    error.publicCode='BANK_QR_REGISTER_FAILED';
    throw error;
  }

  const bank=await findBankById(runtime.bankId);
  if (!bank?.sbp_subscription_pay_url) {
    const error=new Error('У банка не задан sbp_subscription_pay_url');
    error.publicCode='BANK_SUBSCRIPTION_CHARGE_FAILED';
    throw error;
  }

  let bankResponse;
  try {
    bankResponse=await postJsonMtls(bank,bank.sbp_subscription_pay_url,{
      subscriptionQrcId:instrument.subscription_qrc_id,
      payQrcId:qrResponse.qrcId,
      amount,
      paymentPurpose,
    });
  } catch(error) {
    await markPaymentFailed(result.payment.payment_pk,error).catch(()=>{});
    error.publicCode='BANK_SUBSCRIPTION_CHARGE_FAILED';
    throw error;
  }

  return {payment:result.payment,qrResponse,bankResponse,instrument};
}

async function postJsonMtls(bank,endpoint,body) {
  const url=new URL(endpoint);
  const payload=JSON.stringify(body);
  const pfx=Buffer.from(bank.certificate_base64 || '','base64');
  if(!pfx.length) throw new Error('У банка не задан certificate_base64');

  const options={
    protocol:url.protocol,hostname:url.hostname,port:url.port || 443,
    path:`${url.pathname}${url.search}`,method:'POST',pfx,
    passphrase:bank.certificate_password,
    rejectUnauthorized:bank.tls_reject_unauthorized===false?false:true,
    headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),Accept:'application/json'},
    timeout:Number(process.env.BANK_QR_REQUEST_TIMEOUT_MS || 30000),
  };

  return new Promise((resolve,reject)=>{
    const req=https.request(options,(res)=>{
      const chunks=[]; res.on('data',(chunk)=>chunks.push(chunk));
      res.on('end',()=>{
        const raw=Buffer.concat(chunks).toString('utf8');
        let parsed; try{parsed=raw?JSON.parse(raw):{};}catch{parsed={rawBody:raw};}
        if(res.statusCode<200 || res.statusCode>=300){
          const error=new Error(`Bank subscription payment API error: ${res.statusCode}`);
          error.statusCode=res.statusCode; error.responseBody=parsed; return reject(error);
        }
        resolve(parsed);
      });
    });
    req.on('timeout',()=>req.destroy(new Error('Bank subscription payment API timeout')));
    req.on('error',reject); req.write(payload); req.end();
  });
}

module.exports={findSubscriptionInstrument,chargeSbpSubscription};
