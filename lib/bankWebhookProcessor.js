const crypto = require('node:crypto');
const { getSupabaseAdminClient } = require('./supabase');
const { enqueuePartnerWebhook } = require('./partnerWebhookOutbox');
const { loadTerminalRuntime } = require('./paymentCore');
const { findBankById } = require('./legacyBankAdapter');

function detectNotificationType(body = {}) {
  if (body.subscriptionToken && body.qrcId) return 'subscription';
  if (body.orgnlTrxId) return 'b2c_refund';
  if (body.internalTrxId && body.status && !body.orgnlTrxId) return 'b2c_transfer';
  if (body.trxId && body.qrcId && body.amount !== undefined && String(body.qrcType || '') === '01') {
    return 'unsupported_static_c2b_payment';
  }
  if (body.trxId && body.qrcId && body.amount !== undefined) return 'c2b_payment';
  return null;
}

async function processGenericBankWebhook({ providerCode = 'mtls_json', headers = {}, body = {} }) {
  const db = getSupabaseAdminClient();
  const receivedAt = new Date().toISOString();
  const notificationType = detectNotificationType(body);

  if (!notificationType) {
    return {
      statusCode: 400,
      body: { success:false,error:'UNKNOWN_WEBHOOK_TYPE',message:'Не удалось определить тип банковского уведомления' },
    };
  }

  if (notificationType === 'unsupported_static_c2b_payment') {
    await recordInbox({ providerCode, eventKey: genericEventKey(notificationType, body), notificationType, headers, body, paymentPk:null, receivedAt, status:'ignored' });
    return { statusCode:200, body:{ success:true,message:'Webhook accepted, payment not found' } };
  }

  const payment = await findRelatedPayment(notificationType, body);
  const eventKey = genericEventKey(notificationType, body);

  if (!payment) {
    await recordInbox({ providerCode, eventKey, notificationType, headers, body, paymentPk:null, receivedAt, status:'unmatched' });
    return { statusCode:200, body:{ success:true,message:'Webhook accepted, payment not found' } };
  }

  const duplicate = await recordInbox({
    providerCode,
    eventKey,
    notificationType,
    headers,
    body,
    paymentPk:payment.payment_pk,
    receivedAt,
    status:'processing',
  });

  if (duplicate) {
    return { statusCode:200, body:{ success:true,message:'OK' } };
  }

  try {
    await applyNormalizedNotification({ payment, notificationType, body, headers, receivedAt, providerCode });
    await markInbox(providerCode,eventKey,'processed',null);

    if (notificationType !== 'unsupported_static_c2b_payment') {
      await enqueuePartnerWebhook({ paymentId:payment.id, notificationType, body });
    }

    return { statusCode:200, body:{ success:true,message:'OK' } };
  } catch (error) {
    await markInbox(providerCode,eventKey,'failed',String(error?.message || error)).catch(()=>{});
    throw error;
  }
}

async function processIngoWebhook({ method, query = {}, body = {}, rawBody = '' }) {
  const receivedAt = new Date().toISOString();
  const params = { ...(query || {}), ...(body || {}) };
  const mdOrder = String(params.mdOrder || params.orderId || '').trim();

  if (!['GET','POST'].includes(String(method).toUpperCase())) {
    return { statusCode:405, text:'METHOD_NOT_ALLOWED' };
  }
  if (!mdOrder) return { statusCode:400, text:'MD_ORDER_REQUIRED' };

  const db = getSupabaseAdminClient();
  const payment = await findPaymentByProviderOrderId(mdOrder);
  if (!payment) return { statusCode:200, text:'OK' };

  const runtime = payment.partner_terminal_id
    ? await loadTerminalRuntime({ id: payment.partner_terminal_id })
    : null;
  const bank = await findBankById(payment.bank_id || runtime?.bankId || null);
  const callbackToken = runtime?.providerConfig?.ingo_callback_token || bank?.callback_token || null;

  if (!verifyIngoSignature(params, callbackToken)) {
    return { statusCode:401, text:'INVALID_SIGNATURE' };
  }

  const operation = String(params.operation || '').toLowerCase();
  const successful = String(params.status) === '1';
  let notificationType = null;
  let normalized = null;

  if (operation === 'deposited' && successful) {
    notificationType = 'c2b_payment';
    normalized = {
      qrcId: payment.qrc_id,
      qrcType: payment.qrc_type,
      amount: normalizeAmount(params.amount,payment.amount_minor),
      cur: params.currency || 'RUB',
      trxId: params.refNum || params.trxId || mdOrder,
      trxTime: params.paymentDate || receivedAt,
      sndPam: params.cardholderName || null,
      sndPhoneMasked: params.payerPhone || null,
    };
  } else if (operation === 'refunded') {
    notificationType = 'b2c_refund';
    normalized = {
      status: successful ? 'CONFIRMED' : 'REFUSED',
      amount: normalizeAmount(params.amount,payment.amount_minor),
      trxId: params.refNum || null,
      infoMsg: params.errorMessage || params.actionCodeDescription || params.message || null,
    };
  } else if (operation === 'bindingcreated') {
    notificationType = 'subscription';
    normalized = {
      status: successful ? 'CONFIRMED' : 'REFUSED',
      qrcId: payment.qrc_id,
      subscriptionToken: params.bindingId || null,
      amount: Number(payment.amount_minor),
    };
  } else if ((operation === 'deposited' && !successful) || ['reversed','declinedbytimeout','declinedcardpresent'].includes(operation)) {
    notificationType = operation === 'declinedbytimeout' ? 'payment_expired' : 'payment_failed';
    normalized = {
      amount: normalizeAmount(params.amount,payment.amount_minor),
      cur: params.currency || 'RUB',
      trxId: params.refNum || params.paymentRefNum || mdOrder,
      errorMessage: params.errorMessage || params.actionCodeDescription || null,
    };
  } else {
    return { statusCode:200, text:'OK' };
  }

  const eventKey = `ingo:${mdOrder}:${operation}:${String(params.status || '')}:${String(params.refNum || '')}`;
  const duplicate = await recordInbox({
    providerCode:'ingo',
    eventKey,
    notificationType,
    headers:{},
    body:params,
    paymentPk:payment.payment_pk,
    receivedAt,
    status:'processing',
  });
  if (duplicate) return { statusCode:200, text:'OK' };

  try {
    await applyNormalizedNotification({
      payment,
      notificationType,
      body:normalized,
      headers:{},
      receivedAt,
      providerCode:'ingo',
    });
    await markInbox('ingo',eventKey,'processed',null);
    await enqueuePartnerWebhook({ paymentId:payment.id, notificationType, body:normalized });
    return { statusCode:200, text:'OK' };
  } catch (error) {
    await markInbox('ingo',eventKey,'failed',String(error?.message || error)).catch(()=>{});
    throw error;
  }
}

async function applyNormalizedNotification({ payment, notificationType, body, headers, receivedAt, providerCode }) {
  const db = getSupabaseAdminClient();
  const paymentUpdate = {
    updated_at:new Date().toISOString(),
    metadata:{
      ...(payment.metadata || {}),
      bankWebhookType:notificationType,
      bankWebhookHeaders:headers,
      bankWebhookReceivedAt:receivedAt,
    },
  };

  const providerUpdate = { updated_at:new Date().toISOString() };

  if (notificationType === 'c2b_payment') {
    paymentUpdate.status='success';
    paymentUpdate.paid_at=parseIsoDateOrNull(body.trxTime) || receivedAt;
    paymentUpdate.provider_payment_id=body.trxId || payment.provider_payment_id || null;
    if (body.qrcType) paymentUpdate.qrc_type=body.qrcType;
    providerUpdate.provider_trx_id=body.trxId || null;
    providerUpdate.provider_trx_time=parseIsoDateOrNull(body.trxTime);
  } else if (notificationType === 'payment_failed') {
    paymentUpdate.status='failed';
    providerUpdate.provider_trx_id=body.trxId || null;
  } else if (notificationType === 'payment_expired') {
    paymentUpdate.status='expired';
    providerUpdate.provider_trx_id=body.trxId || null;
  } else if (notificationType === 'subscription') {
    const status=normalizeSubscriptionStatus(body);
    paymentUpdate.status=status;
    providerUpdate.subscription_token=body.subscriptionToken || null;
    providerUpdate.subscription_member_id=body.memberId || null;
    if (status==='subscription_confirmed') {
      await saveSubscriptionInstrument(payment, body);
    }
  } else if (notificationType === 'b2c_refund') {
    const status=normalizeRefundStatus(body.status);
    paymentUpdate.status=status;
    const refund = await findOpenRefund(payment.payment_pk, body);
    if (refund) {
      await db.from('payment_refunds').update({
        status:status.replace('refund_',''),
        provider_trx_id:body.trxId || refund.provider_trx_id || null,
        completed_at:status==='refund_confirmed'?receivedAt:null,
        updated_at:new Date().toISOString(),
        metadata:{
          ...(refund.metadata || {}),
          bankNotification:body,
        },
      }).eq('id',refund.id);
    }
  } else if (notificationType === 'b2c_transfer') {
    paymentUpdate.status=String(body.status || '').toUpperCase()==='CONFIRMED'
      ? 'transfer_confirmed'
      : 'transfer_refused';
  }

  const { error:updateError }=await db.from('payments').update(paymentUpdate).eq('payment_pk',payment.payment_pk);
  if (updateError) throw updateError;

  if (Object.keys(providerUpdate).length>1) {
    const { error:providerError }=await db.from('payment_provider_data').update(providerUpdate).eq('payment_pk',payment.payment_pk);
    if (providerError) throw providerError;
  }

  if (body.sndPam || body.sndPhoneMasked) {
    const { error:payerError }=await db.from('payment_payer_data').upsert({
      payment_pk:payment.payment_pk,
      payer_pam_masked:body.sndPam || null,
      payer_phone_masked:body.sndPhoneMasked || null,
      updated_at:new Date().toISOString(),
    },{onConflict:'payment_pk'});
    if (payerError) throw payerError;
  }

  const { error:eventError }=await db.from('payment_provider_events').insert({
    payment_pk:payment.payment_pk,
    bank_id:payment.bank_id || null,
    direction:'inbound',
    event_type:notificationType,
    provider_code:providerCode,
    http_status:200,
    payload:body,
    headers,
    occurred_at:receivedAt,
  });
  if (eventError) throw eventError;
}

async function saveSubscriptionInstrument(payment, body) {
  const db=getSupabaseAdminClient();
  const providerInstrumentId=String(body.subscriptionToken || body.qrcId || payment.qrc_id || '').trim();
  if (!providerInstrumentId) return null;

  const { data:session, error:sessionError }=await db
    .from('checkout_sessions')
    .select('id,customer_id,partner_terminal_id,is_subscription')
    .eq('payment_pk',payment.payment_pk)
    .eq('is_subscription',true)
    .maybeSingle();
  if (sessionError) throw sessionError;

  const record={
    partner_id:payment.partner_id,
    project_id:payment.project_id || null,
    customer_id:session?.customer_id || null,
    origin_session_id:session?.id || null,
    partner_terminal_id:payment.partner_terminal_id || session?.partner_terminal_id || null,
    payment_method:'SBP',
    provider_instrument_id:providerInstrumentId,
    subscription_qrc_id:body.qrcId || payment.qrc_id || null,
    status:'active',
    updated_at:new Date().toISOString(),
  };

  const { data:existing, error:findError }=await db
    .from('checkout_subscription_instruments')
    .select('id')
    .eq('partner_id',payment.partner_id)
    .eq('payment_method','SBP')
    .eq('provider_instrument_id',providerInstrumentId)
    .maybeSingle();
  if (findError) throw findError;

  if (existing) {
    const { error }=await db.from('checkout_subscription_instruments').update(record).eq('id',existing.id);
    if (error) throw error;
    return existing.id;
  }

  const { data, error }=await db.from('checkout_subscription_instruments').insert(record).select('id').single();
  if (error) throw error;
  return data?.id || null;
}

async function findRelatedPayment(notificationType, body) {
  const db=getSupabaseAdminClient();

  if (['c2b_payment','subscription'].includes(notificationType) && body.qrcId) {
    const { data,error }=await db.from('payments').select('*,payment_provider_data(*)')
      .eq('qrc_id',body.qrcId).in('qrc_type',['02','03'])
      .order('created_at',{ascending:false}).limit(1).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  if (notificationType==='b2c_refund') {
    if (body.internalTrxId) {
      const { data:refund,error:refundError }=await db.from('payment_refunds')
        .select('payment_pk,metadata').contains('metadata',{internalTxId:String(body.internalTrxId)})
        .order('requested_at',{ascending:false}).limit(1).maybeSingle();
      if (!refundError && refund?.payment_pk) return findPaymentByPk(refund.payment_pk);
    }
    if (body.orgnlTrxId) {
      const { data:pd,error }=await db.from('payment_provider_data').select('payment_pk')
        .eq('provider_trx_id',body.orgnlTrxId).maybeSingle();
      if (error) throw error;
      if (pd?.payment_pk) return findPaymentByPk(pd.payment_pk);
    }
  }

  if (notificationType==='b2c_transfer' && isUuid(body.internalTrxId)) {
    const { data,error }=await db.from('payments').select('*,payment_provider_data(*)').eq('id',body.internalTrxId).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  return null;
}

async function findPaymentByProviderOrderId(orderId) {
  const db=getSupabaseAdminClient();
  const { data:pd,error }=await db.from('payment_provider_data').select('payment_pk').eq('provider_order_id',orderId).maybeSingle();
  if (error) throw error;
  return pd?.payment_pk ? findPaymentByPk(pd.payment_pk) : null;
}

async function findPaymentByPk(paymentPk) {
  const db=getSupabaseAdminClient();
  const { data,error }=await db.from('payments').select('*,payment_provider_data(*)').eq('payment_pk',paymentPk).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function findOpenRefund(paymentPk, body) {
  const db=getSupabaseAdminClient();
  let query=db.from('payment_refunds').select('*').eq('payment_pk',paymentPk)
    .in('status',['requested','processing']);
  if (body.internalTrxId) {
    const { data,error }=await query.order('requested_at',{ascending:false}).limit(10);
    if (error) throw error;
    return (data || []).find((row)=>String(row.metadata?.internalTxId || '')===String(body.internalTrxId)) || data?.[0] || null;
  }
  const { data,error }=await query.order('requested_at',{ascending:false}).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function recordInbox({ providerCode,eventKey,notificationType,headers,body,paymentPk,receivedAt,status }) {
  const db=getSupabaseAdminClient();
  const { data,error }=await db.from('webhook_inbox').insert({
    provider_code:providerCode,
    event_key:eventKey,
    payment_pk:paymentPk,
    event_type:notificationType,
    headers,
    payload:body,
    processing_status:status,
    received_at:receivedAt,
  }).select('id').maybeSingle();

  if (error?.code==='23505') return true;
  if (error) throw error;
  return false;
}

async function markInbox(providerCode,eventKey,status,errorMessage) {
  const db=getSupabaseAdminClient();
  const { error }=await db.from('webhook_inbox').update({
    processing_status:status,
    processing_error:errorMessage || null,
    processed_at:new Date().toISOString(),
  }).eq('provider_code',providerCode).eq('event_key',eventKey);
  if (error) throw error;
}

function genericEventKey(type,body) {
  return [
    type,
    body.trxId || '',
    body.qrcId || '',
    body.internalTrxId || '',
    body.orgnlTrxId || '',
    body.status || '',
  ].join(':').slice(0,500);
}

function verifyIngoSignature(params, token) {
  if (!token) return false;
  const checksum=String(params.checksum || '').trim().toUpperCase();
  if (!checksum) return false;
  const signed=Object.entries(params)
    .filter(([key,value])=>!['checksum','sign_alias'].includes(key) && value!==undefined && value!==null)
    .sort(([a],[b])=>a<b?-1:a>b?1:0)
    .map(([key,value])=>`${key};${String(value)};`).join('');
  const expected=crypto.createHmac('sha256',token).update(signed,'utf8').digest('hex').toUpperCase();
  return checksum.length===expected.length
    && crypto.timingSafeEqual(Buffer.from(checksum,'ascii'),Buffer.from(expected,'ascii'));
}

function normalizeAmount(value,fallback) {
  if (value===undefined || value===null || value==='') return Number(fallback || 0);
  const numeric=Number(value);
  return Number.isFinite(numeric)?numeric:Number(fallback || 0);
}

function parseIsoDateOrNull(value) {
  if (!value) return null;
  const date=new Date(value);
  return Number.isNaN(date.getTime())?null:date.toISOString();
}

function normalizeSubscriptionStatus(body={}) {
  const code=String(body.code || '').toUpperCase();
  const status=String(body.status || '').toUpperCase();
  if (code==='RQ00000' || code==='RS00000' || status==='CONFIRMED' || status==='ACSC') return 'subscription_confirmed';
  if (code==='RQ05030' && status==='RJCT') return 'subscription_rejected';
  return 'subscription_failed';
}

function normalizeRefundStatus(value) {
  const status=String(value || '').trim().toUpperCase();
  if (['CONFIRMED','COMPLETED','SUCCESS','SUCCEEDED','ACSC'].includes(status)) return 'refund_confirmed';
  if (['ERROR','FAILED','FAILURE'].includes(status)) return 'refund_failed';
  return 'refund_refused';
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value));
}

module.exports={
  detectNotificationType,
  processGenericBankWebhook,
  processIngoWebhook,
  verifyIngoSignature,
  normalizeSubscriptionStatus,
  normalizeRefundStatus,
};
