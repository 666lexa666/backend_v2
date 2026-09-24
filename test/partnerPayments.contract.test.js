const test = require('node:test');
const assert = require('node:assert/strict');

test('server exposes both V1 and V2 payment APIs and no balance endpoint', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  assert.ok(source.includes("app.use('/qr'"));
  assert.ok(source.includes("app.use('/v2'"));
  assert.equal(source.includes("app.use('/balance'"), false);
});

test('V1 QR route preserves legacy field names', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'partnerQrLegacy.js'), 'utf8');

  for (const field of ['paymentId','orderId','qrcId','payload','qrcType','regTime','expDt','localExpDt','redirectUrl']) {
    assert.ok(source.includes(field), field);
  }
});
