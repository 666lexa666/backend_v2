const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('legacy subscription charge route remains mounted', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(source.includes("app.use('/checkout'"));
});

test('V1 subscription response keeps paymentId/orderId/qrcId/bankResponse', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'partnerCheckoutLegacy.js'), 'utf8');
  for (const field of ['paymentId','orderId','qrcId','bankResponse']) assert.ok(source.includes(field), field);
});

test('V2 has dedicated subscription charge endpoint', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'partnerApiV2.js'), 'utf8');
  assert.ok(source.includes("router.post('/subscriptions/charge'"));
});
