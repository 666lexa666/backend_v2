const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('V1 refund route is mounted and V2 refund route exists',()=>{
  const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  const v2=fs.readFileSync(path.join(__dirname,'..','routes','partnerRefundV2.js'),'utf8');
  assert.ok(server.includes("app.use('/refund'"));
  assert.ok(v2.includes("router.post('/refunds'"));
});

test('V1 refund contract field names remain stable',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','routes','partnerRefundLegacy.js'),'utf8');
  for(const field of ['paymentId','refundRefId','internalTxId','bankStatusCode','refundBankStatus']) assert.ok(source.includes(field),field);
});
