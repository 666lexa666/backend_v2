const express = require('express');
const { auth } = require('../lib/auth');
const { getSupabaseAdminClient } = require('../lib/supabase');
const { portalPartner } = require('../lib/portalPartner');
const { sha256, randomToken, addDays, normalizeEmail, isEmail } = require('../lib/security');
const { sendPartnerInvite } = require('../lib/email');

const router = express.Router();
const ACCOUNTING_KEY_NAME = 'whitecapital-accounting';

router.use(auth({ admin: true }));

router.get('/accounting-key', async (req, res, next) => {
  try {
    const db = getSupabaseAdminClient();
    const { data, error } = await db.from('accounting_api_keys')
      .select('id,name,key_prefix,created_at,last_used_at')
      .eq('name', ACCOUNTING_KEY_NAME)
      .is('revoked_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return res.json({
      success: true,
      key: data ? {
        active: true,
        name: data.name,
        prefix: data.key_prefix,
        createdAt: data.created_at,
        lastUsedAt: data.last_used_at,
      } : { active: false, name: ACCOUNTING_KEY_NAME },
    });
  } catch (error) { next(error); }
});

router.post('/accounting-key/generate', async (req, res, next) => {
  try {
    const db = getSupabaseAdminClient();
    const now = new Date().toISOString();
    const { error: revokeError } = await db.from('accounting_api_keys')
      .update({ revoked_at: now })
      .eq('name', ACCOUNTING_KEY_NAME)
      .is('revoked_at', null);
    if (revokeError) throw revokeError;

    const secret = randomToken('wcacct_');
    const { data, error } = await db.from('accounting_api_keys').insert({
      name: ACCOUNTING_KEY_NAME,
      key_prefix: `${secret.slice(0, 18)}…`,
      key_hash: sha256(secret),
      created_by_partner_id: req.partner.id,
    }).select('name,key_prefix,created_at').single();
    if (error) throw error;

    res.setHeader('Cache-Control', 'no-store');
    return res.status(201).json({
      success: true,
      secret,
      shownOnce: true,
      key: {
        active: true,
        name: data.name,
        prefix: data.key_prefix,
        createdAt: data.created_at,
        lastUsedAt: null,
      },
    });
  } catch (error) { next(error); }
});

router.post('/accounting-key/revoke', async (req, res, next) => {
  try {
    const db = getSupabaseAdminClient();
    const { data, error } = await db.from('accounting_api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('name', ACCOUNTING_KEY_NAME)
      .is('revoked_at', null)
      .select('id');
    if (error) throw error;
    return res.json({ success: true, revoked: Boolean(data?.length) });
  } catch (error) { next(error); }
});

router.get('/partners', async (req, res, next) => {
  try {
    const db = getSupabaseAdminClient();
    let query = db.from('partners').select('*').eq('is_admin', false);
    if (String(req.query.archived || '') === 'true') query = query.not('archived_at', 'is', null);
    else query = query.is('archived_at', null);
    const { data, error } = await query.order('id', { ascending: true });
    if (error) throw error;

    const { data: routes, error: routeError } = await db.from('partner_payment_routes_v2')
      .select('partner_id');
    if (routeError) throw routeError;
    const ready = new Set((routes || []).map((row) => Number(row.partner_id)));

    return res.json({
      success: true,
      partners: (data || []).map((partner) =>
        portalPartner(partner, { includeCommission: true, integrationReady: ready.has(Number(partner.id)) })
      ),
    });
  } catch (error) { next(error); }
});

router.get('/partners/:id', async (req, res, next) => {
  try {
    const partnerId = parsePartnerId(req.params.id);
    if (!partnerId) return invalidPartnerId(res);
    const db = getSupabaseAdminClient();
    const { data, error } = await db.from('partners').select('*').eq('id', partnerId).maybeSingle();
    if (error) throw error;
    if (!data || data.is_admin) return res.status(404).json({ success:false,error:'PARTNER_NOT_FOUND',message:'Партнёр не найден' });
    const { count, error: countError } = await db.from('partner_payment_routes_v2')
      .select('partner_terminal_id', { count:'exact', head:true }).eq('partner_id', partnerId);
    if (countError) throw countError;
    return res.json({
      success:true,
      partner:portalPartner(data,{includeCommission:true,integrationReady:Number(count || 0)>0}),
    });
  } catch (error) { next(error); }
});

router.patch('/partners/:id/status', async (req, res, next) => {
  try {
    const partnerId=parsePartnerId(req.params.id);
    if(!partnerId) return invalidPartnerId(res);
    if(typeof req.body?.isActive !== 'boolean') {
      return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'isActive должен быть boolean'});
    }
    const db=getSupabaseAdminClient();
    const {data,error}=await db.from('partners').update({
      is_active:req.body.isActive,
      updated_at:new Date().toISOString(),
    }).eq('id',partnerId).eq('is_admin',false).select('*').maybeSingle();
    if(error) throw error;
    if(!data) return res.status(404).json({success:false,error:'PARTNER_NOT_FOUND',message:'Партнёр не найден'});
    return res.json({success:true,partner:portalPartner(data,{includeCommission:true})});
  } catch(error){next(error);}
});

router.patch('/partners/:id/archive', async (req,res,next)=>{
  try{
    const partnerId=parsePartnerId(req.params.id);
    if(!partnerId) return invalidPartnerId(res);
    const archived=Boolean(req.body?.archived);
    const db=getSupabaseAdminClient();
    const now=new Date().toISOString();
    const {data,error}=await db.from('partners').update({
      archived_at:archived?now:null,
      is_active:archived?false:undefined,
      updated_at:now,
    }).eq('id',partnerId).eq('is_admin',false).select('*').maybeSingle();
    if(error) throw error;
    if(!data) return res.status(404).json({success:false,error:'PARTNER_NOT_FOUND',message:'Партнёр не найден'});
    if(archived){
      await db.from('partner_sessions').update({revoked_at:now}).eq('partner_id',partnerId).is('revoked_at',null);
    }
    return res.json({success:true,partner:portalPartner(data,{includeCommission:true})});
  }catch(error){next(error);}
});

router.patch('/partners/:id/bank-settings', async (req,res,next)=>{
  try{
    const partnerId=parsePartnerId(req.params.id);
    if(!partnerId) return invalidPartnerId(res);
    const db=getSupabaseAdminClient();
    const {data:current,error:currentError}=await db.from('partners').select('*').eq('id',partnerId).eq('is_admin',false).maybeSingle();
    if(currentError) throw currentError;
    if(!current) return res.status(404).json({success:false,error:'PARTNER_NOT_FOUND',message:'Партнёр не найден'});

    const update={updated_at:new Date().toISOString()};
    const settings={...(current.settings || {})};

    if(req.body?.account_currency!==undefined){
      const currency=String(req.body.account_currency || '').toUpperCase();
      if(!['RUB','USD','EUR'].includes(currency)) return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'account_currency должен быть RUB, USD или EUR'});
      update.account_currency=currency;
    }
    if(req.body?.commission_percent!==undefined){
      const n=Number(String(req.body.commission_percent).replace(',','.'));
      if(!Number.isFinite(n) || n<0 || n>100) return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'commission_percent должен быть от 0 до 100'});
      update.commission_percent=n;
    }
    for(const [key,type] of [
      ['currency_markup_percent','number'],
      ['bank_id','numberOrNull'],
      ['qr_exp_dt','integer'],
      ['qr_local_exp_dt','integer'],
      ['terminal_analytics_enabled','boolean'],
      ['terminal_auto_distribution_enabled','boolean'],
      ['ignore_request_terminal_id','boolean'],
      ['purpose_use_transaction_id','boolean'],
      ['purpose_use_client_phone','boolean'],
      ['require_qr_client_identity','boolean'],
      ['forward_payer_data','boolean'],
      ['checkout_payment_methods','stringOrNull'],
    ]){
      if(req.body?.[key]===undefined) continue;
      const value=req.body[key];
      if(type==='boolean') settings[key]=Boolean(value);
      else if(type==='number'){
        const n=Number(String(value).replace(',','.'));
        if(!Number.isFinite(n) || n<0) return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:`${key} некорректен`});
        settings[key]=n;
      } else if(type==='numberOrNull'){
        if(value===null || value==='') settings[key]=null;
        else {
          const n=Number(value);
          if(!Number.isFinite(n)) return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:`${key} некорректен`});
          settings[key]=n;
        }
      } else if(type==='integer'){
        const n=Number(value);
        if(!Number.isInteger(n) || n<1) return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:`${key} должен быть положительным целым числом`});
        settings[key]=n;
      } else settings[key]=value===null || value===''?null:String(value);
    }

    update.settings=settings;
    const {data,error}=await db.from('partners').update(update).eq('id',partnerId).select('*').single();
    if(error) throw error;
    return res.json({success:true,partner:portalPartner(data,{includeCommission:true})});
  }catch(error){next(error);}
});

router.get('/partners/:id/projects', async(req,res,next)=>{
  try{
    const partnerId=parsePartnerId(req.params.id);
    if(!partnerId) return invalidPartnerId(res);
    const db=getSupabaseAdminClient();
    const {data,error}=await db.from('partner_projects').select('*')
      .eq('partner_id',partnerId).is('archived_at',null).order('sort_order').order('created_at');
    if(error) throw error;
    return res.json({success:true,projects:(data || []).map(publicProject)});
  }catch(error){next(error);}
});

router.post('/partners/:id/projects', async(req,res,next)=>{
  try{
    const partnerId=parsePartnerId(req.params.id);
    if(!partnerId) return invalidPartnerId(res);
    const name=String(req.body?.name || '').trim();
    if(!name) return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'name обязателен'});
    const db=getSupabaseAdminClient();
    const {data:errorCount,error:countError}=await db.from('partner_projects').select('id',{count:'exact',head:true}).eq('partner_id',partnerId);
    if(countError) throw countError;
    const {data,error}=await db.from('partner_projects').insert({
      partner_id:partnerId,
      name,
      sort_order:Number(errorCount?.length || 0),
      deposit_enabled:Boolean(req.body?.deposit_enabled),
      deposit_allow_negative:Boolean(req.body?.deposit_allow_negative),
      terminal_auto_distribution_enabled:req.body?.terminal_auto_distribution_enabled!==false,
      telegram_daily_report_enabled:Boolean(req.body?.telegram_daily_report_enabled),
      telegram_report_thread_id:req.body?.telegram_report_thread_id || null,
      is_active:req.body?.is_active!==false,
      settings:{},
    }).select('*').single();
    if(error) {
      if(error.code==='23505') return res.status(409).json({success:false,error:'PROJECT_NAME_EXISTS',message:'Проект с таким названием уже существует'});
      throw error;
    }
    return res.status(201).json({success:true,project:publicProject(data)});
  }catch(error){next(error);}
});

router.patch('/partners/:id/projects/:projectId', async(req,res,next)=>{
  try{
    const partnerId=parsePartnerId(req.params.id);
    if(!partnerId) return invalidPartnerId(res);
    const update={updated_at:new Date().toISOString()};
    for(const key of ['name','deposit_enabled','deposit_allow_negative','terminal_auto_distribution_enabled','telegram_daily_report_enabled','telegram_report_thread_id','is_active','sort_order']){
      if(req.body?.[key]!==undefined) update[key]=req.body[key];
    }
    if(req.body?.archived===true) update.archived_at=new Date().toISOString();
    if(req.body?.archived===false) update.archived_at=null;
    const db=getSupabaseAdminClient();
    const {data,error}=await db.from('partner_projects').update(update)
      .eq('id',req.params.projectId).eq('partner_id',partnerId).select('*').maybeSingle();
    if(error) throw error;
    if(!data) return res.status(404).json({success:false,error:'PROJECT_NOT_FOUND',message:'Проект не найден'});
    return res.json({success:true,project:publicProject(data)});
  }catch(error){next(error);}
});

router.get('/currency-rates', async(req,res,next)=>{
  try{
    const db=getSupabaseAdminClient();
    const {data,error}=await db.from('currency_rates')
      .select('base_currency,quote_currency,rate,source,effective_at')
      .eq('quote_currency','RUB')
      .in('base_currency',['USD','EUR'])
      .order('effective_at',{ascending:false})
      .limit(20);
    if(error) throw error;
    const rates={};
    for(const row of data || []){
      const currency=String(row.base_currency).trim();
      if(!rates[currency]) rates[currency]={
        currency,
        rate_rub:Number(row.rate),
        source:row.source,
        fetched_at:row.effective_at,
      };
    }
    return res.json({success:true,rates});
  }catch(error){next(error);}
});

router.get('/banks', async(req,res,next)=>{
  try{
    const db=getSupabaseAdminClient();
    const {data,error}=await db.from('banks').select('*').order('id',{ascending:true});
    if(error) throw error;
    return res.json({success:true,banks:(data || []).map(publicBank)});
  }catch(error){next(error);}
});

router.get('/banks/:id', async(req,res,next)=>{
  try{
    const id=Number(req.params.id);
    if(!Number.isFinite(id)) return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'Некорректный ID банка'});
    const db=getSupabaseAdminClient();
    const {data,error}=await db.from('banks').select('*').eq('id',id).maybeSingle();
    if(error) throw error;
    if(!data) return res.status(404).json({success:false,error:'BANK_NOT_FOUND',message:'Банк не найден'});
    return res.json({success:true,bank:publicBank(data)});
  }catch(error){next(error);}
});

router.post('/banks', async(req,res,next)=>{
  try{
    const built=buildBankWrite(req.body || {}, null);
    if(built.errors.length) return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'Некорректные параметры банка',details:built.errors});
    const db=getSupabaseAdminClient();
    const {data,error}=await db.from('banks').insert(built.row).select('*').single();
    if(error) throw error;
    return res.status(201).json({success:true,bank:publicBank(data)});
  }catch(error){next(error);}
});

router.patch('/banks/:id', async(req,res,next)=>{
  try{
    const id=Number(req.params.id);
    if(!Number.isFinite(id)) return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'Некорректный ID банка'});
    const db=getSupabaseAdminClient();
    const {data:current,error:currentError}=await db.from('banks').select('*').eq('id',id).maybeSingle();
    if(currentError) throw currentError;
    if(!current) return res.status(404).json({success:false,error:'BANK_NOT_FOUND',message:'Банк не найден'});
    const built=buildBankWrite(req.body || {}, current);
    if(built.errors.length) return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'Некорректные параметры банка',details:built.errors});
    const {data,error}=await db.from('banks').update({...built.row,updated_at:new Date().toISOString()}).eq('id',id).select('*').single();
    if(error) throw error;
    return res.json({success:true,bank:publicBank(data)});
  }catch(error){next(error);}
});

router.get('/partner-invites', async(req,res,next)=>{
  try{
    const db=getSupabaseAdminClient();
    const {data,error}=await db.from('partner_invites').select('id,email,company_name,bank_id,expires_at,used_at,used_by_partner_id,created_by_partner_id,created_at')
      .order('created_at',{ascending:false}).limit(200);
    if(error) throw error;
    return res.json({success:true,invites:(data || []).map((row)=>({
      ...row,
      expired:new Date(row.expires_at).getTime()<Date.now(),
      status:row.used_at?'used':(new Date(row.expires_at).getTime()<Date.now()?'expired':'active'),
    }))});
  }catch(error){next(error);}
});

router.post('/partner-invites', async(req,res,next)=>{
  try{
    const email=normalizeEmail(req.body?.email);
    const companyName=String(req.body?.companyName || req.body?.company_name || '').trim() || null;
    if(!isEmail(email)) return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'Введите корректный email'});
    const rawBankId=req.body?.bank_id ?? req.body?.bankId;
    const bankId=rawBankId===undefined || rawBankId===null || rawBankId===''?null:Number(rawBankId);
    if(bankId!==null && !Number.isFinite(bankId)) return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'Некорректный bank_id'});
    const db=getSupabaseAdminClient();
    if(bankId!==null){
      const {data:bank,error:bankError}=await db.from('banks').select('id').eq('id',bankId).maybeSingle();
      if(bankError) throw bankError;
      if(!bank) return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'Банк с таким bank_id не найден'});
    }

    const token=randomToken('wcinv_');
    const expiresAt=addDays(new Date(),3);
    const {data,error}=await db.from('partner_invites').insert({
      token_hash:sha256(token),
      email,
      company_name:companyName,
      bank_id:bankId,
      expires_at:expiresAt,
      created_by_partner_id:req.partner.id,
    }).select('id,email,company_name,bank_id,expires_at,used_at,created_at').single();
    if(error) throw error;

    try{
      await sendPartnerInvite({to:email,token,companyName,expiresAt});
      return res.status(201).json({
        success:true,
        message:`Приглашение отправлено на ${email}`,
        invite:{...data,token},
        emailSent:true,
      });
    }catch(emailError){
      return res.status(502).json({
        success:false,
        error:'INVITE_EMAIL_FAILED',
        message:`Инвайт создан, но письмо на ${email} не отправлено. Скопируйте одноразовый token и настройте SMTP.`,
        invite:{...data,token},
        emailSent:false,
      });
    }
  }catch(error){next(error);}
});

function publicProject(row){
  return {
    ...row,
    balance_enabled:false,
  };
}

function publicBank(row){
  const config=row.config && typeof row.config==='object'?row.config:{};
  return {
    id:row.id,
    code:row.code,
    name:row.name,
    provider_code:row.provider_code,
    payment_methods:row.payment_methods || [],
    is_active:Boolean(row.is_active),
    created_at:row.created_at,
    updated_at:row.updated_at,
    api_base_url:config.api_base_url || null,
    qr_register_url:config.qr_register_url || null,
    refund_url:config.refund_url || null,
    tls_reject_unauthorized:config.tls_reject_unauthorized!==false,
    use_proxy:Boolean(config.use_proxy),
    has_certificate:Boolean(config.certificate_base64),
  };
}

function buildBankWrite(body,current){
  const errors=[];
  const existingConfig=current?.config && typeof current.config==='object'?current.config:{};
  const providerCode=String(body.provider_code ?? body.providerCode ?? current?.provider_code ?? 'mtls_json').trim();
  const name=String(body.name ?? current?.name ?? '').trim();
  if(!name) errors.push('name обязателен');
  if(!['mtls_json','ingo'].includes(providerCode)) errors.push('providerCode должен быть mtls_json или ingo');

  const config={...existingConfig};
  const apiBaseUrl=body.api_base_url ?? body.apiBaseUrl;
  const qrRegisterUrl=body.qr_register_url ?? body.qrRegisterUrl;
  const refundUrl=body.refund_url ?? body.refundUrl;
  const cert=body.certificate_base64 ?? body.certificateBase64;
  const certPass=body.certificate_password ?? body.certificatePassword;

  if(apiBaseUrl!==undefined){
    const value=String(apiBaseUrl || '').trim();
    if(value && !isHttpUrl(value)) errors.push('apiBaseUrl должен быть HTTP(S) URL');
    config.api_base_url=value || null;
  }
  if(qrRegisterUrl!==undefined){
    const value=String(qrRegisterUrl || '').trim();
    if(value && !isHttpUrl(value)) errors.push('qrRegisterUrl должен быть HTTP(S) URL');
    config.qr_register_url=value || null;
  }
  if(refundUrl!==undefined){
    const value=String(refundUrl || '').trim();
    if(value && !isHttpUrl(value)) errors.push('refundUrl должен быть HTTP(S) URL');
    config.refund_url=value || null;
  }
  if(cert!==undefined && String(cert || '').trim()) config.certificate_base64=String(cert).replace(/\s+/g,'');
  if(certPass!==undefined && String(certPass || '')) config.certificate_password=String(certPass);
  if(body.tls_reject_unauthorized!==undefined || body.tlsRejectUnauthorized!==undefined){
    config.tls_reject_unauthorized=Boolean(body.tls_reject_unauthorized ?? body.tlsRejectUnauthorized);
  }
  if(body.use_proxy!==undefined || body.useProxy!==undefined) config.use_proxy=Boolean(body.use_proxy ?? body.useProxy);

  if(providerCode==='ingo' && !config.api_base_url) errors.push('apiBaseUrl обязателен для Ingo');
  if(providerCode==='mtls_json' && !current){
    if(!config.qr_register_url) errors.push('qrRegisterUrl обязателен');
    if(!config.refund_url) errors.push('refundUrl обязателен');
    if(!config.certificate_base64) errors.push('certificateBase64 обязателен');
    if(!config.certificate_password) errors.push('certificatePassword обязателен');
  }

  return {
    errors,
    row:{
      ...(current?{}:{code:uniqueBankCode(name)}),
      name,
      provider_code:providerCode,
      payment_methods:Array.isArray(body.payment_methods)?body.payment_methods:(current?.payment_methods || ['SBP','CARD']),
      is_active:body.is_active!==undefined || body.isActive!==undefined
        ? Boolean(body.is_active ?? body.isActive)
        : current?.is_active!==false,
      config,
    },
  };
}

function uniqueBankCode(name){
  const stem=String(name || 'bank').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,20) || 'bank';
  return `${stem}-${Date.now().toString(36)}`;
}
function isHttpUrl(value){try{const u=new URL(String(value));return ['http:','https:'].includes(u.protocol);}catch{return false;}}
function parsePartnerId(value){const id=Number(value);return Number.isSafeInteger(id)&&id>0?id:null;}
function invalidPartnerId(res){return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'Некорректный ID партнёра'});}

module.exports=router;
