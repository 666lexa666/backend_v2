const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

test('admin terminal routes required by frontend are present', () => {
  const source = read('routes/adminTerminals.js');
  for (const route of [
    "router.get('/terminals/:terminalId'",
    "router.get('/terminals/:terminalId/assignments'",
    "router.patch('/terminals/:terminalId/assignments/:assignmentId'",
    "router.get('/terminals/monthly-totals'",
    "router.delete('/partners/:partnerId/terminals/:terminalId'",
  ]) assert.ok(source.includes(route), route);
});

test('bank tester exposes frontend API and keeps synthetic payments out of payments table', () => {
  const route = read('routes/adminBankTester.js');
  const service = read('lib/bankTesterService.js');
  assert.ok(route.includes("router.get('/bank-tester/terminals'"));
  assert.ok(route.includes("router.get('/bank-tester/operations'"));
  assert.ok(route.includes("router.post('/bank-tester/terminals/:terminalId/operations'"));
  assert.ok(service.includes("from('admin_bank_tester_operations')"));
  assert.equal(service.includes("from('payments').insert"), false);
});

test('public application endpoint queues before returning success', () => {
  const server = read('server.js');
  const route = read('routes/application.js');
  const service = read('lib/applicationService.js');
  const worker = read('workers/partnerWebhookWorker.js');
  assert.ok(server.includes("app.use('/application'"));
  assert.ok(route.includes('await enqueueApplication'));
  assert.ok(service.includes("from('application_delivery_queue').insert"));
  assert.ok(service.includes("rpc('claim_application_delivery_queue'"));
  assert.ok(worker.includes('processApplicationDeliveryBatch'));
});
