const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('V2 intentionally does not mount the removed /balance route', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.equal(source.includes("app.use('/balance'"), false);
});

test('V1 QR route is mounted and uses compatibility validation/routing layer', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'partnerQrLegacy.js'), 'utf8');
  assert.ok(server.includes("app.use('/qr'"));
  for (const token of [
    'normalizePartnerOrderId',
    'resolveLegacyTerminalAssignment',
    'validateLegacyQrRequest',
    'resolveBankPaymentPurpose',
    "error: 'TERMINAL_PAYMENT_METHOD_MISMATCH'",
    'amountCurrencyMinor',
    'effectiveCurrencyRateRub',
  ]) assert.ok(source.includes(token), token);
});

test('currency-rate V1 route keeps method contract', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'partnerCurrencyRate.js'), 'utf8');
  assert.ok(source.includes('Разрешен только GET запрос'));
});
