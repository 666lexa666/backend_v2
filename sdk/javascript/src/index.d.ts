export type PaymentMethod = 'SBP' | 'CARD';

export interface WhiteCapitalOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export interface CreatePaymentInput {
  amount: number;
  currency?: string;
  method?: PaymentMethod;
  projectId?: string;
  terminalId?: string;
  orderId?: string;
  description: string;
  callbackUrl?: string;
  redirectUrl?: string;
  qrcType?: '02' | '03';
}

export interface ChargeSubscriptionInput {
  amount: number;
  description: string;
  instrumentId?: string;
  subscriptionQrcId?: string;
  customerId?: string;
  orderId?: string;
}

export declare class WhiteCapitalError extends Error {
  status: number | null;
  code: string | null;
  details: unknown;
  response: unknown;
}

export declare class WhiteCapital {
  constructor(options: WhiteCapitalOptions);
  payments: {
    create(input: CreatePaymentInput): Promise<any>;
    get(paymentId: string): Promise<any>;
    refund(paymentId: string, input?: { amount?: number; reason?: string }): Promise<any>;
  };
  subscriptions: {
    charge(input: ChargeSubscriptionInput): Promise<any>;
  };
}
