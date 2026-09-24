const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('checkout V1 routes are all present',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','routes','partnerCheckoutLegacy.js'),'utf8');
  for(const route of [
    "router.post('/sessions'",
    "router.get('/sessions/:id'",
    "router.post('/sessions/:id/sbp'",
    "router.post('/sessions/:id/card/init'",
    "router.post('/sessions/:id/cancel'",
    "router.post('/subscriptions/charge'",
  ]) assert.ok(source.includes(route),route);
});

test('checkout implementation uses normalized V2 columns',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','routes','partnerCheckoutLegacy.js'),'utf8');
  assert.ok(source.includes('amount_minor'));
  assert.ok(source.includes('payment_pk'));
  assert.ok(source.includes('partner_terminal_id'));
});
