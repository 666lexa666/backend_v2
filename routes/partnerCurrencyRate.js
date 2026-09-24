const express = require('express');
const { getSupabaseAdminClient } = require('../lib/supabase');
const { partnerApiAuth } = require('../lib/partnerApiAuth');

const router = express.Router();

function normalizeCurrency(value) {
  const currency = String(value || 'RUB').trim().toUpperCase();
  return ['RUB', 'USD', 'EUR'].includes(currency) ? currency : 'RUB';
}

function normalizePercent(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function roundMoney(value) {
  return Math.round(Number(value) * 1000000) / 1000000;
}

async function getLatestCurrencyRate(client, currency) {
  if (currency === 'RUB') {
    return { rateRub: 1, fetchedAt: new Date().toISOString() };
  }

  const { data, error } = await client
    .from('currency_rates')
    .select('currency,rate_rub,source,fetched_at')
    .eq('currency', currency)
    .order('fetched_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return {
    currency: data.currency,
    rateRub: Number(data.rate_rub),
    fetchedAt: data.fetched_at,
  };
}

router.get('/', partnerApiAuth(), async (req, res) => {
  try {
    const partner = req.partner;
    const client = getSupabaseAdminClient();
    const accountCurrency = normalizeCurrency(partner.account_currency);
    const markupPercent = accountCurrency === 'RUB' ? 0 : normalizePercent(partner.currency_markup_percent);

    if (accountCurrency === 'RUB') {
      return res.status(200).json({
        success: true,
        accountCurrency: 'RUB',
        effectiveRateRub: 1,
        fetchedAt: new Date().toISOString(),
      });
    }

    const latest = await getLatestCurrencyRate(client, accountCurrency);
    if (!latest || !Number.isFinite(Number(latest.rateRub)) || Number(latest.rateRub) <= 0) {
      return res.status(404).json({
        success: false,
        error: 'CURRENCY_RATE_NOT_FOUND',
        message: `Для валюты ${accountCurrency} пока нет актуального курса`,
        accountCurrency,
      });
    }

    const officialRateRub = roundMoney(Number(latest.rateRub));
    const effectiveRateRub = roundMoney(officialRateRub * (1 + markupPercent / 100));

    return res.status(200).json({
      success: true,
      accountCurrency,
      effectiveRateRub,
      fetchedAt: latest.fetchedAt || null,
    });
  } catch (error) {
    console.error('Ошибка endpoint /currency-rate:', error);
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: 'Внутренняя ошибка сервера',
    });
  }
});

router.all('/', (req, res) => {
  return res.status(405).json({
    success: false,
    error: 'METHOD_NOT_ALLOWED',
    message: 'Разрешен только GET запрос',
  });
});

module.exports = router;
