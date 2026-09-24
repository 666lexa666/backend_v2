const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('payment core passes provider code into atomic create RPC',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','lib','paymentCore.js'),'utf8');
  assert.ok(source.includes("p_provider_code:runtime.providerCode || 'unknown'"));
});

test('checked-in SQL matches current create_payment_v2 signature',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','db','2026-09-24-payment-core.sql'),'utf8');
  assert.ok(source.includes('p_provider_code text'));
  assert.ok(source.includes("coalesce(nullif(trim(p_provider_code),''),'unknown')"));
});
