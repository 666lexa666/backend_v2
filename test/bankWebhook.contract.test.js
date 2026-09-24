const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const { detectNotificationType }=require('../lib/bankWebhookProcessor');

test('generic bank notification detection matches V1',()=>{
  assert.equal(detectNotificationType({trxId:'1',qrcId:'q',amount:100,qrcType:'02'}),'c2b_payment');
  assert.equal(detectNotificationType({subscriptionToken:'s',qrcId:'q'}),'subscription');
  assert.equal(detectNotificationType({orgnlTrxId:'x'}),'b2c_refund');
  assert.equal(detectNotificationType({internalTrxId:'x',status:'CONFIRMED'}),'b2c_transfer');
});

test('server preserves both bank webhook mount points',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  assert.ok(source.includes("app.use('/webhook'"));
  assert.ok(source.includes("app.use('/webhook-dolinsk'"));
});
