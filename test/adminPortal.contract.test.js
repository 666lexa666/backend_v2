const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('admin portal provides core frontend routes without balance API',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','routes','adminPortal.js'),'utf8');
  for(const route of [
    "router.get('/partners'",
    "router.get('/partners/:id'",
    "router.patch('/partners/:id/status'",
    "router.patch('/partners/:id/archive'",
    "router.patch('/partners/:id/bank-settings'",
    "router.get('/partners/:id/projects'",
    "router.get('/banks'",
    "router.get('/currency-rates'",
    "router.get('/partner-invites'",
    "router.get('/accounting-key'",
  ]) assert.ok(source.includes(route),route);
  assert.equal(source.includes('balance-adjustments'),false);
});

test('bank API never returns raw certificate/password',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','routes','adminPortal.js'),'utf8');
  const publicBank=source.slice(source.indexOf('function publicBank'),source.indexOf('function buildBankWrite'));
  assert.equal(publicBank.includes('certificate_base64:'),false);
  assert.equal(publicBank.includes('certificate_password:'),false);
  assert.ok(publicBank.includes('has_certificate'));
});
