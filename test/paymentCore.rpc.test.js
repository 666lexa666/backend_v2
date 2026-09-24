const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('payment core passes normalized currency snapshot into atomic create RPC',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','lib','paymentCore.js'),'utf8');
  for(const token of [
    "p_provider_code:runtime.providerCode || 'unknown'",
    'p_currency:transactionCurrency',
    'p_account_currency:currencySnapshot.accountCurrency',
    'p_currency_markup_percent:currencySnapshot.markupPercent',
    'p_effective_currency_rate_rub:currencySnapshot.effectiveRateRub',
    'p_amount_currency_minor:currencySnapshot.amountCurrencyMinor',
    'p_currency_rate_fetched_at:currencySnapshot.rateFetchedAt',
  ]) assert.ok(source.includes(token),token);
});

test('checked-in SQL matches current create_payment_v2 settlement signature',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','db','2026-09-24-payment-core.sql'),'utf8');
  for(const token of [
    'p_provider_code text',
    'p_account_currency text',
    'p_currency_markup_percent numeric',
    'p_effective_currency_rate_rub numeric',
    'p_amount_currency_minor bigint',
    'commission_currency_minor',
    'currency_rate_fetched_at_snapshot',
    "coalesce(nullif(trim(p_provider_code),''),'unknown')",
  ]) assert.ok(source.includes(token),token);
});
