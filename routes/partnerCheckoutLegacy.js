const express=require('express');
const crypto=require('node:crypto');
const { getSupabaseAdminClient }=require('../lib/supabase');
const { partnerApiAuth }=require('../lib/partnerApiAuth');
const { selectTerminalForPayment,loadTerminalRuntime,createPaymentCore,setPaymentProviderResult,markPaymentFailed }=require('../lib/paymentCore');
const { executeQrPayment }=require('../lib/providerQr');
const { findBankById }=require('../lib/legacyBankAdapter');
const { findSubscriptionInstrument,chargeSbpSubscription }=require('../lib/subscriptionService');

const router=express.Router();

router.use((req,res,next)=>{
  res.header('Access-Control-Allow-Origin','*');
  res.header('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers','Content-Type, Authorization, X-API-Key');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});

router.post('/sessions',partnerApiAuth(),async(req,res,next)=>{
  try{
    const db=getSupabaseAdminClient();
    const amount=Math.round(Number(req.body?.amount));
    const isSubscription=Boolean(req.body?.isSubscription ?? req.body?.subscription);
    const customerId=String(req.body?.customerId ?? req.body?.clientId ?? '').trim();
    const paymentPurpose=String(req.body?.paymentPurpose ?? '').trim();
    const subscriptionPurpose=String(req.body?.subscriptionPurpose ?? '').trim();
    const subscriptionServiceId=String(req.body?.subscriptionServiceId ?? '').trim();
    const subscriptionServiceName=String(req.body?.subscriptionServiceName ?? '').trim();
    const orderId=req.body?.orderId==null?null:String(req.body.orderId).trim();
    const requestedTerminalId=req.body?.terminalId || null;
    const errors=[];

    if(!Number.isFinite(amount) || amount<=0) errors.push('amount должен быть положительным целым числом в копейках');
    if(!customerId) errors.push('customerId обязателен');
    if(!paymentPurpose) errors.push('paymentPurpose обязателен');
    if(isSubscription){
      if(!subscriptionPurpose) errors.push('subscriptionPurpose обязателен при isSubscription=true');
      if(!subscriptionServiceId) errors.push('subscriptionServiceId обязателен при isSubscription=true');
      else if(!/^[a-zA-Z0-9]{1,32}$/.test(subscriptionServiceId)) errors.push('subscriptionServiceId должен соответствовать формату банка: только латинские буквы и цифры, 1-32 символа, без подчёркиваний/дефисов/пробелов');
      if(!subscriptionServiceName) errors.push('subscriptionServiceName обязателен при isSubscription=true');
    }
    if(errors.length) return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'Некорректные параметры запроса',details:errors});

    let terminal=await selectTerminalForPayment({
      partnerId:req.partner.id,
      terminalId:requestedTerminalId,
      method:'SBP',
      amountMinor:amount,
    });
    if(!terminal){
      terminal=await selectTerminalForPayment({
        partnerId:req.partner.id,
        terminalId:requestedTerminalId,
        method:'CARD',
        amountMinor:amount,
      });
    }
    if(!terminal){
      return res.status(400).json({
        success:false,error:'VALIDATION_ERROR',message:'Некорректные параметры запроса',
        details:[requestedTerminalId?'terminalId не найден, не принадлежит партнеру или выключен':'У партнера не настроен ни один терминал'],
      });
    }

    const {data:customer,error:customerError}=await db.from('checkout_customers').upsert({
      partner_id:req.partner.id,
      partner_customer_id:customerId,
      updated_at:new Date().toISOString(),
    },{onConflict:'partner_id,partner_customer_id'}).select('id').single();
    if(customerError) throw customerError;

    const {data:session,error:sessionError}=await db.from('checkout_sessions').insert({
      partner_id:req.partner.id,
      project_id:terminal.project_id || null,
      customer_id:customer.id,
      partner_terminal_id:terminal.id || null,
      partner_order_id:orderId,
      amount_minor:amount,
      currency:'RUB',
      is_subscription:isSubscription,
      status:'created',
      payment_method:null,
      payment_purpose:paymentPurpose,
      subscription_purpose:isSubscription?subscriptionPurpose:null,
      subscription_service_id:isSubscription?subscriptionServiceId:null,
      subscription_service_name:isSubscription?subscriptionServiceName:null,
      metadata:{legacy:{apiVersion:'v1'}},
    }).select('id,partner_order_id').single();
    if(sessionError) throw sessionError;

    const baseUrl=String(process.env.CHECKOUT_BASE_URL || 'https://whitecapital.tech').replace(/\/$/,'');
    return res.status(200).json({
      success:true,
      sessionId:session.id,
      orderId:session.partner_order_id || null,
      paymentUrl:`${baseUrl}/pay/${session.id}`,
    });
  }catch(error){return next(error);}
});

router.get('/sessions/:id',async(req,res,next)=>{
  try{
    const db=getSupabaseAdminClient();
    const {data:session,error}=await db.from('checkout_sessions').select('*').eq('id',req.params.id).maybeSingle();
    if(error) throw error;
    if(!session) return res.status(404).json({success:false,error:'SESSION_NOT_FOUND',message:'Платежная сессия не найдена'});

    const {data:partner}=await db.from('partners').select('*').eq('id',session.partner_id).maybeSingle();
    const runtime=session.partner_terminal_id?await loadTerminalRuntime({id:session.partner_terminal_id}):null;
    const bank=runtime?.bankId?await findBankById(runtime.bankId):null;

    let resolvedStatus=session.status;
    if(session.payment_pk && session.status!=='canceled'){
      const {data:payment}=await db.from('payments').select('status').eq('payment_pk',session.payment_pk).maybeSingle();
      if(payment){
        if(['success','subscription_confirmed'].includes(payment.status)) resolvedStatus='success';
        else if(['failed','subscription_failed'].includes(payment.status)) resolvedStatus='failed';
        else if(payment.status==='subscription_rejected') resolvedStatus='canceled';
        else if(payment.status==='expired') resolvedStatus='expired';
        else if(['cancel','canceled','cancelled'].includes(payment.status)) resolvedStatus='canceled';
      }
    }

    return res.json({
      success:true,
      session:{
        id:session.id,
        amount:Number(session.amount_minor),
        isSubscription:session.is_subscription,
        paymentPurpose:session.payment_purpose,
        status:resolvedStatus,
        paymentMethod:session.payment_method,
        expiresAt:session.expires_at,
      },
      merchant:{
        name:runtime?.companyName || partner?.company_name || null,
        redirectUrl:partner?.redirect_url || null,
        failureRedirectUrl:partner?.failure_redirect_url || null,
      },
      paymentMethods:resolvePaymentMethods(partner,bank,runtime),
    });
  }catch(error){return next(error);}
});

router.post('/sessions/:id/sbp',async(req,res)=>{
  try{
    const db=getSupabaseAdminClient();
    const loaded=await loadOpenSession(req.params.id);
    if(loaded.error) return res.status(loaded.error.status).json(loaded.error.body);
    const {session,partner}=loaded;
    const runtime=session.partner_terminal_id?await loadTerminalRuntime({id:session.partner_terminal_id}):null;
    if(!runtime) return res.status(500).json({success:false,error:'INTERNAL_ERROR',message:'У партнера не настроен ни один терминал'});
    if(String(runtime.paymentMethod).toUpperCase()!=='SBP'){
      return res.status(400).json({success:false,error:'TERMINAL_PAYMENT_METHOD_MISMATCH',message:'Карточный терминал нельзя использовать для создания QR'});
    }

    const bank=runtime.bankId?await findBankById(runtime.bankId):null;
    if(!bank || !['sbp','both'].includes(resolvePaymentMethods(partner,bank,runtime))){
      return res.status(400).json({success:false,error:'METHOD_NOT_ALLOWED',message:'Оплата СБП недоступна для этого мерчанта'});
    }

    await saveDeviceData(session,'sbp',req.body,req);

    const input={
      apiVersion:'v1',
      partnerId:partner.id,
      amountMinor:Number(session.amount_minor),
      currency:session.currency || 'RUB',
      method:'SBP',
      projectId:session.project_id || null,
      terminalId:session.partner_terminal_id,
      orderId:session.partner_order_id || null,
      paymentPurpose:session.payment_purpose,
      qrcType:session.is_subscription?'03':'02',
      expDt:15,
      localExpDt:900,
      subscriptionPurpose:session.subscription_purpose || null,
      subscriptionServiceId:session.subscription_service_id || null,
      subscriptionServiceName:session.subscription_service_name || null,
      commissionPercent:partner.commission_percent ?? null,
      currencyRateRub:partner.settings?.latest_currency_rate_rub || 1,
      legacy:{endpoint:'/checkout/sessions/:id/sbp',sessionId:session.id},
    };

    const result=await createPaymentCore(input);
    let bankResponse;
    try{
      bankResponse=await executeQrPayment({payment:result.payment,runtime:result.runtime,input});
      await setPaymentProviderResult(result.payment.payment_pk,{
        status:'pending',
        providerOrderId:bankResponse.bankOrderId || null,
        qrcId:bankResponse.qrcId || null,
        qrPayload:bankResponse.payload || null,
      });
    }catch(error){
      await markPaymentFailed(result.payment.payment_pk,error).catch(()=>{});
      return res.status(502).json({success:false,error:'BANK_QR_REGISTER_FAILED',message:'Банк не зарегистрировал QR-код',bankStatusCode:error.statusCode || null});
    }

    const {error:updateError}=await db.from('checkout_sessions').update({
      status:'pending_sbp',
      payment_method:'SBP',
      payment_pk:result.payment.payment_pk,
      metadata:{
        ...(session.metadata || {}),
        sbpQrcId:bankResponse.qrcId || null,
        sbpPayload:bankResponse.payload || null,
        sbpRegisteredAt:new Date().toISOString(),
      },
      updated_at:new Date().toISOString(),
    }).eq('id',session.id);
    if(updateError) throw updateError;

    return res.json({
      success:true,
      orderId:result.payment.partner_order_id || null,
      payload:bankResponse.payload,
      qrcId:bankResponse.qrcId,
      expDt:bankResponse.expDt,
      localExpDt:bankResponse.localExpDt,
    });
  }catch(error){
    console.error('Ошибка регистрации СБП QR для checkout-сессии:',error);
    return res.status(502).json({success:false,error:'BANK_QR_REGISTER_FAILED',message:'Банк не зарегистрировал QR-код',bankStatusCode:error.statusCode || null});
  }
});

router.post('/sessions/:id/card/init',async(req,res,next)=>{
  try{
    const loaded=await loadOpenSession(req.params.id);
    if(loaded.error) return res.status(loaded.error.status).json(loaded.error.body);
    const {session,partner}=loaded;
    const runtime=session.partner_terminal_id?await loadTerminalRuntime({id:session.partner_terminal_id}):null;
    if(!runtime) return res.status(500).json({success:false,error:'INTERNAL_ERROR',message:'У партнера не настроен ни один терминал'});
    if(String(runtime.paymentMethod).toUpperCase()!=='CARD'){
      return res.status(400).json({success:false,error:'TERMINAL_PAYMENT_METHOD_MISMATCH',message:'СБП-терминал нельзя использовать для карточного платежа'});
    }

    const bank=runtime.bankId?await findBankById(runtime.bankId):null;
    if(!bank || !['card','both'].includes(resolvePaymentMethods(partner,bank,runtime))){
      return res.status(400).json({success:false,error:'METHOD_NOT_ALLOWED',message:'Оплата картой недоступна для этого мерчанта'});
    }
    if(!bank.card_init_url){
      return res.status(500).json({success:false,error:'INTERNAL_ERROR',message:'У банка не настроен карточный протокол'});
    }

    const card=req.body?.card || {};
    const errors=[];
    if(!card.pan || !/^\d{12,19}$/.test(String(card.pan))) errors.push('card.pan обязателен и должен быть 12-19 цифр');
    if(!card.expDate || !/^\d{6}$/.test(String(card.expDate))) errors.push('card.expDate обязателен, формат YYYYMM');
    if(!card.cvv || !/^\d{3,4}$/.test(String(card.cvv))) errors.push('card.cvv обязателен, 3-4 цифры');
    if(errors.length) return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'Некорректные данные карты',details:errors});

    const device=await saveDeviceData(session,'card',req.body,req);
    const bankResponse=await initLegacyCardGateway(bank,{
      terminal_id:runtime.merchantId,
      order_id:session.id,
      amount:Number(session.amount_minor),
      payment_method:'CARD',
      subscription_required:Boolean(session.is_subscription),
      card_data:{pan:String(card.pan),exp_date:String(card.expDate),cvv:String(card.cvv)},
      card_token:crypto.randomUUID(),
      device_data:{
        window_size:device.window_size || '02',
        user_ip:device.user_ip || '0.0.0.0',
        accept_header:device.accept_header || '*/*',
        java_enabled:device.java_enabled,
        lang:device.lang || 'ru',
        color_depth:device.color_depth || '24',
        screen_height:String(device.screen_height || 0),
        screen_width:String(device.screen_width || 0),
        timezone:device.timezone || '0',
        user_agent:device.user_agent || '',
      },
      ...(req.body?.payer?.name?{name:String(req.body.payer.name)}:{}),
      ...(req.body?.payer?.email?{email:String(req.body.payer.email)}:{}),
      ...(req.body?.payer?.phone?{phone_number:String(req.body.payer.phone)}:{}),
    });

    const result=await createPaymentCore({
      apiVersion:'v1',
      partnerId:partner.id,
      amountMinor:Number(session.amount_minor),
      currency:session.currency || 'RUB',
      method:'CARD',
      projectId:session.project_id || null,
      terminalId:session.partner_terminal_id,
      orderId:session.partner_order_id || null,
      paymentPurpose:session.payment_purpose,
      commissionPercent:partner.commission_percent ?? null,
      legacy:{endpoint:'/checkout/sessions/:id/card/init',sessionId:session.id},
    });
    await setPaymentProviderResult(result.payment.payment_pk,{
      status:'pending',
      providerPaymentId:bankResponse.payment_id || null,
      providerOrderId:bankResponse.order_id || null,
    });

    const db=getSupabaseAdminClient();
    const {error:updateError}=await db.from('checkout_sessions').update({
      status:'pending_card',
      payment_method:'CARD',
      payment_pk:result.payment.payment_pk,
      metadata:{
        ...(session.metadata || {}),
        cardGatewayPaymentId:bankResponse.payment_id || null,
        cardLast4:String(card.pan).slice(-4),
        cardStatus:bankResponse.payment_status || null,
        cardThreeDsServerTransId:bankResponse['3ds']?.three_ds_server_trans_id || null,
      },
      updated_at:new Date().toISOString(),
    }).eq('id',session.id);
    if(updateError) throw updateError;

    return res.json({
      success:true,
      paymentId:result.payment.id,
      orderId:result.payment.partner_order_id || null,
      paymentStatus:bankResponse.payment_status,
      threeDs:bankResponse['3ds'] || null,
    });
  }catch(error){
    if(error.responseBody) return res.status(502).json({success:false,error:'CARD_GATEWAY_ERROR',message:'Банк отклонил инициализацию платежа',bankResponse:error.responseBody});
    return next(error);
  }
});

router.post('/sessions/:id/cancel',async(req,res,next)=>{
  try{
    const db=getSupabaseAdminClient();
    const {data,error}=await db.from('checkout_sessions').update({
      status:'canceled',
      updated_at:new Date().toISOString(),
    }).eq('id',req.params.id).in('status',['created','pending_sbp','pending_card']).select('id');
    if(error) throw error;
    if(!data || !data.length) return res.status(400).json({success:false,error:'SESSION_NOT_OPEN',message:'Сессию уже нельзя отменить — она не в открытом статусе'});
    return res.json({success:true,status:'canceled'});
  }catch(error){return next(error);}
});

router.post('/subscriptions/charge',partnerApiAuth(),async(req,res,next)=>{
  try{
    const amount=Math.round(Number(req.body?.amount));
    const customerId=req.body?.customerId==null?'':String(req.body.customerId).trim();
    const paymentPurpose=String(req.body?.paymentPurpose ?? '').trim();
    const subscriptionQrcId=req.body?.subscriptionQrcId?String(req.body.subscriptionQrcId).trim():null;
    const cardToken=req.body?.cardToken?String(req.body.cardToken).trim():null;
    const orderId=req.body?.orderId==null?null:String(req.body.orderId).trim();
    const errors=[];
    if(!Number.isFinite(amount) || amount<=0) errors.push('amount должен быть положительным целым числом в копейках');
    if(!paymentPurpose) errors.push('paymentPurpose обязателен');
    if(!subscriptionQrcId && !cardToken) errors.push('нужно указать subscriptionQrcId (для СБП) или cardToken (для карты)');
    if(subscriptionQrcId && cardToken) errors.push('укажите только один инструмент — subscriptionQrcId ИЛИ cardToken, не оба сразу');
    if(errors.length) return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'Некорректные параметры запроса',details:errors});

    if(cardToken) return res.status(404).json({success:false,error:'INSTRUMENT_NOT_FOUND',message:'Инструмент подписки не найден, не активен, либо не принадлежит этому клиенту'});

    const instrument=await findSubscriptionInstrument({
      partnerId:req.partner.id,
      subscriptionQrcId,
      customerId:customerId || null,
    });
    if(!instrument) return res.status(404).json({success:false,error:'INSTRUMENT_NOT_FOUND',message:'Инструмент подписки не найден, не активен, либо не принадлежит этому клиенту'});

    try{
      const result=await chargeSbpSubscription({partner:req.partner,instrument,amount,paymentPurpose,orderId,apiVersion:'v1'});
      return res.json({
        success:true,
        paymentId:result.payment.id,
        orderId:result.payment.partner_order_id || null,
        qrcId:result.qrResponse.qrcId,
        bankResponse:result.bankResponse,
      });
    }catch(error){
      if(['INSTRUMENT_TERMINAL_NOT_SET','INSTRUMENT_TERMINAL_UNAVAILABLE'].includes(error.code)){
        return res.status(409).json({success:false,error:error.code,message:error.message});
      }
      if(error.publicCode==='BANK_QR_REGISTER_FAILED') return res.status(502).json({success:false,error:'BANK_QR_REGISTER_FAILED',message:'Банк не зарегистрировал QR для списания',bankStatusCode:error.statusCode || null});
      if(error.publicCode==='BANK_SUBSCRIPTION_CHARGE_FAILED') return res.status(502).json({success:false,error:'BANK_SUBSCRIPTION_CHARGE_FAILED',message:'Банк отклонил списание по подписке',bankResponse:error.responseBody || null});
      throw error;
    }
  }catch(error){return next(error);}
});

async function loadOpenSession(id){
  const db=getSupabaseAdminClient();
  const {data:session,error}=await db.from('checkout_sessions').select('*').eq('id',id).maybeSingle();
  if(error) throw error;
  if(!session) return {error:{status:404,body:{success:false,error:'SESSION_NOT_FOUND',message:'Платежная сессия не найдена'}}};
  if(session.status!=='created') return {error:{status:400,body:{success:false,error:'SESSION_NOT_OPEN',message:`Сессия уже в статусе ${session.status}`}}};
  const {data:partner,error:partnerError}=await db.from('partners').select('*').eq('id',session.partner_id).maybeSingle();
  if(partnerError) throw partnerError;
  return {session,partner};
}

function resolvePaymentMethods(partner,bank,runtime){
  if(runtime?.settings?.payment_form_enabled===false) return 'disabled';
  const configured=runtime?.settings?.checkout_payment_methods
    || partner?.settings?.checkout_payment_methods
    || bank?.payment_methods
    || 'sbp';
  const normalized=Array.isArray(configured)?configured.map(String):String(configured).split(',').map((x)=>x.trim());
  const method=String(runtime?.paymentMethod || '').toUpperCase();
  if(method==='CARD') return normalized.includes('card') || normalized.includes('both') || normalized.includes('CARD') ? 'card':'disabled';
  return normalized.includes('sbp') || normalized.includes('both') || normalized.includes('SBP') ? 'sbp':'disabled';
}

async function saveDeviceData(session,triggeredBy,body,req){
  const db=getSupabaseAdminClient();
  const device=body?.device || body?.deviceData || {};
  const record={
    customer_id:session.customer_id,
    session_id:session.id,
    window_size:device.windowSize || device.window_size || null,
    user_ip:req.ip || null,
    accept_header:req.headers.accept || null,
    java_enabled:Boolean(device.javaEnabled ?? device.java_enabled),
    lang:device.lang || req.headers['accept-language'] || null,
    color_depth:device.colorDepth || device.color_depth || null,
    screen_height:Number(device.screenHeight || device.screen_height || 0) || null,
    screen_width:Number(device.screenWidth || device.screen_width || 0) || null,
    timezone:device.timezone==null?null:String(device.timezone),
    user_agent:req.headers['user-agent'] || null,
    triggered_by:triggeredBy,
  };
  const {data,error}=await db.from('checkout_customer_devices').insert(record).select('*').single();
  if(error) throw error;
  return data;
}

async function initLegacyCardGateway(bank,requestBody){
  const https=require('node:https');
  const fs=require('node:fs');
  const os=require('node:os');
  const path=require('node:path');
  const {execFileSync}=require('node:child_process');
  const url=new URL(bank.card_init_url);
  const payload=JSON.stringify(requestBody);
  const tmp=path.join(os.tmpdir(),`wc-${crypto.randomUUID()}.p12`);
  fs.writeFileSync(tmp,Buffer.from(bank.certificate_base64,'base64'));
  let pem;
  try{
    const out=execFileSync('openssl',['pkcs12','-in',tmp,'-nocerts','-nodes','-passin','stdin'],{
      input:bank.certificate_password,encoding:'utf8',
    });
    const match=out.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/);
    if(!match) throw new Error('Не удалось извлечь приватный ключ');
    pem=match[0];
  }finally{
    try{fs.unlinkSync(tmp);}catch{}
  }

  const signer=crypto.createSign('RSA-SHA256');
  signer.update(payload,'utf8');
  signer.end();
  const signature=signer.sign(pem,'base64');
  const requestId=crypto.randomUUID();

  return new Promise((resolve,reject)=>{
    const req=https.request({
      protocol:url.protocol,hostname:url.hostname,port:url.port || 443,path:`${url.pathname}${url.search}`,
      method:'POST',
      pfx:Buffer.from(bank.certificate_base64,'base64'),
      passphrase:bank.certificate_password,
      rejectUnauthorized:bank.tls_reject_unauthorized===false?false:true,
      headers:{
        'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),Accept:'application/json',
        'X-Request-Id':requestId,Signature:signature,
      },
      timeout:Number(process.env.CARD_GATEWAY_TIMEOUT_MS || 30000),
    },(res)=>{
      const chunks=[];res.on('data',(c)=>chunks.push(c));res.on('end',()=>{
        const raw=Buffer.concat(chunks).toString('utf8');
        let parsed;try{parsed=raw?JSON.parse(raw):{};}catch{parsed={rawBody:raw};}
        if(res.statusCode<200 || res.statusCode>=300){
          const error=new Error(`Card gateway error: ${res.statusCode}`);
          error.statusCode=res.statusCode;error.responseBody=parsed;return reject(error);
        }
        resolve(parsed);
      });
    });
    req.on('timeout',()=>req.destroy(new Error('Card gateway timeout')));
    req.on('error',reject);req.write(payload);req.end();
  });
}

module.exports=router;
