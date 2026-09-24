function rublesToMinor(value, { nullable = true } = {}) {
  if (value === null || value === undefined || String(value).trim() === '') {
    if (nullable) return null;
    const error = new Error('Сумма обязательна');
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    throw error;
  }

  const raw = String(value).trim().replace(',', '.');
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(raw)) {
    const error = new Error('Сумма должна быть положительным числом, максимум 2 знака после запятой');
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    throw error;
  }

  const [whole, fraction = ''] = raw.split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    const error = new Error('Сумма вне допустимого диапазона');
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
  return Number(minor);
}

function validateRange(minMinor, maxMinor) {
  if (minMinor != null && maxMinor != null && minMinor > maxMinor) {
    const error = new Error('Минимальный чек не может быть больше максимального');
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
}

module.exports = { rublesToMinor, validateRange };
