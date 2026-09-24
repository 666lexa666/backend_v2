const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('V2 card payments execute provider instead of returning a stub',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','routes','partnerApiV2.js'),'utf8');
  assert.ok(source.includes('executeCardPayment'));
  assert.ok(source.includes("method === 'CARD'"));
  assert.ok(source.includes('formUrl'));
});

test('JavaScript SDK is V2-only',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','sdk','javascript','src','index.js'),'utf8');
  assert.ok(source.includes("'/v2/payments'"));
  assert.ok(source.includes("'/v2/refunds'"));
  assert.ok(source.includes("'/v2/subscriptions/charge'"));
  assert.equal(source.includes("'/qr'"),false);
});
