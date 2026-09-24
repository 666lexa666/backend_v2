const { getSupabaseAdminClient } = require('./supabase');

async function selectTerminalForPayment({ partnerId, projectId = null, terminalId = null, method = 'SBP', amountMinor }) {
  const db=getSupabaseAdminClient();
  let query=db.from('partner_payment_routes_v2')
    .select('*')
    .eq('partner_id',partnerId)
    .eq('payment_method',String(method).toUpperCase());

  if(projectId) query=query.eq('project_id',projectId);

  const {data,error}=await query
    .order('is_default',{ascending:false})
    .order('partner_terminal_id',{ascending:true});
  if(error) throw error;

  const rows=data || [];
  if(terminalId){
    return rows.find((row)=>row.partner_terminal_id===terminalId || row.terminal_id===terminalId) || null;
  }

  const amount=Number(amountMinor);
  const eligible=rows.filter((row)=>{
    const min=row.effective_min_amount_minor==null?null:Number(row.effective_min_amount_minor);
    const max=row.effective_max_amount_minor==null?null:Number(row.effective_max_amount_minor);
    return (min==null || amount>=min) && (max==null || amount<=max);
  });

  return eligible.find((row)=>row.is_default) || eligible[0] || null;
}

async function loadTerminalRuntime(assignment) {
  if(!assignment) return null;
  let row=assignment;

  if(!row.partner_terminal_id || row.bank_id===undefined){
    const id=row.id || row.partner_terminal_id;
    if(!id) return null;
    const db=getSupabaseAdminClient();
    const {data,error}=await db.from('partner_payment_routes_v2').select('*').eq('partner_terminal_id',id).maybeSingle();
    if(error) throw error;
    row=data;
  }

  if(!row) return null;

  const provider={
    ...(row.terminal_provider_config || {}),
    ...(row.assignment_provider_config || {}),
  };
  const settings={
    ...(row.assignment_settings || {}),
  };

  return {
    assignmentId:row.partner_terminal_id,
    partnerId:row.partner_id,
    projectId:row.project_id,
    terminalId:row.terminal_id,
    bankId:row.bank_id,
    providerCode:row.provider_code || null,
    bankPaymentMethods:row.bank_payment_methods || [],
    paymentMethod:row.payment_method,
    companyName:row.company_name || null,
    label:row.label || row.terminal_name || null,
    merchantId:provider.merchant_id ?? row.catalog_merchant_id ?? null,
    extEntityId:provider.ext_entity_id ?? row.catalog_ext_entity_id ?? null,
    account:provider.account ?? row.catalog_account ?? null,
    accAlias:provider.acc_alias ?? row.catalog_acc_alias ?? null,
    supportsRecurrentPayments:Boolean(row.supports_recurrent_payments),
    providerConfig:provider,
    settings,
    minAmountMinor:row.effective_min_amount_minor ?? null,
    maxAmountMinor:row.effective_max_amount_minor ?? null,
  };
}

async function createPaymentCore(input) {
  const db=getSupabaseAdminClient();
  const partnerId=Number(input.partnerId);
  const amountMinor=Number(input.amountMinor);

  if(!Number.isSafeInteger(partnerId) || partnerId<=0) throw apiError(400,'VALIDATION_ERROR','partnerId некорректен');
  if(!Number.isSafeInteger(amountMinor) || amountMinor<=0) throw apiError(400,'VALIDATION_ERROR','amount должен быть положительным целым числом в копейках');

  const method=String(input.method || 'SBP').toUpperCase();
  if(!['SBP','CARD'].includes(method)) throw apiError(400,'VALIDATION_ERROR','method должен быть SBP или CARD');

  const assignment=await selectTerminalForPayment({
    partnerId,
    projectId:input.projectId || null,
    terminalId:input.terminalId || null,
    method,
    amountMinor,
  });
  if(!assignment) throw apiError(400,'TERMINAL_NOT_AVAILABLE','Подходящий активный терминал не найден');

  const runtime=await loadTerminalRuntime(assignment);
  if(!runtime) throw apiError(409,'TERMINAL_RUNTIME_NOT_FOUND','Конфигурация терминала недоступна');

  const metadata={
    apiVersion:input.apiVersion || 'v2',
    paymentPurpose:input.paymentPurpose || null,
    clientWebhookUrl:input.webhookUrl || null,
    redirectUrl:input.redirectUrl || null,
    qrcType:input.qrcType || null,
    subscriptionPurpose:input.subscriptionPurpose || null,
    subscriptionServiceId:input.subscriptionServiceId || null,
    subscriptionServiceName:input.subscriptionServiceName || null,
    clientPhone:input.clientPhone || null,
    clientPam:input.clientPam || null,
    legacy:input.legacy || null,
  };

  const terminalSnapshot={
    assignmentId:runtime.assignmentId,
    terminalId:runtime.terminalId,
    bankId:runtime.bankId,
    providerCode:runtime.providerCode,
    companyName:runtime.companyName,
    label:runtime.label,
    merchantId:runtime.merchantId,
    extEntityId:runtime.extEntityId,
    account:runtime.account,
    accAlias:runtime.accAlias,
    paymentMethod:runtime.paymentMethod,
    supportsRecurrentPayments:runtime.supportsRecurrentPayments,
    providerConfig:runtime.providerConfig,
  };

  const {data:payment,error}=await db.rpc('create_payment_v2',{
    p_partner_id:partnerId,
    p_project_id:runtime.projectId || input.projectId || null,
    p_partner_terminal_id:runtime.assignmentId,
    p_bank_id:runtime.bankId,
    p_payment_type:method,
    p_qrc_type:input.qrcType || null,
    p_partner_order_id:input.orderId || null,
    p_amount_minor:amountMinor,
    p_currency:String(input.currency || 'RUB').toUpperCase(),
    p_status:'creating',
    p_commission_percent:input.commissionPercent ?? null,
    p_currency_rate_rub:input.currencyRateRub ?? 1,
    p_metadata:metadata,
    p_terminal_snapshot:terminalSnapshot,
    p_routing_snapshot:{
      requestedProjectId:input.projectId || null,
      requestedTerminalId:input.terminalId || null,
      selectedPartnerTerminalId:runtime.assignmentId,
    },
  });
  if(error) throw error;

  return {payment,runtime,requestId:payment.request_id};
}

async function getPartnerPayment(partnerId,paymentId) {
  const db=getSupabaseAdminClient();
  const {data:payment,error}=await db.from('payments')
    .select('*,payment_provider_data(*),payment_refunds(*)')
    .eq('id',paymentId)
    .eq('partner_id',partnerId)
    .maybeSingle();
  if(error) throw error;
  return payment || null;
}

async function setPaymentProviderResult(paymentPk,update={}) {
  const db=getSupabaseAdminClient();
  const providerUpdate={updated_at:new Date().toISOString()};
  if(update.providerCode!==undefined) providerUpdate.provider_code=update.providerCode;
  if(update.providerOrderId!==undefined) providerUpdate.provider_order_id=update.providerOrderId;
  if(update.qrcId!==undefined) providerUpdate.provider_qrc_id=update.qrcId;
  if(update.providerBindingId!==undefined) providerUpdate.provider_binding_id=update.providerBindingId;
  if(update.providerTrxId!==undefined) providerUpdate.provider_trx_id=update.providerTrxId;
  if(update.providerTrxTime!==undefined) providerUpdate.provider_trx_time=update.providerTrxTime;
  if(update.qrPayload!==undefined) providerUpdate.qr_payload=update.qrPayload;
  if(update.subscriptionToken!==undefined) providerUpdate.subscription_token=update.subscriptionToken;
  if(update.subscriptionMemberId!==undefined) providerUpdate.subscription_member_id=update.subscriptionMemberId;

  const {error}=await db.from('payment_provider_data').update(providerUpdate).eq('payment_pk',paymentPk);
  if(error) throw error;

  const paymentUpdate={};
  if(update.status!==undefined) paymentUpdate.status=update.status;
  if(update.qrcId!==undefined) paymentUpdate.qrc_id=update.qrcId;
  if(update.providerPaymentId!==undefined) paymentUpdate.provider_payment_id=update.providerPaymentId;
  if(update.paidAt!==undefined) paymentUpdate.paid_at=update.paidAt;
  if(update.expiresAt!==undefined) paymentUpdate.expires_at=update.expiresAt;

  if(Object.keys(paymentUpdate).length){
    paymentUpdate.updated_at=new Date().toISOString();
    const {error:paymentError}=await db.from('payments').update(paymentUpdate).eq('payment_pk',paymentPk);
    if(paymentError) throw paymentError;
  }
}

async function markPaymentFailed(paymentPk,error) {
  const db=getSupabaseAdminClient();
  const {data:current,error:readError}=await db.from('payments').select('metadata').eq('payment_pk',paymentPk).maybeSingle();
  if(readError) throw readError;

  const {error:paymentError}=await db.from('payments').update({
    status:'failed',
    updated_at:new Date().toISOString(),
    metadata:{
      ...(current?.metadata || {}),
      providerError:{
        message:error?.message || 'Unknown provider error',
        statusCode:error?.statusCode || null,
        responseBody:error?.responseBody || null,
      },
    },
  }).eq('payment_pk',paymentPk);
  if(paymentError) throw paymentError;
}

function apiError(statusCode,code,message,details=null) {
  const error=new Error(message);
  error.statusCode=statusCode;
  error.code=code;
  if(details) error.details=details;
  return error;
}

module.exports={
  createPaymentCore,
  getPartnerPayment,
  setPaymentProviderResult,
  markPaymentFailed,
  selectTerminalForPayment,
  loadTerminalRuntime,
  apiError,
};
