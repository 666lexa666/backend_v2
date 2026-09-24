const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('client portal covers frontend_v2 core routes',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','routes','clientPortal.js'),'utf8');
  for(const route of [
    "router.post('/login'",
    "router.get('/me'",
    "router.get('/environment'",
    "router.get('/projects'",
    "router.get('/payments'",
    "router.get('/statistics'",
    "router.post('/qr'",
    "router.post('/refund'",
    "router.patch('/settings'",
    "router.post('/api-key/regenerate'",
    "router.post('/webhook-secret/regenerate'",
    "router.get('/payout-summary'",
  ]) assert.ok(source.includes(route),route);
});

test('client payment list uses optimized portal read model',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','routes','clientPortal.js'),'utf8');
  assert.ok(source.includes("from('portal_payments_v2')"));
  assert.ok(source.includes("from('payment_stats_hourly')") || source.includes("?'payment_stats_hourly':'payment_stats_daily'"));
});
