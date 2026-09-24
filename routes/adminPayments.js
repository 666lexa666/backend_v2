const express = require('express');
const { auth } = require('../lib/auth');
const { getSupabaseAdminClient } = require('../lib/supabase');
const { refundPayment } = require('../lib/refundService');
const { hydrateLegacyPartner } = require('../lib/partnerApiAuth');
const { enqueuePartnerWebhook } = require('../lib/partnerWebhookOutbox');
const { previewAllPartnerPayouts } = require('../lib/payoutService');

const router = express.Router();
router.use(auth({ admin: true }));

router.get('/payments/export', async (req,res,next)=>{
  try{
    const format=String(req.query.format || 'csv').toLowerCase();
    if(format!=='csv') return res.status(400).json({
      success:false,
      error:'EXPORT_FORMAT_NOT_SUPPORTED',
      message:'В V2 синхронный экспорт поддерживает CSV. XLSX будет вынесен в background job.',
    });
    const db=getSupabaseAdminClient();
    const rows=[];
    const pageSize=1000;
    const maxRows=20000;
    for(let offset=0;offset<maxRows;offset+=pageSize){
      let query=db.from('portal_payments_v2').select('*');
      query=applyPaymentFilters(query,req.query);
      const {data,error}=await query.order('created_at',{ascending:false}).order('payment_pk',{ascending:false}).range(offset,offset+pageSize-1);
      if(error) throw error;
      rows.push(...(data || []));
      if(!data || data.length<pageSize) break;
    }
    if(rows.length>=maxRows){
      return res.status(413).json({
        success:false,
        error:'EXPORT_TOO_LARGE',
        message:`Синхронная выгрузка ограничена ${maxRows} строками. Сузьте период или фильтры.`,
      });
    }
    const fields=parseExportFields(req.query.fields);
    const csv=toCsv(rows.map(publicPayment),fields);
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="whitecapital-payments-${new Date().toISOString().slice(0,10)}.csv"`);
    return res.send('\uFEFF'+csv);
  }catch(error){next(error);}
});

router.get('/payments', async(req,res,next)=>{
  try{
    const page=Math.max(1,Number(req.query.page || 1));
    const pageSize=Math.min(100,Math.max(1,Number(req.query.pageSize || 25)));
    const from=(page-1)*pageSize;
    const db=getSupabaseAdminClient();
    let query=db.from('portal_payments_v2').select('*',{count:'planned'});
    query=applyPaymentFilters(query,req.query);
    const {data,error,count}=await query.order('created_at',{ascending:false}).order('payment_pk',{ascending:false}).range(from,from+pageSize);
    if(error) throw error;
    const rows=data || [];
    return res.json({
      success:true,
      payments:rows.slice(0,pageSize).map(publicPayment),
      count:Number(count || 0),
      hasNext:rows.length>pageSize,
      page,
      pageSize,
    });
  }catch(error){next(error);}
});

router.get('/payments/:paymentId',async(req,res,next)=>{
  try{
    const db=getSupabaseAdminClient();
    const {data,error}=await db.from('portal_payments_v2').select('*').eq('id',req.params.paymentId).maybeSingle();
    if(error) throw error;
    if(!data) return res.status(404).json({success:false,error:'PAYMENT_NOT_FOUND',message:'Платёж не найден'});
    return res.json({success:true,payment:publicPayment(data)});
  }catch(error){next(error);}
});

router.get('/partners/:id/payments',async(req,res,next)=>{
  try{
    const partnerId=parsePartnerId(req.params.id);
    if(!partnerId) return invalidPartnerId(res);
    const page=Math.max(1,Number(req.query.page || 1));
    const pageSize=Math.min(100,Math.max(1,Number(req.query.pageSize || 25)));
    const from=(page-1)*pageSize;
    const db=getSupabaseAdminClient();
    let query=db.from('portal_payments_v2').select('*',{count:'planned'}).eq('partner_id',partnerId);
    query=applyPaymentFilters(query,req.query,{skipPartner:true});
    const {data,error,count}=await query.order('created_at',{ascending:false}).order('payment_pk',{ascending:false}).range(from,from+pageSize);
    if(error) throw error;
    const rows=data || [];
    return res.json({
      success:true,
      payments:rows.slice(0,pageSize).map(publicPayment),
      count:Number(count || 0),
      hasNext:rows.length>pageSize,
      page,
      pageSize,
    });
  }catch(error){next(error);}
});

router.get('/partners/:id/payments/:paymentId',async(req,res,next)=>{
  try{
    const partnerId=parsePartnerId(req.params.id);
    if(!partnerId) return invalidPartnerId(res);
    const db=getSupabaseAdminClient();
    const {data,error}=await db.from('portal_payments_v2').select('*')
      .eq('id',req.params.paymentId).eq('partner_id',partnerId).maybeSingle();
    if(error) throw error;
    if(!data) return res.status(404).json({success:false,error:'PAYMENT_NOT_FOUND',message:'Платёж не найден'});
    return res.json({success:true,payment:publicPayment(data)});
  }catch(error){next(error);}
});

router.post('/partners/:id/payments/:paymentId/refund',async(req,res,next)=>{
  try{
    const partnerId=parsePartnerId(req.params.id);
    if(!partnerId) return invalidPartnerId(res);
    const db=getSupabaseAdminClient();
    const {data:partner,error:partnerError}=await db.from('partners').select('*').eq('id',partnerId).eq('is_admin',false).maybeSingle();
    if(partnerError) throw partnerError;
    if(!partner) return res.status(404).json({success:false,error:'PARTNER_NOT_FOUND',message:'Партнёр не найден'});
    const result=await refundPayment({
      partner:hydrateLegacyPartner(partner),
      paymentId:req.params.paymentId,
      amount:req.body?.amount==null?null:Number(req.body.amount),
      remitInfo:String(req.body?.remitInfo || `Полный возврат администратором по платежу ${req.params.paymentId}`).slice(0,140),
    });
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
    if(error.statusCode && error.code) return res.status(error.statusCode).json({
      success:false,error:error.code,message:error.message,...(error.details?{details:error.details}:{})
    });
    next(error);
  }
});

router.post('/partners/:id/payments/:paymentId/confirm-success',async(req,res,next)=>{
  try{
    const partnerId=parsePartnerId(req.params.id);
    if(!partnerId) return invalidPartnerId(res);
    const db=getSupabaseAdminClient();
    const now=new Date().toISOString();
    const trxId=`admin-manual-${req.params.paymentId}`;

    const {data:updated,error:updateError}=await db.from('payments').update({
      status:'success',
      paid_at:now,
      provider_payment_id:trxId,
      updated_at:now,
      metadata:{adminManualConfirm:{adminId:req.partner.id,confirmedAt:now}},
    }).eq('id',req.params.paymentId).eq('partner_id',partnerId).in('status',['creating','pending']).select('*').maybeSingle();
    if(updateError) throw updateError;
    if(!updated){
      const {data:current,error:currentError}=await db.from('payments').select('status').eq('id',req.params.paymentId).eq('partner_id',partnerId).maybeSingle();
      if(currentError) throw currentError;
      if(!current) return res.status(404).json({success:false,error:'PAYMENT_NOT_FOUND',message:'Платёж не найден'});
      return res.status(409).json({
        success:false,error:'PAYMENT_STATE_CHANGED',
        message:`Подтвердить вручную можно только платёж в creating/pending. Текущий статус: ${current.status}`,
      });
    }

    const {data:provider}=await db.from('payment_provider_data').select('provider_code').eq('payment_pk',updated.payment_pk).maybeSingle();
    await db.from('payment_provider_data').update({
      provider_trx_id:trxId,
      provider_trx_time:now,
      updated_at:now,
    }).eq('payment_pk',updated.payment_pk);

    const syntheticBody={
      trxId,
      trxTime:now,
      cur:'RUB',
      amount:Number(updated.amount_minor),
      qrcId:updated.qrc_id || null,
      qrcType:updated.qrc_type || null,
      sndPam:null,
      sndPhoneMasked:null,
    };
    await db.from('payment_provider_events').insert({
      payment_pk:updated.payment_pk,
      bank_id:updated.bank_id || null,
      direction:'inbound',
      event_type:'c2b_payment',
      provider_code:provider?.provider_code || 'admin_manual',
      http_status:200,
      payload:syntheticBody,
      headers:{source:'admin_manual_confirm',adminId:req.partner.id},
      occurred_at:now,
    });
    await enqueuePartnerWebhook({paymentId:updated.id,notificationType:'c2b_payment',body:syntheticBody});

    const {data:detail,error:detailError}=await db.from('portal_payments_v2').select('*').eq('id',updated.id).maybeSingle();
    if(detailError) throw detailError;
    return res.json({success:true,payment:publicPayment(detail || updated),manuallyConfirmed:true});
  }catch(error){next(error);}
});

router.get('/partners/:id/statistics',async(req,res,next)=>{
  try{
    const partnerId=parsePartnerId(req.params.id);
    if(!partnerId) return invalidPartnerId(res);
    const db=getSupabaseAdminClient();
    const period=normalizePeriod(req.query.period);
    const range=resolveStatsRange(req.query,period);
    const projectId=req.query.projectId?String(req.query.projectId):null;
    const terminalId=req.query.terminalId?String(req.query.terminalId):null;
    const tspName=String(req.query.terminalTspName || '').trim();
    const terminalIds=terminalId?[terminalId]:await terminalIdsForTsp(db,partnerId,projectId,tspName);
    const useHourly=Boolean(terminalId || tspName || period==='day');
    let query=db.from(useHourly?'payment_stats_hourly':'payment_stats_daily').select('*').eq('partner_id',partnerId);
    if(projectId) query=query.eq('project_id',projectId);
    if(useHourly){
      query=query.gte('bucket_start',range.from).lt('bucket_start',range.to);
      if((terminalId || tspName) && terminalIds.length) query=query.in('partner_terminal_id',terminalIds);
      if((terminalId || tspName) && !terminalIds.length) return res.json({success:true,stats:emptyStats(),period,from:range.from,to:range.to});
    }else{
      query=query.gte('business_day',moscowDate(range.from)).lte('business_day',moscowDate(new Date(new Date(range.to).getTime()-1)));
    }
    const {data,error}=await query;
    if(error) throw error;

    let refundQuery=db.from('portal_refunds_v2').select('amount_minor,status,completed_at,partner_terminal_id').eq('partner_id',partnerId).eq('status','confirmed').gte('completed_at',range.from).lt('completed_at',range.to);
    if(projectId) refundQuery=refundQuery.eq('project_id',projectId);
    if((terminalId || tspName) && terminalIds.length) refundQuery=refundQuery.in('partner_terminal_id',terminalIds);
    const {data:refunds,error:refundError}=await refundQuery;
    if(refundError) throw refundError;

    const stats=buildPartnerStats(data || [],period,useHourly,refunds || []);
    const {data:partner,error:partnerError}=await db.from('partners').select('commission_percent').eq('id',partnerId).maybeSingle();
    if(partnerError) throw partnerError;
    stats.commissionPercent=Number(partner?.commission_percent || 0);
    stats.netTotal=Math.round(stats.total*(1-stats.commissionPercent/100));
    return res.json({success:true,stats,period,from:range.from,to:range.to});
  }catch(error){next(error);}
});

router.get('/partners/:id/terminal-statistics-options',async(req,res,next)=>{
  try{
    const partnerId=parsePartnerId(req.params.id);
    if(!partnerId) return invalidPartnerId(res);
    const db=getSupabaseAdminClient();
    let query=db.from('partner_visible_terminals_v2').select('id,project_id,company_name,label,is_active').eq('partner_id',partnerId);
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

router.get('/stats',async(req,res,next)=>{
  try{
    const db=getSupabaseAdminClient();
    const period=normalizePeriod(req.query.period);
    const range=resolveStatsRange(req.query,period);
    const fromDay=moscowDate(range.from);
    const toDay=moscowDate(new Date(new Date(range.to).getTime()-1));
    const {data,error}=await db.from('payment_stats_daily').select('*')
      .neq('partner_id',1).gte('business_day',fromDay).lte('business_day',toDay);
    if(error) throw error;

    const partnerIds=[...new Set((data || []).map((row)=>Number(row.partner_id)).filter(Number.isFinite))];
    let partners=[];
    if(partnerIds.length){
      const {data:partnerRows,error:partnerError}=await db.from('partners').select('id,company_name,email,login,commission_percent').in('id',partnerIds);
      if(partnerError) throw partnerError;
      partners=partnerRows || [];
    }
    const meta={};
    const commission={};
    for(const p of partners){
      meta[p.id]={name:p.company_name || p.email || p.login || `#${p.id}`,login:p.email || p.login || '—'};
      commission[p.id]=Number(p.commission_percent || 0);
    }

    const {data:refunds,error:refundError}=await db.from('portal_refunds_v2').select('partner_id,amount_minor,completed_at')
      .neq('partner_id',1).eq('status','confirmed').gte('completed_at',range.from).lt('completed_at',range.to);
    if(refundError) throw refundError;

    const stats=buildAdminStats(data || [],period,meta,commission,refunds || []);
    return res.json({success:true,period,from:range.from,to:range.to,stats});
  }catch(error){next(error);}
});

router.get('/stats/day-partners',async(req,res,next)=>{
  try{
    const day=String(req.query.day || '').slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'Укажите дату YYYY-MM-DD'});
    const db=getSupabaseAdminClient();
    const {data,error}=await db.from('payment_stats_daily').select('*').neq('partner_id',1).eq('business_day',day);
    if(error) throw error;
    const partnerIds=[...new Set((data || []).map((row)=>Number(row.partner_id)).filter(Number.isFinite))];
    let partners=[];
    if(partnerIds.length){
      const {data:p,error:pError}=await db.from('partners').select('id,company_name,email,login,commission_percent').in('id',partnerIds);
      if(pError) throw pError;
      partners=p || [];
    }
    const meta={},commission={};
    for(const p of partners){
      meta[p.id]={name:p.company_name || p.email || p.login || `#${p.id}`,login:p.email || p.login || '—'};
      commission[p.id]=Number(p.commission_percent || 0);
    }
    const stats=buildAdminStats(data || [],'month',meta,commission,[]);
    return res.json({success:true,day,partners:stats.byPartner});
  }catch(error){next(error);}
});

router.get('/stats/export',async(req,res,next)=>{
  try{
    const db=getSupabaseAdminClient();
    const range=resolveStatsRange(req.query,'month');
    const fromDay=moscowDate(range.from);
    const toDay=moscowDate(new Date(new Date(range.to).getTime()-1));
    let query=db.from('payment_stats_daily').select('*').gte('business_day',fromDay).lte('business_day',toDay);
    const explicitIds=String(req.query.partnerIds || '').split(',').map((x)=>Number(x)).filter(Number.isFinite);
    if(explicitIds.length) query=query.in('partner_id',explicitIds);
    else query=query.neq('partner_id',1);
    const {data,error}=await query;
    if(error) throw error;
    const ids=[...new Set((data || []).map((row)=>Number(row.partner_id)).filter(Number.isFinite))];
    let partners=[];
    if(ids.length){
      const {data:p,error:pError}=await db.from('partners').select('id,company_name,email,login,commission_percent').in('id',ids);
      if(pError) throw pError;
      partners=p || [];
    }
    const meta={},commission={};
    for(const p of partners){
      meta[p.id]={name:p.company_name || p.email || p.login || `#${p.id}`,login:p.email || p.login || '—'};
      commission[p.id]=Number(p.commission_percent || 0);
    }
    const stats=buildAdminStats(data || [],'month',meta,commission,[]);
    const csv=['partner_id,name,login,success_amount_minor,success_count,commission_percent,net_amount_minor'];
    for(const row of stats.byPartner){
      csv.push([
        row.partnerId,
        csvValue(row.name),
        csvValue(row.login),
        row.amount,
        row.success,
        row.commissionPercent,
        row.netAmount,
      ].join(','));
    }
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="whitecapital-stats-${fromDay}_${toDay}.csv"`);
    return res.send('\uFEFF'+csv.join('\n'));
  }catch(error){next(error);}
});

router.get('/payout-summary',async(req,res,next)=>{
  try{
    const summary=await previewAllPartnerPayouts(req.query.date?String(req.query.date):null);
    return res.json({success:true,summary});
  }catch(error){next(error);}
});

function applyPaymentFilters(query,params,{skipPartner=false}={}){
  if(!skipPartner){
    const partnerIds=toArray(params.partnerId).map(Number).filter(Number.isFinite);
    if(partnerIds.length) query=query.in('partner_id',partnerIds);
  }
  const projectIds=toArray(params.projectId).filter(isUuid);
  if(projectIds.length) query=query.in('project_id',projectIds);
  const terminalIds=toArray(params.terminalId).filter(isUuid);
  if(terminalIds.length) query=query.in('partner_terminal_id',terminalIds);
  const catalogIds=toArray(params.catalogTerminalId).filter(isUuid);
  if(catalogIds.length) query=query.in('catalog_terminal_id',catalogIds);

  const types=toArray(params.payment_type).map((x)=>String(x).toUpperCase()).filter((x)=>['SBP','CARD'].includes(x));
  if(types.length) query=query.in('payment_type',types);

  const statuses=toArray(params.status).filter((x)=>KNOWN_STATUSES.has(String(x)));
  if(statuses.length){
    const regular=statuses.filter((x)=>!String(x).startsWith('refund_')).map(normalizeInternalStatus);
    const refunds=statuses.filter((x)=>String(x).startsWith('refund_')).map((x)=>String(x).replace(/^refund_/,''));
    if(regular.length && refunds.length){
      query=query.or(`status.in.(${regular.join(',')}),refund_status.in.(${refunds.join(',')})`);
    }else if(regular.length) query=query.in('status',regular);
    else query=query.in('refund_status',refunds);
  }

  if(params.from) query=query.gte('created_at',moscowDayStart(String(params.from)));
  if(params.to) query=query.lt('created_at',moscowDayAfter(String(params.to)));
  query=applySearch(query,String(params.query || '').trim(),String(params.searchField || params.search_field || 'all'));
  return query;
}

function applySearch(query,value,field){
  if(!value) return query;
  const q=value.replace(/[(),]/g,' ').trim();
  const map={order_id:'partner_order_id',qrc_id:'qrc_id',trx_id:'trx_id',bank_order_id:'bank_order_id',payment_purpose:'payment_purpose',qr_payload:'qr_payload'};
  if(field==='payment_id') return isUuid(q)?query.eq('id',q):query.eq('id','00000000-0000-0000-0000-000000000000');
  if(field==='terminal_id') return isUuid(q)?query.eq('partner_terminal_id',q):query.eq('partner_terminal_id','00000000-0000-0000-0000-000000000000');
  if(map[field]) return query.ilike(map[field],`%${q}%`);
  const filters=[`partner_order_id.ilike.%${q}%`,`qrc_id.ilike.%${q}%`,`trx_id.ilike.%${q}%`,`bank_order_id.ilike.%${q}%`,`payment_purpose.ilike.%${q}%`,`qr_payload.ilike.%${q}%`];
  if(isUuid(q)) filters.push(`id.eq.${q}`,`partner_terminal_id.eq.${q}`);
  return query.or(filters.join(','));
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
  return {...row,status,amount:Number(row.amount ?? row.amount_minor ?? 0),amount_minor:Number(row.amount_minor || 0),refund_amount:row.refund_amount==null?null:Number(row.refund_amount)};
}

function buildPartnerStats(rows,period,hourly,refundRows){
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
  if(refundRows?.length) statusMap.set('Возврат подтвержден',refundRows.length);
  const list=(map)=>[...map.entries()].map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value);
  const timeline=[...timelineMap.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>({key,...v,avg:v.count?v.value/v.count:0})).slice(-92);
  return {total,count,pending,failed,failedTotal,canceled,canceledTotal,refunded:refundRows?.length || 0,refundedTotal,avg:count?total/count:0,allCount,successRate:allCount?Math.round(count/allCount*100):0,timeline,byMethod:list(methodMap),byStatus:list(statusMap)};
}

function buildAdminStats(rows,period,partnerMeta,commissionById,refundRows){
  const partnerMap={},dayMap={},timeMap={},methodMap={},statusMap={};
  let total=0,successCount=0,pending=0,failed=0,failedTotal=0,canceled=0,canceledTotal=0,allCount=0;
  for(const row of rows){
    const status=String(row.status || '');
    const cnt=Number(row.count || 0);
    const amount=Number(row.amount_minor || 0);
    const partnerId=Number(row.partner_id);
    const day=String(row.business_day);
    const success=['success','subscription_confirmed'].includes(status);
    const isPending=['creating','pending'].includes(status);
    const isFailed=['failed','subscription_failed','subscription_rejected','expired','canceled'].includes(status);
    allCount+=cnt;
    if(isPending) pending+=cnt;
    if(isFailed){failed+=cnt;failedTotal+=amount;}
    if(['expired','canceled'].includes(status)){canceled+=cnt;canceledTotal+=amount;}
    const method=methodLabel(row.payment_type);
    methodMap[method]=(methodMap[method] || 0)+cnt;
    const label=statusLabel(status);
    statusMap[label]=(statusMap[label] || 0)+cnt;

    const meta=partnerMeta[partnerId] || {};
    if(!partnerMap[partnerId]) partnerMap[partnerId]={partnerId,name:meta.name || `#${partnerId}`,login:meta.login || '—',amount:0,count:0,success:0,failed:0,pending:0};
    partnerMap[partnerId].count+=cnt;
    if(success){partnerMap[partnerId].amount+=amount;partnerMap[partnerId].success+=cnt;}
    if(isFailed) partnerMap[partnerId].failed+=cnt;
    if(isPending) partnerMap[partnerId].pending+=cnt;

    if(!dayMap[day]) dayMap[day]={day,amount:0,count:0,success:0,failed:0,pending:0};
    dayMap[day].count+=cnt;
    if(success){dayMap[day].amount+=amount;dayMap[day].success+=cnt;}
    if(isFailed) dayMap[day].failed+=cnt;
    if(isPending) dayMap[day].pending+=cnt;

    if(!success) continue;
    total+=amount;successCount+=cnt;
    const key=period==='year'?day.slice(0,7):day;
    const name=period==='year'?day.slice(5,7):`${day.slice(8,10)}.${day.slice(5,7)}`;
    if(!timeMap[key]) timeMap[key]={name,value:0,count:0};
    timeMap[key].value+=amount;timeMap[key].count+=cnt;
  }

  const refunded=(refundRows || []).length;
  const refundedTotal=(refundRows || []).reduce((sum,row)=>sum+Number(row.amount_minor || 0),0);
  if(refunded) statusMap['Возврат подтвержден']=refunded;
  const byPartner=Object.values(partnerMap).map((p)=>{
    const commissionPercent=Number(commissionById[p.partnerId] || 0);
    return {...p,avg:p.success?p.amount/p.success:0,commissionPercent,netAmount:Math.round(p.amount*(1-commissionPercent/100))};
  }).sort((a,b)=>b.amount-a.amount);
  return {
    total,count:successCount,pending,failed,failedTotal,canceled,canceledTotal,refunded,refundedTotal,
    avg:successCount?total/successCount:0,allCount,successRate:allCount?Math.round(successCount/allCount*100):0,
    timeline:Object.entries(timeMap).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>({key,...v,avg:v.count?v.value/v.count:0})).slice(-92),
    byMethod:Object.entries(methodMap).map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value),
    byStatus:Object.entries(statusMap).map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value),
    byPartner,
    byDay:Object.values(dayMap).sort((a,b)=>b.day.localeCompare(a.day)),
  };
}

async function terminalIdsForTsp(db,partnerId,projectId,tspName){
  if(!tspName) return [];
  let query=db.from('partner_visible_terminals_v2').select('id,company_name,label').eq('partner_id',partnerId);
  if(projectId) query=query.eq('project_id',projectId);
  const {data,error}=await query;
  if(error) throw error;
  return (data || []).filter((row)=>String(row.company_name || row.label || '')===tspName).map((row)=>row.id);
}

function resolveStatsRange(params,period){
  if(params.from){
    const from=moscowDayStart(String(params.from));
    const to=params.to?moscowDayAfter(String(params.to)):new Date().toISOString();
    return {from,to};
  }
  const now=new Date();
  const shifted=new Date(now.getTime()+3*3600000);
  const y=shifted.getUTCFullYear(),m=shifted.getUTCMonth(),d=shifted.getUTCDate();
  let localStart;
  if(period==='day') localStart=Date.UTC(y,m,d);
  else if(period==='quarter') localStart=Date.UTC(y,Math.floor(m/3)*3,1);
  else if(period==='year') localStart=Date.UTC(y,0,1);
  else localStart=Date.UTC(y,m,1);
  return {from:new Date(localStart-3*3600000).toISOString(),to:now.toISOString()};
}

function normalizePeriod(value){return ['day','month','quarter','year'].includes(String(value))?String(value):'month';}
function emptyStats(){return {total:0,count:0,pending:0,failed:0,failedTotal:0,canceled:0,canceledTotal:0,refunded:0,refundedTotal:0,avg:0,allCount:0,successRate:0,timeline:[],byMethod:[],byStatus:[]};}
function normalizeInternalStatus(value){const s=String(value);if(s==='creating_qr') return 'creating';if(s.startsWith('refund_')) return 'success';return s;}
function statusLabel(s){return ({creating:'Создание QR',pending:'Ожидает оплаты',success:'Оплачен',failed:'Ошибка',expired:'Отменен',canceled:'Отменен',subscription_confirmed:'Подписка подтверждена',subscription_rejected:'Отказ плательщика',subscription_failed:'Ошибка подписки'})[s] || s || '—';}
function methodLabel(m){return String(m || '').toUpperCase()==='CARD'?'Карта':'СБП';}
function timelineKey(raw,period,hourly){if(hourly){const d=new Date(new Date(raw).getTime()+3*3600000);const y=d.getUTCFullYear(),m=String(d.getUTCMonth()+1).padStart(2,'0'),day=String(d.getUTCDate()).padStart(2,'0'),h=String(d.getUTCHours()).padStart(2,'0');if(period==='day') return {key:`${y}-${m}-${day}-${h}`,name:`${h}:00`};return {key:`${y}-${m}-${day}`,name:`${day}.${m}`};}const key=String(raw).slice(0,10);if(period==='year') return {key:key.slice(0,7),name:key.slice(5,7)};return {key,name:`${key.slice(8,10)}.${key.slice(5,7)}`};}
function moscowDayStart(d){return new Date(`${String(d).slice(0,10)}T00:00:00+03:00`).toISOString();}
function moscowDayAfter(d){return new Date(new Date(`${String(d).slice(0,10)}T00:00:00+03:00`).getTime()+86400000).toISOString();}
function moscowDate(value){const d=value instanceof Date?value:new Date(value);const shifted=new Date(d.getTime()+3*3600000);return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth()+1).padStart(2,'0')}-${String(shifted.getUTCDate()).padStart(2,'0')}`;}
function toArray(value){if(value==null) return [];return Array.isArray(value)?value:[value];}
function isUuid(v){return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v));}
function parsePartnerId(value){const id=Number(value);return Number.isSafeInteger(id)&&id>0?id:null;}
function invalidPartnerId(res){return res.status(400).json({success:false,error:'VALIDATION_ERROR',message:'Некорректный ID партнёра'});}
function csvValue(v){const s=String(v ?? '');return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;}

const KNOWN_STATUSES=new Set(['creating_qr','pending','success','failed','expired','canceled','cancelled','cancel','refund_requested','refund_processing','refund_confirmed','refund_refused','refund_failed','subscription_confirmed','subscription_rejected','subscription_failed','transfer_confirmed','transfer_refused']);

const EXPORT_FIELDS={
  payment_id:['ID платежа',(p)=>p.id],
  partner_name:['Компания партнера',(p)=>p.partner_name],
  partner_email:['Email партнера',(p)=>p.partner_email],
  project_name:['Проект',(p)=>p.project_name],
  terminal_name:['Наименование ТСП',(p)=>p.terminal_tsp_name || p.terminal_label],
  bank_name:['Банк',(p)=>p.bank_name],
  payment_method:['Метод',(p)=>p.payment_type],
  qrc_type:['Тип QR',(p)=>p.qrc_type],
  status_label:['Статус',(p)=>p.status],
  amount_rub:['Сумма',(p)=>(Number(p.amount || 0)/100).toFixed(2)],
  account_currency:['Валюта счета',(p)=>p.account_currency],
  amount_currency_rub:['Сумма в валюте',(p)=>(Number(p.amount_currency_minor || 0)/100).toFixed(2)],
  currency_rate:['Курс',(p)=>p.effective_currency_rate_rub],
  payment_purpose:['Назначение',(p)=>p.payment_purpose],
  created_at:['Время создания',(p)=>p.created_at],
  paid_at:['Время оплаты',(p)=>p.paid_at],
  refunded_at:['Время возврата',(p)=>p.refund_completed_at],
  qrc_id:['QRC ID',(p)=>p.qrc_id],
  trx_id:['TRX ID',(p)=>p.trx_id],
  refund_status:['Статус возврата',(p)=>p.refund_status],
  refund_amount_rub:['Сумма возврата',(p)=>p.refund_amount==null?'':(Number(p.refund_amount)/100).toFixed(2)],
  client_phone:['clientPhone',(p)=>p.client_phone],
  client_pam:['clientPam',(p)=>p.client_pam],
  bank_snd_pam:['ФИО плательщика от банка',(p)=>p.bank_snd_pam],
  bank_snd_phone_masked:['Маска телефона от банка',(p)=>p.bank_snd_phone_masked],
  client_webhook_status:['Webhook партнеру',(p)=>p.client_webhook_status],
};
function parseExportFields(value){const keys=String(value || '').split(',').filter((key)=>EXPORT_FIELDS[key]);return keys.length?keys:Object.keys(EXPORT_FIELDS);}
function toCsv(rows,fields){const lines=[fields.map((key)=>csvValue(EXPORT_FIELDS[key][0])).join(',')];for(const row of rows) lines.push(fields.map((key)=>csvValue(EXPORT_FIELDS[key][1](row))).join(','));return lines.join('\n');}

module.exports=router;
