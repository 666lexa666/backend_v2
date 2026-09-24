const { getSupabaseAdminClient } = require('./supabase');

const SUPPORTED_ACCOUNT_CURRENCIES = new Set(['RUB', 'USD', 'EUR']);

function normalizeCurrency(value) {
  const currency = String(value || 'RUB').trim().toUpperCase();
  return SUPPORTED_ACCOUNT_CURRENCIES.has(currency) ? currency : 'RUB';
}

function normalizePercent(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function roundRate(value) {
  return Math.round(Number(value) * 1_000_000) / 1_000_000;
}

function calculatePaymentCurrencySnapshot({
  amountMinor,
  accountCurrency,
  markupPercent = 0,
  officialRateRub = 1,
  rateFetchedAt = null,
  rateSource = null,
}) {
  const rubAmountMinor = Number(amountMinor);
  if (!Number.isSafeInteger(rubAmountMinor) || rubAmountMinor <= 0) {
    const error = new Error('amount должен быть положительным целым числом в копейках');
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    throw error;
  }

  const normalizedCurrency = normalizeCurrency(accountCurrency);
  const normalizedMarkup = normalizedCurrency === 'RUB' ? 0 : normalizePercent(markupPercent);
  const official = normalizedCurrency === 'RUB' ? 1 : Number(officialRateRub || 0);

  if (!Number.isFinite(official) || official <= 0) {
    const error = new Error(`Для валюты ${normalizedCurrency} пока нет актуального курса`);
    error.statusCode = 400;
    error.code = 'CURRENCY_RATE_NOT_FOUND';
    error.currency = normalizedCurrency;
    throw error;
  }

  const effectiveRateRub = official * (1 + normalizedMarkup / 100);
  if (!Number.isFinite(effectiveRateRub) || effectiveRateRub <= 0) {
    const error = new Error('Эффективный валютный курс некорректен');
    error.statusCode = 400;
    error.code = 'CURRENCY_RATE_INVALID';
    throw error;
  }

  return {
    transactionCurrency: 'RUB',
    accountCurrency: normalizedCurrency,
    officialRateRub: roundRate(official),
    markupPercent: roundRate(normalizedMarkup),
    effectiveRateRub: roundRate(effectiveRateRub),
    amountCurrencyMinor: normalizedCurrency === 'RUB'
      ? rubAmountMinor
      : Math.round(rubAmountMinor / effectiveRateRub),
    rateFetchedAt: rateFetchedAt || new Date().toISOString(),
    rateSource: normalizedCurrency === 'RUB' ? 'RUB' : rateSource,
  };
}

async function buildPaymentCurrencySnapshot({
  db = getSupabaseAdminClient(),
  partnerId,
  amountMinor,
  accountCurrency,
  markupPercent,
}) {
  const rubAmountMinor = Number(amountMinor);
  if (!Number.isSafeInteger(rubAmountMinor) || rubAmountMinor <= 0) {
    const error = new Error('amount должен быть положительным целым числом в копейках');
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    throw error;
  }

  let resolvedCurrency = accountCurrency;
  let resolvedMarkup = markupPercent;

  if (resolvedCurrency == null || resolvedMarkup == null) {
    const { data: partner, error } = await db
      .from('partners')
      .select('account_currency,settings')
      .eq('id', Number(partnerId))
      .maybeSingle();
    if (error) throw error;
    if (!partner) {
      const error = new Error('Партнёр не найден');
      error.statusCode = 404;
      error.code = 'PARTNER_NOT_FOUND';
      throw error;
    }
    if (resolvedCurrency == null) resolvedCurrency = partner.account_currency;
    if (resolvedMarkup == null) resolvedMarkup = partner.settings?.currency_markup_percent;
  }

  const normalizedCurrency = normalizeCurrency(resolvedCurrency);
  const normalizedMarkup = normalizedCurrency === 'RUB' ? 0 : normalizePercent(resolvedMarkup);

  if (normalizedCurrency === 'RUB') {
    return calculatePaymentCurrencySnapshot({
      amountMinor: rubAmountMinor,
      accountCurrency: 'RUB',
    });
  }

  const { data: rate, error: rateError } = await db
    .from('currency_rates')
    .select('base_currency,quote_currency,rate,source,effective_at')
    .eq('base_currency', normalizedCurrency)
    .eq('quote_currency', 'RUB')
    .order('effective_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (rateError) throw rateError;

  const officialRateRub = Number(rate?.rate || 0);
  if (!rate || !Number.isFinite(officialRateRub) || officialRateRub <= 0) {
    const error = new Error(`Для валюты ${normalizedCurrency} пока нет актуального курса`);
    error.statusCode = 400;
    error.code = 'CURRENCY_RATE_NOT_FOUND';
    error.currency = normalizedCurrency;
    throw error;
  }

  return calculatePaymentCurrencySnapshot({
    amountMinor: rubAmountMinor,
    accountCurrency: normalizedCurrency,
    markupPercent: normalizedMarkup,
    officialRateRub,
    rateFetchedAt: rate.effective_at,
    rateSource: rate.source || null,
  });
}

module.exports = {
  normalizeCurrency,
  normalizePercent,
  calculatePaymentCurrencySnapshot,
  buildPaymentCurrencySnapshot,
};
