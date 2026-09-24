const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPartnerWebhookPayload } = require('../lib/partnerWebhook');

test('V1 success webhook contract stays stable on normalized V2 payment row', () => {
  const payment = {
    id: '11111111-1111-4111-8111-111111111111',
    partner_order_id: 'order-42',
    payment_type: 'SBP',
    qrc_type: '02',
    qrc_id: 'AD101TEST',
    amount_minor: 12500,
    currency: 'RUB',
    provider_payment_id: 'trx-1',
    created_at: '2026-09-24T10:00:00.000Z',
    updated_at: '2026-09-24T10:01:00.000Z',
    metadata: {
      amount_currency_minor: 12500,
      effective_currency_rate_rub: 1,
    },
  };

  const result = buildPartnerWebhookPayload('c2b_payment', payment, {
    amount: 12500,
    cur: 'RUB',
    trxId: 'trx-1',
    trxTime: '2026-09-24T10:01:00.000Z',
  });

  assert.deepEqual(result, {
    schemaVersion: 1,
    eventId: result.eventId,
    eventType: 'payment.succeeded',
    paymentId: payment.id,
    orderId: 'order-42',
    paymentType: 'SBP',
    qrcId: 'AD101TEST',
    qrcType: '02',
    currency: 'RUB',
    accountCurrency: 'RUB',
    amountCurrencyMinor: 12500,
    effectiveCurrencyRateRub: 1,
    occurredAt: '2026-09-24T10:01:00.000Z',
    status: 'success',
    amount: 12500,
    createdAt: null,
    paidAt: '2026-09-24T10:01:00.000Z',
    trxId: 'trx-1',
  });
  assert.match(result.eventId, /^wc_evt_[0-9a-f]{32}$/);
});
