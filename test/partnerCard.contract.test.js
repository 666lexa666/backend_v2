const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('V1 card endpoint is mounted',()=>{
  const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  assert.ok(server.includes("app.use('/card'"));
});

test('V1 card success contract keeps legacy response names',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','routes','partnerCardLegacy.js'),'utf8');
  for(const field of ['paymentId','orderId','terminalId','bankOrderId','formUrl','redirectUrl','amountCurrencyMinor','effectiveCurrencyRateRub']){
    assert.ok(source.includes(field),field);
  }
});
