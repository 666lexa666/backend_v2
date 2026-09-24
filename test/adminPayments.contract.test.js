const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('admin payments and stats routes are present',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','routes','adminPayments.js'),'utf8');
  for(const route of [
    "router.get('/payments'",
    "router.get('/payments/export'",
    "router.get('/partners/:id/payments'",
    "router.post('/partners/:id/payments/:paymentId/refund'",
    "router.post('/partners/:id/payments/:paymentId/confirm-success'",
    "router.get('/partners/:id/statistics'",
    "router.get('/stats'",
    "router.get('/stats/day-partners'",
    "router.get('/stats/export'",
    "router.get('/payout-summary'",
  ]) assert.ok(source.includes(route),route);
});

test('admin payment queries use optimized portal view and daily aggregates',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','routes','adminPayments.js'),'utf8');
  assert.ok(source.includes("from('portal_payments_v2')"));
  assert.ok(source.includes("from('payment_stats_daily')"));
  assert.equal(source.includes('balance-adjustments'),false);
});
