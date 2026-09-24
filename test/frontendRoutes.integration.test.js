const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');

async function withServer(run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('frontend-facing routes are wired and do not fall through to 404', async () => {
  await withServer(async (base) => {
    const protectedRoutes = [
      ['GET', '/admin/accounting-key'],
      ['GET', '/admin/bank-tester/terminals'],
      ['GET', '/admin/bank-tester/operations?page=1&pageSize=25'],
      ['GET', '/admin/banks'],
      ['GET', '/admin/currency-rates'],
      ['GET', '/admin/expenses/access'],
      ['GET', '/admin/partner-invites'],
      ['GET', '/admin/partners'],
      ['GET', '/admin/payments'],
      ['GET', '/admin/payout-summary'],
      ['GET', '/admin/stats'],
      ['GET', '/admin/terminals'],
      ['GET', '/admin/terminals/monthly-totals'],
      ['GET', '/client/me'],
      ['GET', '/client/environment'],
      ['GET', '/client/projects'],
      ['GET', '/client/payments'],
      ['GET', '/client/statistics'],
      ['GET', '/client/terminal-statistics-options'],
      ['GET', '/client/payout-summary'],
      ['GET', '/client/terminals'],
      ['GET', '/client/projects/00000000-0000-4000-8000-000000000000/terminals'],
      ['POST', '/client/qr'],
      ['POST', '/client/refund'],
      ['PATCH', '/client/settings'],
    ];

    for (const [method, path] of protectedRoutes) {
      const response = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: ['POST', 'PATCH', 'PUT'].includes(method) ? '{}' : undefined,
      });
      assert.equal(response.status, 401, `${method} ${path} should be protected and wired`);
      const body = await response.json();
      assert.equal(body.error, 'UNAUTHORIZED', `${method} ${path}`);
    }

    const health = await fetch(base + '/health');
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.service, 'whitecapital-backend-v2');

    const missing = await fetch(base + '/__definitely_missing__');
    assert.equal(missing.status, 404);
    const missingBody = await missing.json();
    assert.equal(missingBody.error, 'NOT_FOUND');
  });
});

test('auth entry routes are mounted before DB access', async () => {
  await withServer(async (base) => {
    for (const path of ['/admin/login', '/client/login', '/client/register']) {
      const response = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.notEqual(response.status, 404, path);
    }
  });
});
