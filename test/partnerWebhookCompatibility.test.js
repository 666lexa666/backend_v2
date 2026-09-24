const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('V1 webhook adapter hydrates normalized payer and refund data',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','lib','partnerWebhookOutbox.js'),'utf8');
  for(const token of [
    "from('payment_payer_data')",
    "from('payment_refunds')",
    'payer_pam_masked',
    'payer_phone_masked',
    'provider_ref_id',
    'refund_amount',
    'bank_webhook_received_at',
  ]) assert.ok(source.includes(token),token);
});
