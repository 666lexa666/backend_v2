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

test('V1 card preflight keeps production validation and routing semantics',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','routes','partnerCardLegacy.js'),'utf8');
  for(const token of [
    'normalizePartnerOrderId',
    'resolveLegacyTerminalAssignment',
    'Некорректные параметры карточного платежа',
    'CARD_TERMINAL_NOT_FOUND',
    'TERMINAL_PAYMENT_METHOD_MISMATCH',
    'Сумма не соответствует лимитам карточного терминала',
    'BANK_NOT_CONFIGURED',
    'CARD_BANK_NOT_SUPPORTED',
    'TERMINAL_NOT_CONFIGURED',
    'Callback token обязателен',
    'purpose_use_transaction_id',
  ]) assert.ok(source.includes(token),token);
});
