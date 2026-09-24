# @whitecapital/sdk

JavaScript SDK for the WhiteCapital Partner API V2.

## Usage

```js
import { WhiteCapital } from '@whitecapital/sdk';

const wc = new WhiteCapital({
  apiKey: process.env.WHITECAPITAL_API_KEY,
});

const payment = await wc.payments.create({
  amount: 15000,
  currency: 'RUB',
  method: 'SBP',
  projectId: 'PROJECT_UUID',
  orderId: 'ORDER-123',
  description: 'Оплата заказа',
});

console.log(payment.id, payment.qr);
```

### Card payment

```js
const payment = await wc.payments.create({
  amount: 15000,
  method: 'CARD',
  description: 'Оплата заказа',
  redirectUrl: 'https://merchant.example/payment/return',
});

console.log(payment.card?.formUrl);
```

### Get payment

```js
const payment = await wc.payments.get(paymentId);
```

### Refund

```js
const refund = await wc.payments.refund(paymentId, {
  reason: 'Возврат заказа',
});
```

### Recurring SBP charge

```js
const payment = await wc.subscriptions.charge({
  amount: 15000,
  subscriptionQrcId: '...',
  description: 'Продление подписки',
  orderId: 'SUB-2026-09',
});
```

The SDK uses only the V2 endpoints. Existing integrations can keep using the V1-compatible Partner API directly.
