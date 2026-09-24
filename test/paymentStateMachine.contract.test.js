const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('V2 core uses normalized payment statuses only',()=>{
  const core=fs.readFileSync(path.join(__dirname,'..','lib','paymentCore.js'),'utf8');
  const refund=fs.readFileSync(path.join(__dirname,'..','lib','refundService.js'),'utf8');
  const webhook=fs.readFileSync(path.join(__dirname,'..','lib','bankWebhookProcessor.js'),'utf8');
  assert.ok(core.includes("p_status:'creating'"));
  assert.equal(refund.includes("status: 'refund_requested'"),false);
  assert.equal(webhook.includes("? 'transfer_confirmed'"),false);
});

test('V1 status adapters synthesize legacy statuses',()=>{
  for(const file of ['partnerQrLegacy.js','partnerCardLegacy.js']){
    const source=fs.readFileSync(path.join(__dirname,'..','routes',file),'utf8');
    assert.ok(source.includes('legacyPaymentStatus'));
    assert.ok(source.includes("'refund_confirmed'"));
    assert.ok(source.includes("'creating_qr'"));
  }
});
