export class WhiteCapitalError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'WhiteCapitalError';
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.details = options.details ?? null;
    this.response = options.response ?? null;
  }
}

export class WhiteCapital {
  constructor({ apiKey, baseUrl = 'https://api.whitecapital.tech', fetch: fetchImpl = globalThis.fetch } = {}) {
    if (!apiKey) throw new TypeError('apiKey is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');

    this.apiKey = String(apiKey);
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.fetch = fetchImpl;

    this.payments = {
      create: (input) => this.request('POST', '/v2/payments', input).then((r) => r.payment),
      get: (paymentId) => this.request('GET', `/v2/payments/${encodeURIComponent(paymentId)}`).then((r) => r.payment),
      refund: (paymentId, input = {}) => this.request('POST', '/v2/refunds', { paymentId, ...input }).then((r) => r.refund),
    };

    this.subscriptions = {
      charge: (input) => this.request('POST', '/v2/subscriptions/charge', input).then((r) => r.payment),
    };
  }

  async request(method, path, body) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { rawBody: text };
    }

    if (!response.ok) {
      throw new WhiteCapitalError(
        payload?.message || `WhiteCapital API request failed with HTTP ${response.status}`,
        {
          status: response.status,
          code: payload?.error || null,
          details: payload?.details || null,
          response: payload,
        },
      );
    }

    return payload;
  }
}
