const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('payment core uses optimized route view and atomic RPC',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','lib','paymentCore.js'),'utf8');
  assert.ok(source.includes("from('partner_payment_routes_v2')"));
  assert.ok(source.includes("rpc('create_payment_v2'"));
  assert.equal(source.includes("from('partner_terminals')"),false);
  assert.equal(source.includes("from('terminals')"),false);
});
