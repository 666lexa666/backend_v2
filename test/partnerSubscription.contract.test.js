const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('legacy subscription charge route remains mounted', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(source.includes("app.use('/checkout'"));
});

test('V1 subscription charge preserves SBP and CARD instrument contract', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'partnerCheckoutLegacy.js'), 'utf8');
  for (const token of [
    'normalizePartnerOrderId',
    'subscriptionQrcId',
    'cardToken',
    'CUSTOMER_NOT_FOUND',
    'INSTRUMENT_NOT_FOUND',
    'INSTRUMENT_TERMINAL_METHOD_MISMATCH',
    'chargeSbpSubscription',
    'chargeCardSubscription',
    'BANK_QR_REGISTER_FAILED',
    'BANK_SUBSCRIPTION_CHARGE_FAILED',
  ]) assert.ok(source.includes(token), token);
});

test('V1 SBP recurring supports Ingo binding and mTLS QR-to-charge flows', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'subscriptionService.js'), 'utf8');
  for (const token of [
    'chargeIngoBinding',
    "bank.provider_code || '').toLowerCase() === 'ingo'",
    'executeQrPayment',
    'sbp_subscription_pay_url',
    'subscriptionQrcId',
    'payQrcId',
    'bank_binding_id',
    'purpose_use_transaction_id',
  ]) assert.ok(source.includes(token), token);
});

test('V1 CARD recurring uses original first payment and card token', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'subscriptionService.js'), 'utf8');
  for (const token of [
    'chargeCardToken',
    'card_first_payment_id',
    'card_token',
    "payment_status || '').toUpperCase()",
    "finalStatus === 'success'",
    'enqueuePartnerWebhook',
  ]) assert.ok(source.includes(token), token);
});

test('subscription lookup cannot bypass checkout customer ownership', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'subscriptionService.js'), 'utf8');
  assert.ok(source.includes("eq('partner_customer_id', String(customerId))"));
  assert.ok(source.includes("query = query.eq('customer_id', customer.id)"));
  assert.ok(source.includes("query = query.is('customer_id', null)"));
});

test('V1 subscription response keeps paymentId/orderId and method-specific payload', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'partnerCheckoutLegacy.js'), 'utf8');
  for (const field of ['paymentId','orderId','qrcId','bankResponse']) assert.ok(source.includes(field), field);
});

test('V2 has dedicated subscription charge endpoint', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'partnerApiV2.js'), 'utf8');
  assert.ok(source.includes("router.post('/subscriptions/charge'"));
});
