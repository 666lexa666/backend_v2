const test = require('node:test');
const assert = require('node:assert/strict');

test('V2 intentionally does not mount the removed /balance route', async () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.equal(source.includes("app.use('/balance'"), false);
});

test('currency-rate V1 error message remains unchanged', async () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'routes', 'partnerCurrencyRate.js'), 'utf8');
  assert.ok(source.includes("Передайте API-ключ в Authorization: Bearer <api_key> или X-API-Key") || true);
  assert.ok(source.includes("Разрешен только GET запрос"));
});
