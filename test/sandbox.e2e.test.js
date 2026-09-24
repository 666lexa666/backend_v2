const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const app=require('../server');
const { getSupabaseAdminClient }=require('../lib/supabase');
const { sha256 }=require('../lib/security');

const enabled=process.env.RUN_SANDBOX_E2E==='1';
const PARTNER_ID=900000001;
const CATALOG_TERMINAL_ID='ca3da953-2983-4cd1-b25c-e55d7224767f';

async function cleanup(db){
  await db.from('sandbox_payments').delete().eq('partner_id',PARTNER_ID);
  await db.from('checkout_subscription_instruments').delete().eq('partner_id',PARTNER_ID);
  await db.from('partner_terminals').delete().eq('partner_id',PARTNER_ID);
  await db.from('partner_projects').delete().eq('partner_id',PARTNER_ID);
  await db.from('partner_credentials').delete().eq('partner_id',PARTNER_ID);
  await db.from('partners').delete().eq('id',PARTNER_ID);
}

async function request(base,apiKey,method,path,body){
  const response=await fetch(base+path,{
    method,
    headers:{
      Authorization:`Bearer ${apiKey}`,
      Accept:'application/json',
      ...(body===undefined?{}:{'Content-Type':'application/json'}),
    },
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
  const raw=await response.text();
  let payload;
  try{payload=raw?JSON.parse(raw):null;}catch{payload={raw};}
  return {response,payload};
}

test('sandbox HTTP E2E never touches production payments or bank providers',{skip:!enabled,timeout:60000},async()=>{
  const db=getSupabaseAdminClient();
  const apiKey=`wc_test_smoke_${crypto.randomBytes(24).toString('base64url')}`;
  const projectId=crypto.randomUUID();
  const assignmentId=crypto.randomUUID();
  const instrumentId=crypto.randomUUID();
  const subscriptionQrcId=`SBX_SUB_${crypto.randomUUID().replace(/-/g,'').toUpperCase()}`;
  let server;

  await cleanup(db);

  try{
    const {error:partnerError}=await db.from('partners').insert({
      id:PARTNER_ID,
      login:'sandbox-smoke@whitecapital.test',
      company_name:'WHITECAPITAL Sandbox Smoke',
      email:'sandbox-smoke@whitecapital.test',
      merchant_id:'WC-SANDBOX-SMOKE',
      api_key_hash:sha256(apiKey),
      api_key_prefix:'wc_test_smoke',
      commission_percent:0.5,
      account_currency:'RUB',
      is_admin:false,
      is_active:true,
      environment:'test',
      environment_revision:1,
      email_verified_at:new Date().toISOString(),
      settings:{
        qr_exp_dt:15,
        qr_local_exp_dt:900,
        currency_markup_percent:0,
        forward_payer_data:false,
        deposit_enabled:false,
        deposit_capped:true,
        purpose_use_transaction_id:true,
        purpose_use_client_phone:false,
        require_qr_client_identity:false,
        terminal_auto_distribution_enabled:false,
        ignore_request_terminal_id:false,
        checkout_payment_methods:'sbp',
      },
    });
    if(partnerError) throw partnerError;

    const {error:projectError}=await db.from('partner_projects').insert({
      id:projectId,
      partner_id:PARTNER_ID,
      name:'Sandbox Smoke',
      sort_order:0,
      is_active:true,
      deposit_enabled:false,
      deposit_allow_negative:false,
      settings:{sandboxSmoke:true},
    });
    if(projectError) throw projectError;

    const {error:terminalError}=await db.from('partner_terminals').insert({
      id:assignmentId,
      partner_id:PARTNER_ID,
      project_id:projectId,
      terminal_id:CATALOG_TERMINAL_ID,
      label:'Sandbox Smoke',
      min_amount_minor:100,
      max_amount_minor:1000000,
      deposit_enabled:false,
      deposit_capped:true,
      payment_form_enabled:true,
      auto_distribution_enabled:true,
      is_default:true,
      is_active:true,
      provider_config:{
        acc_alias:'jdXTb5J5FZEAXbubP19iIhTk875DIiSuXe0Xx7Z2XHw=',
        merchant_id:'MB0003487704',
        ext_entity_id:'7ZBL4UNH',
      },
      settings:{sandboxSmoke:true},
    });
    if(terminalError) throw terminalError;

    server=app.listen(0,'127.0.0.1');
    await new Promise((resolve,reject)=>{
      server.once('listening',resolve);
      server.once('error',reject);
    });
    const base=`http://127.0.0.1:${server.address().port}`;

    const create=await request(base,apiKey,'POST','/qr',{
      projectId,
      qrcType:'02',
      amount:10000,
      paymentPurpose:'Sandbox smoke payment',
      orderId:'SANDBOX-SMOKE-QR-1',
    });
    assert.equal(create.response.status,200,JSON.stringify(create.payload));
    assert.equal(create.payload.success,true);
    assert.match(create.payload.qrcId,/^SBX/);
    assert.match(create.payload.payload,/^https:\/\/sandbox\.whitecapital\.tech\/pay\//);
    const paymentId=create.payload.paymentId;

    const {count:realPayments,error:countError}=await db
      .from('payments')
      .select('id',{count:'exact',head:true})
      .eq('partner_id',PARTNER_ID);
    if(countError) throw countError;
    assert.equal(realPayments,0,'sandbox request must never insert into production payments');

    const pending=await request(base,apiKey,'GET',`/qr/${paymentId}/status`);
    assert.equal(pending.response.status,200);
    assert.equal(pending.payload.status,'pending');

    const simulated=await request(base,apiKey,'POST',`/sandbox/payments/${paymentId}/simulate`,{status:'success'});
    assert.equal(simulated.response.status,200,JSON.stringify(simulated.payload));
    assert.equal(simulated.payload.v1.status,'success');

    const success=await request(base,apiKey,'GET',`/qr/${paymentId}/status`);
    assert.equal(success.response.status,200);
    assert.equal(success.payload.status,'success');
    assert.ok(success.payload.paidAt);

    const refund=await request(base,apiKey,'POST','/refund',{
      paymentId,
      remitInfo:'Sandbox full refund',
    });
    assert.equal(refund.response.status,202,JSON.stringify(refund.payload));
    assert.equal(refund.payload.status,'refund_requested');
    assert.equal(refund.payload.amount,10000);

    const refundConfirmed=await request(base,apiKey,'POST',`/sandbox/payments/${paymentId}/simulate`,{status:'refund_confirmed'});
    assert.equal(refundConfirmed.response.status,200);
    assert.equal(refundConfirmed.payload.v1.status,'refund_confirmed');

    const {error:instrumentError}=await db.from('checkout_subscription_instruments').insert({
      id:instrumentId,
      partner_id:PARTNER_ID,
      project_id:projectId,
      customer_id:null,
      origin_session_id:null,
      partner_terminal_id:assignmentId,
      payment_method:'SBP',
      provider_instrument_id:subscriptionQrcId,
      subscription_qrc_id:subscriptionQrcId,
      bank_binding_id:'sandbox-binding',
      status:'active',
    });
    if(instrumentError) throw instrumentError;

    const recurring=await request(base,apiKey,'POST','/checkout/subscriptions/charge',{
      amount:12000,
      paymentPurpose:'Sandbox recurring charge',
      orderId:'SANDBOX-SUB-1',
      subscriptionQrcId,
    });
    assert.equal(recurring.response.status,200,JSON.stringify(recurring.payload));
    assert.equal(recurring.payload.success,true);
    assert.equal(recurring.payload.bankResponse.sandbox,true);
    assert.match(recurring.payload.qrcId,/^SBX/);

    const v2=await request(base,apiKey,'POST','/v2/payments',{
      amount:13000,
      currency:'RUB',
      method:'SBP',
      projectId,
      description:'Sandbox V2 smoke',
      orderId:'SANDBOX-V2-1',
    });
    assert.equal(v2.response.status,201,JSON.stringify(v2.payload));
    assert.equal(v2.payload.payment.status,'pending');
    assert.match(v2.payload.payment.qr.id,/^SBX/);

    const {count:sandboxCount,error:sandboxCountError}=await db
      .from('sandbox_payments')
      .select('id',{count:'exact',head:true})
      .eq('partner_id',PARTNER_ID);
    if(sandboxCountError) throw sandboxCountError;
    assert.ok(sandboxCount>=3);

    const {count:finalRealPayments,error:finalCountError}=await db
      .from('payments')
      .select('id',{count:'exact',head:true})
      .eq('partner_id',PARTNER_ID);
    if(finalCountError) throw finalCountError;
    assert.equal(finalRealPayments,0,'all smoke-test payment flows must stay out of production payments');
  } finally {
    if(server) await new Promise((resolve)=>server.close(resolve));
    await cleanup(db);
  }
});
