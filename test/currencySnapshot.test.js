const test=require('node:test');
const assert=require('node:assert/strict');
const { calculatePaymentCurrencySnapshot }=require('../lib/currencySnapshot');

test('RUB settlement snapshot preserves minor amount exactly',()=>{
  const x=calculatePaymentCurrencySnapshot({
    amountMinor:12345,
    accountCurrency:'RUB',
    markupPercent:12,
  });
  assert.equal(x.transactionCurrency,'RUB');
  assert.equal(x.accountCurrency,'RUB');
  assert.equal(x.officialRateRub,1);
  assert.equal(x.effectiveRateRub,1);
  assert.equal(x.markupPercent,0);
  assert.equal(x.amountCurrencyMinor,12345);
});

test('EUR settlement snapshot matches legacy V1 formula including markup',()=>{
  const x=calculatePaymentCurrencySnapshot({
    amountMinor:1_000_000,
    accountCurrency:'EUR',
    officialRateRub:96.7442,
    markupPercent:12,
    rateFetchedAt:'2026-09-23T22:55:17.223Z',
    rateSource:'CBR_XML_DAILY',
  });
  assert.equal(x.transactionCurrency,'RUB');
  assert.equal(x.accountCurrency,'EUR');
  assert.equal(x.officialRateRub,96.7442);
  assert.equal(x.effectiveRateRub,108.353504);
  assert.equal(x.amountCurrencyMinor,9229);
  assert.equal(x.markupPercent,12);
});
