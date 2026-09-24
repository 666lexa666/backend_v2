const test=require('node:test');
const assert=require('node:assert/strict');
const { stableUuid }=require('../lib/partnerWebhookOutbox');

test('webhook event key is deterministic UUID',()=>{
  const a=stableUuid('wc_evt_123');
  const b=stableUuid('wc_evt_123');
  assert.equal(a,b);
  assert.match(a,/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
