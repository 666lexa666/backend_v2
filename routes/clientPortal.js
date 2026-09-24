const express = require('express');
const {
  createSession,
  revokeSession,
  auth,
  verifyLogin,
} = require('../lib/auth');
const {
  sha256,
  randomToken,
  randomDigits,
  addMinutes,
  hashPassword,
  verifyPassword,
  normalizeEmail,
  isEmail,
  validatePassword,
} = require('../lib/security');
const { getSupabaseAdminClient } = require('../lib/supabase');
const { portalPartner } = require('../lib/portalPartner');
const { hydrateLegacyPartner } = require('../lib/partnerApiAuth');
const { sendEmailCode } = require('../lib/email');
const {
  createPaymentCore,
  setPaymentProviderResult,
  markPaymentFailed,
} = require('../lib/paymentCore');
const { executeQrPayment } = require('../lib/providerQr');
const { refundPayment } = require('../lib/refundService');
const { previewPartnerPayout } = require('../lib/payoutService');

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const login = normalizeEmail(req.body?.email || req.body?.login);
    const password = String(req.body?.password || '');
    if (!isEmail(login) || !password) {
      return res.status(400).json({ success:false,error:'VALIDATION_ERROR',message:'Введите email и пароль' });
    }
    const partner = await verifyLogin(login, password);
    if (!partner) return res.status(401).json({ success:false,error:'INVALID_CREDENTIALS',message:'Неверный email или пароль' });
    if (!partner.email_verified_at) return res.status(403).json({ success:false,error:'EMAIL_NOT_VERIFIED',message:'Email не подтвержден' });

    const session = await createSession(partner.id, Number(process.env.WC_V2_CLIENT_SESSION_DAYS || 7));
    const db = getSupabaseAdminClient();
    await db.from('partners').update({ last_login_at:new Date().toISOString() }).eq('id',partner.id);
    const integrationReady = await hasActiveTerminal(db, partner.id);
    return res.json({
      success:true,
      token:session.token,
      expiresAt:session.expiresAt,
      partner:portalPartner(partner,{integrationReady}),
    });
  } catch (error) { next(error); }
});

router.post('/register', async (req,res,next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const passwordRepeat = String(req.body?.passwordRepeat || req.body?.password_repeat || '');
    const inviteToken = String(req.body?.inviteToken || req.body?.invite_token || '').trim();
    const errors=[];
    if(!isEmail(email)) errors.push('Введите корректный email');
    if(!inviteToken) errors.push('Invite token обязателен');
    if(password!==passwordRepeat) errors.push('Пароли не совпадают');
    errors.push(...validatePassword(password));
    if(errors.length) return res.status(400).json({success:false,error:'VALIDATION_ERROR',details:errors});

    const db=getSupabaseAdminClient();
    const {data:invite,error:inviteError}=await db.from('partner_invites')
      .select('*').eq('token_hash',sha256(inviteToken)).maybeSingle();
    if(inviteError) throw inviteError;
    if(!invite || invite.used_at || new Date(invite.expires_at).getTime()<Date.now() || normalizeEmail(invite.email)!==email){
      return res.status(400).json({success:false,error:'INVALID_INVITE',message:'Invite token не найден, истек или привязан к другому email'});
    }

    const {data:existing,error:existingError}=await db.from('partners')
      .select('id').or(`email.eq.${email},login.eq.${email}`).maybeSingle();
    if(existingError) throw existingError;
    if(existing) return res.status(409).json({success:false,error:'EMAIL_EXISTS',message:'Партнер с таким email уже существует'});

    const code=randomDigits(6);
    const expiresAt=addMinutes(new Date(),Number(process.env.EMAIL_CODE_TTL_MINUTES || 10));
    await db.from('partner_registration_requests').delete().eq('email',email);
    const {error:requestError}=await db.from('partner_registration_requests').insert({
      invite_id:invite.id,
      email,
      password_hash:await hashPassword(password),
      code_hash:sha256(code),
      expires_at:expiresAt,
    });
    if(requestError) throw requestError;
    try {
      await sendEmailCode({to:email,code,purpose:'register'});
    } catch(error) {
      await db.from('partner_registration_requests').delete().eq('email',email).catch(()=>{});
      throw error;
    }
    return res.json({success:true,message:'Код подтверждения отправлен на email'});
  } catch(error){next(error);}
});

router.post('/register/verify', async(req,res,next)=>{
  try{
    const email=normalizeEmail(req.body?.email);
    const code=String(req.body?.code || '').trim();
    const db=getSupabaseAdminClient();
    const {data:request,error}=await db.from('partner_registration_requests').select('*').eq('email',email).maybeSingle();
    if(error) throw error;
    if(!request) return res.status(400).json({success:false,error:'REQUEST_NOT_FOUND',message:'Заявка регистрации не найдена'});
    if(new Date(request.expires_at).getTime()<Date.now()) return res.status(400).json({success:false,error:'CODE_EXPIRED',message:'Код истек'});
    if(Number(request.attempts || 0)>=5) return res.status(429).json({success:false,error:'TOO_MANY_ATTEMPTS',message:'Слишком много попыток'});
    if(sha256(code)!==request.code_hash){
      await db.from('partner_registration_requests').update({attempts:Number(request.attempts || 0)+1}).eq('id',request.id);
      return res.status(400).json({success:false,error:'INVALID_CODE',message:'Неверный код'});
    }

    const {data:invite,error:inviteError}=await db.from('partner_invites').select('*').eq('id',request.invite_id).maybeSingle();
    if(inviteError) throw inviteError;
    if(!invite || invite.used_at || new Date(invite.expires_at).getTime()<Date.now() || normalizeEmail(invite.email)!==email){
      return res.status(400).json({success:false,error:'INVALID_INVITE',message:'Invite token недействителен'});
    }

    const apiKey=randomToken('wc_live_');
    const webhookSecret=randomToken('wcsec_');
    const revealedAt=new Date().toISOString();
    const settings={
      ...(invite.bank_id?{bank_id:invite.bank_id}:{}),
      api_key_revealed_at:revealedAt,
      webhook_secret_revealed_at:revealedAt,
    };
    const {data:partner,error:insertError}=await db.from('partners').insert({
      login:email,
      email,
      password_hash:request.password_hash,
      company_name:invite.company_name || email.split('@')[0],
      api_key_hash:sha256(apiKey),
      api_key_prefix:apiKey.slice(0,12),
      webhook_secret_hash:sha256(webhookSecret),
      webhook_secret_prefix:webhookSecret.slice(0,12),
      email_verified_at:revealedAt,
      is_active:true,
      is_admin:false,
      settings,
    }).select('*').single();
    if(insertError) throw insertError;

    const {error:credentialError}=await db.from('partner_credentials').upsert({
      partner_id:partner.id,
      webhook_secret:webhookSecret,
      migrated_at:revealedAt,
    },{onConflict:'partner_id'});
    if(credentialError) throw credentialError;

    await db.from('partner_projects').insert({
      partner_id:partner.id,
      name:'Проект 1',
      sort_order:0,
      settings:{legacy_balance_enabled:false},
    });
    await db.from('partner_invites').update({used_at:revealedAt,used_by_partner_id:partner.id}).eq('id',invite.id);
    await db.from('partner_registration_requests').delete().eq('id',request.id);

    const session=await createSession(partner.id,Number(process.env.WC_V2_CLIENT_SESSION_DAYS || 7));
    return res.json({
      success:true,
      token:session.token,
      expiresAt:session.expiresAt,
      partner:portalPartner(partner),
      apiKey,
      webhookSecret,
    });
  }catch(error){next(error);}
});

router.post('/forgot-password/request',async(req,res,next)=>{
  try{
    const email=normalizeEmail(req.body?.email);
    const db=getSupabaseAdminClient();
    const {data:partner,error}=await db.from('partners').select('id,email,login').or(`email.eq.${email},login.eq.${email}`).maybeSingle();
    if(error) throw error;
    if(partner) await createAndSendCode(db,partner.id,email,'forgot_password');
    return res.json({success:true,message:'Если email найден, код восстановления отправлен'});
  }catch(error){next(error);}
});

router.post('/forgot-password/confirm',async(req,res,next)=>{
  try{
    const email=normalizeEmail(req.body?.email);
    const code=String(req.body?.code || '').trim();
    const password=String(req.body?.password || '');
    const passwordRepeat=String(req.body?.passwordRepeat || req.body?.password_repeat || '');
    const errors=[];
    if(password!==passwordRepeat) errors.push('Пароли не совпадают');
    errors.push(...validatePassword(password));
    if(errors.length) return res.status(400).json({success:false,error:'VALIDATION_ERROR',details:errors});

    const db=getSupabaseAdminClient();
    const {data:partner,error}=await db.from('partners').select('*').or(`email.eq.${email},login.eq.${email}`).maybeSingle();
    if(error) throw error;
    if(!partner) return res.status(400).json({success:false,error:'INVALID_REQUEST',message:'Неверные данные'});
    const verified=await verifyEmailCode(db,partner.id,email,'forgot_password',code);
    if(!verified.ok) return res.status(verified.status).json(verified.body);
    await db.from('partners').update({password_hash:await hashPassword(password),updated_at:new Date().toISOString()}).eq('id',partner.id);
    await revokeAllPartnerSessions(db,partner.id);
    return res.json({success:true,message:'Пароль изменен. Войдите снова.'});
  }catch(error){next(error);}
});

router.use(auth());

router.post('/logout',async(req,res,next)=>{
  try{await revokeSession(req.sessionToken);return res.json({success:true});}catch(error){next(error);}
});

router.get('/me',async(req,res,next)=>{
  try{
    const db=getSupabaseAdminClient();
    const integrationReady=await hasActiveTerminal(db,req.partner.id);
    return res.json({success:true,partner:portalPartner(req.partner,{integrationReady})});
  }catch(error){next(error);}
});

router.get('/environment',(req,res)=>res.json({
  success:true,
  environment:req.partner.environment || 'production',
  environment_revision:Number(req.partner.environment_revision || 0),
}));

router.get('/projects',async(req,res,next)=>{
  try{
    const db=getSupabaseAdminClient();
    const {data,error}=await db.from('partner_projects')
      .select('id,partner_id,name,sort_order,deposit_enabled,deposit_allow_negative,terminal_auto_distribution_enabled,telegram_daily_report_enabled,telegram_report_thread_id,is_active,created_at,updated_at,settings')
      .eq('partner_id',req.partner.id).is('archived_at',null).order('sort_order').order('created_at');
    if(error) throw error;
    return res.json({
      success:true,
      projects:(data || []).map((row)=>({
        ...row,
        balance_enabled:false,
      })),
    });
  }catch(error){next(error);}
});

router.get('/payments',async(req,res,next)=>{
  try{
    const db=getSupabaseAdminClient();
    const page=Math.max(1,Number(req.query.page || 1));
    const pageSize=Math.min(100,Math.max(1,Number(req.query.pageSize || 25)));
    const from=(page-1)*pageSize;
    const projectId=req.query.projectId?String(req.query.projectId):null;
    const terminalId=req.query.terminalId?String(req.query.terminalId):null;
    const searchField=String(req.query.searchField || req.query.search_field || 'all');
    const q=String(req.query.query || '').trim();

    let query=db.from('portal_payments_v2').select('*',{count:'exact'}).eq('partner_id',req.partner.id);
    if(projectId) query=query.eq('project_id',projectId);
    if(terminalId) query=query.eq('partner_terminal_id',terminalId);
    if(req.query.payment_type) query=query.eq('payment_type',String(req.query.payment_type).toUpperCase());
    if(req.query.status) query=query.eq('status',normalizeInternalStatus(req.query.status));
    if(req.query.from) query=query.gte('created_at',moscowDayStart(String(req.query.from)));
    if(req.query.to) query=query.lt('created_at',moscowDayAfter(String(req.query.to)));
    query=applySearch(query,q,searchField);

    const {data,error,count}=await query.order('created_at',{ascending:false}).order('payment_pk',{ascending:false}).range(from,from+pageSize);
    if(error) throw error;
    const rows=data || [];
    const hasNext=rows.length>pageSize;
    return res.json({
      success:true,
      payments:rows.slice(0,pageSize).map(publicPayment),
      count:Number(count || 0),
      hasNext,
      page,
      pageSize,
    });
  }catch(error){next(error);}
});

router.get('/payments/:id',async(req,res,next)=>{
  try{
    const db=getSupabaseAdminClient();
    const {data,error}=await db.from('portal_payments_v2').select('*')
      .eq('id',req.params.id).eq('partner_id',req.partner.id).maybeSingle();
    if(error) throw error;
    if(!data) return res.status(404).json({success:false,error:'PAYMENT_NOT_FOUND',message:'Платеж не найден'});
    return res.json({success:true,payment:publicPayment(data)});
  }catch(error){next(error);}
});

router.get('/statistics',async(req,res,next)=>{
  try{
    const db=getSupabaseAdminClient();
    const period=normalizePeriod(req.query.period);
    const {start,end}=periodRange(period);
    const projectId=req.query.projectId?String(req.query.projectId):null;
    const tspName=String(req.query.terminalTspName || '').trim();
    const terminalIds=await resolveAnalyticsTerminalIds(db,req.partner.id,projectId,tspName);

    const useHourly=period==='day' || tspName;
    let query=db.from(useHourly?'payment_stats_hourly':'payment_stats_daily')
      .select(useHourly?'bucket_start,status,payment_type,count,amount_minor,partner_terminal_id':'business_day,status,payment_type,count,amount_minor')
      .eq('partner_id',req.partner.id);
    if(projectId) query=query.eq('project_id',projectId);
    if(useHourly){
      query=query.gte('bucket_start',start).lt('bucket_start',end);
      if(tspName) {
        if(!terminalIds.length) return res.json({success:true,stats:emptyStats(),period,from:start,to:end});
        query=query.in('partner_terminal_id',terminalIds);
      }
    } else {
      query=query.gte('business_day',moscowDate(start)).lte('business_day',moscowDate(new Date(new Date(end).getTime()-1)));
    }

    const {data,error}=await query;
    if(error) throw error;

    let refundQuery=db.from('portal_refunds_v2').select('amount_minor')
      .eq('partner_id',req.partner.id).eq('status','confirmed')
      .gte('completed_at',start).lt('completed_at',end);
    if(projectId) refundQuery=refundQuery.eq('project_id',projectId);
    if(tspName && terminalIds.length) refundQuery=refundQuery.in('partner_terminal_id',terminalIds);
    const {data:refundRows,error:refundError}=await refundQuery;
    if(refundError) throw refundError;

    const stats=buildStats(data || [],period,useHourly,refundRows || []);
    return res.json({success:true,stats,period,from:start,to:end});
  }catch(error){next(error);}
});

router.get('/terminal-statistics-options',async(req,res,next)=>{
  try{
    const db=getSupabaseAdminClient();
    let query=db.from('partner_visible_terminals_v2').select('id,company_name,label,is_active')
      .eq('partner_id',req.partner.id);
    if(req.query.projectId) query=query.eq('project_id',String(req.query.projectId));
    const {data,error}=await query;
    if(error) throw error;
    const map=new Map();
    for(const row of data || []){
      const name=String(row.company_name || row.label || '').trim();
      if(!name) continue;
      const current=map.get(name) || {key:name,name,hasCurrentAssignment:false};
      current.hasCurrentAssignment=current.hasCurrentAssignment || row.is_active!==false;
      map.set(name,current);
    }
    return res.json({success:true,options:[...map.values()].sort((a,b)=>a.name.localeCompare(b.name,'ru'))});
  }catch(error){next(error);}
});

router.post('/qr',async(req,res,next)=>{
  try{
    const qrcType=String(req.body?.qrcType || '');
    const amountMinor=rublesToMinor(req.body?.amount);
    const paymentPurpose=String(req.body?.paymentPurpose || '').trim();
    const errors=[];
    if(!['02','03'].includes(qrcType)) errors.push('qrcType обязателен и должен быть 02 или 03');
    if(!amountMinor) errors.push('amount должен быть положительной суммой с точностью до копеек');
    if(!paymentPurpose) errors.push('paymentPurpose обязателен');
    if(qrcType==='03'){
      if(!req.body?.subscriptionPurpose) errors.push('subscriptionPurpose обязателен для QR-подписки');
      if(!req.body?.subscriptionServiceId) errors.push('subscriptionServiceId обязателен для QR-подписки');
      if(!req.body?.subscriptionServiceName) errors.push('subscriptionServiceName обязателен для QR-подписки');
    }
    if(errors.length) return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'Некорректные параметры QR-запроса',details:errors});

    const partner=hydrateLegacyPartner(req.partner);
    const input={
      apiVersion:'client-v2',
      partnerId:partner.id,
      amountMinor,
      currency:partner.account_currency || 'RUB',
      method:'SBP',
      projectId:req.body?.projectId || null,
      terminalId:req.body?.terminalId || null,
      orderId:req.body?.orderId || null,
      paymentPurpose,
      webhookUrl:req.body?.webhookUrl || null,
      redirectUrl:req.body?.redirectUrl || partner.redirect_url || null,
      qrcType,
      expDt:partner.qr_exp_dt ?? 15,
      localExpDt:partner.qr_local_exp_dt ?? 900,
      subscriptionPurpose:req.body?.subscriptionPurpose || null,
      subscriptionServiceId:req.body?.subscriptionServiceId || null,
      subscriptionServiceName:req.body?.subscriptionServiceName || null,
      clientPhone:req.body?.clientPhone || null,
      clientPam:req.body?.clientPam || null,
      commissionPercent:partner.commission_percent ?? 0,
      currencyRateRub:partner.latest_currency_rate_rub || 1,
    };
    const result=await createPaymentCore(input);
    let bankResponse;
    try{
      bankResponse=await executeQrPayment({payment:result.payment,runtime:result.runtime,input});
      await setPaymentProviderResult(result.payment.payment_pk,{
        status:'pending',
        providerCode:result.runtime.providerCode || null,
        providerOrderId:bankResponse.bankOrderId || null,
        qrcId:bankResponse.qrcId || null,
        qrPayload:bankResponse.payload || null,
      });
    }catch(error){
      await markPaymentFailed(result.payment.payment_pk,error).catch(()=>{});
      return res.status(502).json({success:false,error:'BANK_QR_REGISTER_FAILED',message:'Банк не зарегистрировал QR-код',paymentId:result.payment.id,bankStatusCode:error.statusCode || null});
    }

    return res.json({
      success:true,
      paymentId:result.payment.id,
      orderId:result.payment.partner_order_id || null,
      qrcId:bankResponse.qrcId || null,
      payload:bankResponse.payload || null,
      qrcType,
      regTime:bankResponse.regTime || result.payment.created_at,
      expDt:bankResponse.expDt ?? input.expDt,
      localExpDt:bankResponse.localExpDt ?? input.localExpDt,
      redirectUrl:input.redirectUrl,
      amount:amountMinor,
      accountCurrency:partner.account_currency || 'RUB',
      amountCurrencyMinor:amountMinor,
      effectiveCurrencyRateRub:partner.latest_currency_rate_rub || 1,
      currencyMarkupPercent:partner.currency_markup_percent || 0,
    });
  }catch(error){next(error);}
});

router.post('/refund',async(req,res,next)=>{
  try{
    const partner=hydrateLegacyPartner(req.partner);
    const paymentId=String(req.body?.paymentId || '').trim();
    const amount=req.body?.amount==null?null:Number(req.body.amount);
    const result=await refundPayment({partner,paymentId,amount,remitInfo:req.body?.remitInfo || null});
    if(result.existing) return res.status(202).json(result.response);
    return res.status(result.bankResponse?.statusCode===202?202:200).json({
      success:true,
      paymentId:result.payment.id,
      status:'refund_requested',
      refundRefId:result.refund.provider_ref_id || null,
      internalTxId:result.refund.metadata?.internalTxId || null,
      amount:Number(result.refund.amount_minor),
      bankStatusCode:result.bankResponse?.statusCode || 200,
      refundBankStatus:result.bankResponse?.body?.status ?? null,
      message:'Возврат запрошен',
    });
  }catch(error){
    if(error.statusCode && error.code) return res.status(error.statusCode).json({success:false,error:error.code,message:error.message,...(error.details?{details:error.details}:{})});
    next(error);
  }
});

router.patch('/settings',async(req,res,next)=>{
  try{
    const update={};
    const settings={...(req.partner.settings || {})};
    if('webhookUrl' in (req.body || {})) update.webhook_url=nullableUrl(req.body.webhookUrl,'webhookUrl');
    if('redirectUrl' in (req.body || {})) update.redirect_url=nullableUrl(req.body.redirectUrl,'redirectUrl');
    if('failureRedirectUrl' in (req.body || {})) update.failure_redirect_url=nullableUrl(req.body.failureRedirectUrl,'failureRedirectUrl');
    if(req.body?.qrExpDt!==undefined){
      const value=Number(req.body.qrExpDt);
      if(!Number.isInteger(value) || value<1 || value>1440) return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'qrExpDt должен быть от 1 до 1440 минут'});
      settings.qr_exp_dt=value;
    }
    update.settings=settings;
    update.updated_at=new Date().toISOString();
    const db=getSupabaseAdminClient();
    const {data,error}=await db.from('partners').update(update).eq('id',req.partner.id).select('*').single();
    if(error) throw error;
    const integrationReady=await hasActiveTerminal(db,req.partner.id);
    return res.json({success:true,partner:portalPartner(data,{integrationReady})});
  }catch(error){next(error);}
});

router.post('/api-key/reveal',(req,res)=>res.status(403).json({
  success:false,
  error:'API_KEY_NOT_REVEALABLE',
  message:'Текущий API key хранится только в виде hash. Сгенерируйте новый ключ, чтобы увидеть его один раз.',
}));

router.post('/api-key/regenerate',async(req,res,next)=>{
  try{
    const apiKey=randomToken('wc_live_');
    const db=getSupabaseAdminClient();
    const settings={...(req.partner.settings || {}),api_key_revealed_at:new Date().toISOString()};
    const {data,error}=await db.from('partners').update({
      api_key_hash:sha256(apiKey),
      api_key_prefix:apiKey.slice(0,12),
      settings,
      updated_at:new Date().toISOString(),
    }).eq('id',req.partner.id).select('*').single();
    if(error) throw error;
    const integrationReady=await hasActiveTerminal(db,req.partner.id);
    return res.json({success:true,apiKey,partner:portalPartner(data,{integrationReady})});
  }catch(error){next(error);}
});

router.post('/webhook-secret/reveal',async(req,res,next)=>{
  try{
    if(req.partner.settings?.webhook_secret_revealed_at) return res.status(403).json({success:false,error:'WEBHOOK_SECRET_ALREADY_REVEALED',message:'Webhook secret уже был показан. Сгенерируйте новый secret.'});
    const db=getSupabaseAdminClient();
    const {data:credential,error}=await db.from('partner_credentials').select('webhook_secret').eq('partner_id',req.partner.id).maybeSingle();
    if(error) throw error;
    if(!credential?.webhook_secret) return res.status(404).json({success:false,error:'WEBHOOK_SECRET_NOT_FOUND',message:'Webhook secret не создан'});
    const settings={...(req.partner.settings || {}),webhook_secret_revealed_at:new Date().toISOString()};
    const {data:partner,error:updateError}=await db.from('partners').update({settings,updated_at:new Date().toISOString()}).eq('id',req.partner.id).select('*').single();
    if(updateError) throw updateError;
    return res.json({success:true,webhookSecret:credential.webhook_secret,partner:portalPartner(partner)});
  }catch(error){next(error);}
});

router.post('/webhook-secret/regenerate',async(req,res,next)=>{
  try{
    const webhookSecret=randomToken('wcsec_');
    const now=new Date().toISOString();
    const db=getSupabaseAdminClient();
    const {error:credentialError}=await db.from('partner_credentials').upsert({
      partner_id:req.partner.id,webhook_secret:webhookSecret,migrated_at:now,
    },{onConflict:'partner_id'});
    if(credentialError) throw credentialError;
    const settings={...(req.partner.settings || {}),webhook_secret_revealed_at:now};
    const {data,error}=await db.from('partners').update({
      webhook_secret_hash:sha256(webhookSecret),
      webhook_secret_prefix:webhookSecret.slice(0,12),
      settings,
      updated_at:now,
    }).eq('id',req.partner.id).select('*').single();
    if(error) throw error;
    return res.json({success:true,webhookSecret,partner:portalPartner(data)});
  }catch(error){next(error);}
});

router.post('/change-password',async(req,res,next)=>{
  try{
    const oldPassword=String(req.body?.oldPassword || req.body?.old_password || '');
    const password=String(req.body?.password || '');
    const repeat=String(req.body?.passwordRepeat || req.body?.password_repeat || '');
    const errors=[];
    if(!(await verifyPassword(oldPassword,req.partner.password_hash))) errors.push('Старый пароль неверный');
    if(password!==repeat) errors.push('Пароли не совпадают');
    errors.push(...validatePassword(password));
    if(errors.length) return res.status(400).json({success:false,error:'VALIDATION_ERROR',details:errors});
    const db=getSupabaseAdminClient();
    await db.from('partners').update({password_hash:await hashPassword(password),updated_at:new Date().toISOString()}).eq('id',req.partner.id);
    await revokeAllPartnerSessions(db,req.partner.id);
    return res.json({success:true,message:'Пароль изменен. Войдите снова.'});
  }catch(error){next(error);}
});

router.post('/change-email/request',async(req,res,next)=>{
  try{
    const newEmail=normalizeEmail(req.body?.newEmail || req.body?.new_email);
    if(!isEmail(newEmail)) return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'Введите корректный новый email'});
    const db=getSupabaseAdminClient();
    const {data:existing,error}=await db.from('partners').select('id').or(`email.eq.${newEmail},login.eq.${newEmail}`).maybeSingle();
    if(error) throw error;
    if(existing) return res.status(409).json({success:false,error:'EMAIL_EXISTS',message:'Этот email уже используется'});
    const oldEmail=normalizeEmail(req.partner.email || req.partner.login);
    await createAndSendCode(db,req.partner.id,oldEmail,'change_email_old',{newEmail});
    await createAndSendCode(db,req.partner.id,newEmail,'change_email_new',{oldEmail});
    return res.json({success:true,message:'Коды отправлены на старую и новую почту'});
  }catch(error){next(error);}
});

router.post('/change-email/confirm',async(req,res,next)=>{
  try{
    const newEmail=normalizeEmail(req.body?.newEmail || req.body?.new_email);
    const oldCode=String(req.body?.oldCode || req.body?.old_code || '').trim();
    const newCode=String(req.body?.newCode || req.body?.new_code || '').trim();
    const oldEmail=normalizeEmail(req.partner.email || req.partner.login);
    const db=getSupabaseAdminClient();
    const oldOk=await verifyEmailCode(db,req.partner.id,oldEmail,'change_email_old',oldCode,{newEmail});
    if(!oldOk.ok) return res.status(oldOk.status).json(oldOk.body);
    const newOk=await verifyEmailCode(db,req.partner.id,newEmail,'change_email_new',newCode,{oldEmail});
    if(!newOk.ok) return res.status(newOk.status).json(newOk.body);
    await db.from('partners').update({email:newEmail,login:newEmail,email_verified_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',req.partner.id);
    await revokeAllPartnerSessions(db,req.partner.id);
    return res.json({success:true,message:'Email изменен. Войдите снова.'});
  }catch(error){next(error);}
});

router.get('/payout-summary',async(req,res,next)=>{
  try{
    const summary=await previewPartnerPayout(req.partner.id,req.query.date?String(req.query.date):null);
    return res.json({success:true,summary});
  }catch(error){next(error);}
});

async function hasActiveTerminal(db,partnerId){
  const {count,error}=await db.from('partner_visible_terminals_v2').select('id',{count:'exact',head:true}).eq('partner_id',partnerId).eq('is_active',true);
  if(error) throw error;
  return Number(count || 0)>0;
}

async function createAndSendCode(db,partnerId,email,purpose,meta={}){
  const code=randomDigits(6);
  const expiresAt=addMinutes(new Date(),Number(process.env.EMAIL_CODE_TTL_MINUTES || 10));
  await db.from('partner_email_codes').update({used_at:new Date().toISOString()})
    .eq('partner_id',partnerId).eq('purpose',purpose).is('used_at',null);
  const {error}=await db.from('partner_email_codes').insert({
    partner_id:partnerId,email:normalizeEmail(email),purpose,code_hash:sha256(code),expires_at:expiresAt,meta,
  });
  if(error) throw error;
  await sendEmailCode({to:normalizeEmail(email),code,purpose});
}

async function verifyEmailCode(db,partnerId,email,purpose,code,meta={}){
  const {data,error}=await db.from('partner_email_codes').select('*')
    .eq('partner_id',partnerId).eq('email',normalizeEmail(email)).eq('purpose',purpose)
    .is('used_at',null).order('created_at',{ascending:false}).limit(1).maybeSingle();
  if(error) throw error;
  if(!data) return {ok:false,status:400,body:{success:false,error:'CODE_NOT_FOUND',message:'Код не найден'}};
  if(new Date(data.expires_at).getTime()<Date.now()) return {ok:false,status:400,body:{success:false,error:'CODE_EXPIRED',message:'Код истек'}};
  if(Number(data.attempts || 0)>=5) return {ok:false,status:429,body:{success:false,error:'TOO_MANY_ATTEMPTS',message:'Слишком много попыток'}};
  if(JSON.stringify(data.meta || {})!==JSON.stringify(meta || {}) || sha256(code)!==data.code_hash){
    await db.from('partner_email_codes').update({attempts:Number(data.attempts || 0)+1}).eq('id',data.id);
    return {ok:false,status:400,body:{success:false,error:'INVALID_CODE',message:'Неверный код'}};
  }
  await db.from('partner_email_codes').update({used_at:new Date().toISOString()}).eq('id',data.id);
  return {ok:true};
}

async function revokeAllPartnerSessions(db,partnerId){
  const {error}=await db.from('partner_sessions').update({revoked_at:new Date().toISOString()}).eq('partner_id',partnerId).is('revoked_at',null);
  if(error) throw error;
}

function publicPayment(row){
  const refund=String(row.refund_status || '').toLowerCase();
  let status=String(row.status || '');
  if(refund==='requested') status='refund_requested';
  else if(refund==='processing') status='refund_processing';
  else if(refund==='confirmed') status='refund_confirmed';
  else if(refund==='refused' || refund==='cancelled') status='refund_refused';
  else if(refund==='failed') status='refund_failed';
  else if(status==='creating') status='creating_qr';
  return {...row,status,refund_amount:row.refund_amount==null?null:Number(row.refund_amount)};
}

function normalizeInternalStatus(value){
  const status=String(value || '');
  if(status==='creating_qr') return 'creating';
  if(status.startsWith('refund_')) return 'success';
  return status;
}

function applySearch(query,q,field){
  if(!q) return query;
  const value=q.replace(/[(),]/g,' ').trim();
  const map={
    order_id:'partner_order_id',
    qrc_id:'qrc_id',
    trx_id:'trx_id',
    bank_order_id:'bank_order_id',
    payment_purpose:'payment_purpose',
    qr_payload:'qr_payload',
  };
  if(field==='payment_id') return isUuid(value)?query.eq('id',value):query.eq('id','00000000-0000-0000-0000-000000000000');
  if(field==='terminal_id') return isUuid(value)?query.eq('partner_terminal_id',value):query.eq('partner_terminal_id','00000000-0000-0000-0000-000000000000');
  if(map[field]) return query.ilike(map[field],`%${value}%`);
  const filters=[
    `partner_order_id.ilike.%${value}%`,
    `qrc_id.ilike.%${value}%`,
    `trx_id.ilike.%${value}%`,
    `bank_order_id.ilike.%${value}%`,
    `payment_purpose.ilike.%${value}%`,
    `qr_payload.ilike.%${value}%`,
  ];
  if(isUuid(value)) filters.push(`id.eq.${value}`,`partner_terminal_id.eq.${value}`);
  return query.or(filters.join(','));
}

function normalizePeriod(value){
  return ['day','month','quarter','year'].includes(String(value))?String(value):'month';
}

function periodRange(period){
  const now=new Date();
  const shifted=new Date(now.getTime()+3*3600000);
  const y=shifted.getUTCFullYear(),m=shifted.getUTCMonth(),d=shifted.getUTCDate();
  let startLocal;
  if(period==='day') startLocal=Date.UTC(y,m,d);
  else if(period==='quarter') startLocal=Date.UTC(y,Math.floor(m/3)*3,1);
  else if(period==='year') startLocal=Date.UTC(y,0,1);
  else startLocal=Date.UTC(y,m,1);
  const start=new Date(startLocal-3*3600000).toISOString();
  return {start,end:now.toISOString()};
}

function buildStats(rows,period,hourly,refundRows){
  const methodMap=new Map(),statusMap=new Map(),timelineMap=new Map();
  let total=0,count=0,pending=0,failed=0,failedTotal=0,canceled=0,canceledTotal=0,allCount=0;
  for(const row of rows){
    const status=String(row.status || '');
    const cnt=Math.max(0,Number(row.count || 0));
    const amount=Number(row.amount_minor || 0);
    allCount+=cnt;
    methodMap.set(methodLabel(row.payment_type),(methodMap.get(methodLabel(row.payment_type))||0)+cnt);
    statusMap.set(statusLabel(status),(statusMap.get(statusLabel(status))||0)+cnt);
    if(['creating','pending'].includes(status)) pending+=cnt;
    if(['failed','subscription_failed','subscription_rejected'].includes(status)){failed+=cnt;failedTotal+=amount;}
    if(['expired','canceled'].includes(status)){canceled+=cnt;canceledTotal+=amount;}
    if(!['success','subscription_confirmed'].includes(status)) continue;
    total+=amount;count+=cnt;
    const raw=hourly?row.bucket_start:row.business_day;
    const key=timelineKey(raw,period,hourly);
    const current=timelineMap.get(key.key) || {name:key.name,value:0,count:0};
    current.value+=amount;current.count+=cnt;timelineMap.set(key.key,current);
  }
  const refundedTotal=(refundRows || []).reduce((sum,row)=>sum+Number(row.amount_minor || 0),0);
  const list=(map)=>[...map.entries()].map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value);
  const timeline=[...timelineMap.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>({key,...v,avg:v.count?v.value/v.count:0})).slice(-31);
  return {
    total:Math.max(0,total-refundedTotal),count,pending,failed,failedTotal,canceled,canceledTotal,
    refunded:(refundRows || []).length,refundedTotal,avg:count?total/count:0,allCount,
    successRate:allCount?Math.round(count/allCount*100):0,timeline,byMethod:list(methodMap),byStatus:list(statusMap),
  };
}

function emptyStats(){return {total:0,count:0,pending:0,failed:0,failedTotal:0,canceled:0,canceledTotal:0,refunded:0,refundedTotal:0,avg:0,allCount:0,successRate:0,timeline:[],byMethod:[],byStatus:[]};}

async function resolveAnalyticsTerminalIds(db,partnerId,projectId,tspName){
  if(!tspName) return [];
  let query=db.from('partner_visible_terminals_v2').select('id,company_name,label').eq('partner_id',partnerId);
  if(projectId) query=query.eq('project_id',projectId);
  const {data,error}=await query;
  if(error) throw error;
  return (data || []).filter((row)=>String(row.company_name || row.label || '')===tspName).map((row)=>row.id);
}

function timelineKey(raw,period,hourly){
  if(hourly){
    const d=new Date(new Date(raw).getTime()+3*3600000);
    const y=d.getUTCFullYear(),m=String(d.getUTCMonth()+1).padStart(2,'0'),day=String(d.getUTCDate()).padStart(2,'0'),h=String(d.getUTCHours()).padStart(2,'0');
    if(period==='day') return {key:`${y}-${m}-${day}-${h}`,name:`${h}:00`};
    return {key:`${y}-${m}-${day}`,name:`${day}.${m}`};
  }
  const key=String(raw).slice(0,10);
  if(period==='year') return {key:key.slice(0,7),name:key.slice(5,7)};
  return {key,name:`${key.slice(8,10)}.${key.slice(5,7)}`};
}

function statusLabel(s){return ({creating:'Создание',pending:'Ожидает оплаты',success:'Оплачен',failed:'Ошибка',expired:'Отменен',canceled:'Отменен',subscription_confirmed:'Подписка подтверждена',subscription_rejected:'Отказ плательщика',subscription_failed:'Ошибка подписки'})[s] || s || '—';}
function methodLabel(m){return String(m || '').toUpperCase()==='CARD'?'Карта':'СБП';}

function moscowDayStart(dateStr){return new Date(`${String(dateStr).slice(0,10)}T00:00:00+03:00`).toISOString();}
function moscowDayAfter(dateStr){return new Date(new Date(`${String(dateStr).slice(0,10)}T00:00:00+03:00`).getTime()+86400000).toISOString();}
function moscowDate(iso){const d=new Date(new Date(iso).getTime()+3*3600000);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;}
function rublesToMinor(value){const s=String(value ?? '').trim().replace(',','.');if(!/^\d+(?:\.\d{1,2})?$/.test(s)) return null;const [a,b='']=s.split('.');const n=Number(a)*100+Number(b.padEnd(2,'0'));return Number.isSafeInteger(n)&&n>0?n:null;}
function isUuid(v){return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v));}
function nullableUrl(value,name){const s=String(value || '').trim();if(!s) return null;try{const u=new URL(s);if(!['http:','https:'].includes(u.protocol)) throw new Error();return s;}catch{const e=new Error(`${name} должен быть HTTP(S) URL`);e.statusCode=400;e.code='VALIDATION_ERROR';throw e;}}

module.exports=router;
