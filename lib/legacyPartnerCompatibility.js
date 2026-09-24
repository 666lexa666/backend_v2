const MAX_PARTNER_ORDER_ID_LENGTH = 128;
const CONTROL_CHARACTERS_PATTERN = /[\u0000-\u001f\u007f]/;
const CLIENT_PHONE_PATTERN = /^007[0-9]{10}$/;
const CLIENT_PAM_MAX_LENGTH = 140;

function normalizePartnerOrderId(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return { value: null, error: null };
  }
  if (typeof rawValue !== 'string') {
    return { value: null, error: 'orderId должен быть строкой' };
  }
  const value = rawValue.trim();
  if (!value) return { value: null, error: null };
  if (value.length > MAX_PARTNER_ORDER_ID_LENGTH) {
    return { value: null, error: `orderId не должен быть длиннее ${MAX_PARTNER_ORDER_ID_LENGTH} символов` };
  }
  if (CONTROL_CHARACTERS_PATTERN.test(value)) {
    return { value: null, error: 'orderId не должен содержать управляющие символы' };
  }
  return { value, error: null };
}

function normalizeUrlValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function resolveQrRedirectUrl(requestValue, partnerValue) {
  return normalizeUrlValue(requestValue) || normalizeUrlValue(partnerValue) || null;
}

function isAsciiHttpUrl(value) {
  const text = String(value || '');
  if (!text || !/^[\x00-\x7F]+$/.test(text)) return false;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeClientPhone(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value);
  return normalized || null;
}

function validateClientPhone(value, { required = false } = {}) {
  const normalized = normalizeClientPhone(value);
  if (!normalized) {
    return required ? 'clientPhone обязателен и должен быть в формате 0079999999999' : null;
  }
  return CLIENT_PHONE_PATTERN.test(normalized)
    ? null
    : 'clientPhone должен быть строго в формате 0079999999999: 13 цифр, префикс 007';
}

function normalizeClientPam(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function validateClientPam(value, { required = false } = {}) {
  const normalized = normalizeClientPam(value);
  if (!normalized) return required ? 'clientPam обязателен' : null;
  return normalized.length <= CLIENT_PAM_MAX_LENGTH
    ? null
    : `clientPam не должен быть длиннее ${CLIENT_PAM_MAX_LENGTH} символов`;
}

function resolveBankPaymentPurpose({
  originalPurpose,
  paymentId,
  clientPhone,
  useClientPhone = false,
  useTransactionId = false,
}) {
  if (useClientPhone) {
    const normalized = normalizeClientPhone(clientPhone);
    const validationError = validateClientPhone(normalized, { required: true });
    if (validationError) {
      const error = new Error(validationError);
      error.code = 'INVALID_CLIENT_PHONE';
      throw error;
    }
    return `${normalized};${paymentId}`;
  }
  if (useTransactionId) return String(paymentId);
  return originalPurpose;
}

function validateMaxLength(errors, value, fieldName, maxLength) {
  if (value === undefined || value === null) return;
  if (String(value).length > maxLength) {
    errors.push(`${fieldName} не должен быть длиннее ${maxLength} символов`);
  }
}

function amountWithinAssignmentLimits(assignment, amountMinor) {
  const amount = Number(amountMinor);
  const min = assignment?.effective_min_amount_minor == null
    ? null : Number(assignment.effective_min_amount_minor);
  const max = assignment?.effective_max_amount_minor == null
    ? null : Number(assignment.effective_max_amount_minor);
  return (min == null || amount >= min) && (max == null || amount <= max);
}

function terminalAmountErrors(assignment, amountMinor) {
  const errors = [];
  const amount = Number(amountMinor);
  const min = assignment?.effective_min_amount_minor == null
    ? null : Number(assignment.effective_min_amount_minor);
  const max = assignment?.effective_max_amount_minor == null
    ? null : Number(assignment.effective_max_amount_minor);
  if (min !== null && amount < min) {
    errors.push(`Сумма меньше минимально допустимой для выбранного терминала: ${(min / 100).toFixed(2)} ₽`);
  }
  if (max !== null && amount > max) {
    errors.push(`Сумма больше максимально допустимой для выбранного терминала: ${(max / 100).toFixed(2)} ₽`);
  }
  return errors;
}

function chooseLegacyTerminalAssignment({
  rows = [],
  partner = {},
  terminalId = null,
  amountMinor,
  method = 'SBP',
  random = Math.random,
}) {
  const normalizedMethod = String(method || 'SBP').toUpperCase();
  const effectiveTerminalId = partner?.ignore_request_terminal_id
    ? null
    : normalizeUrlValue(terminalId) || null;

  if (effectiveTerminalId) {
    const assignment = rows.find((row) => String(row.partner_terminal_id) === effectiveTerminalId) || null;
    if (!assignment) return { assignment: null, effectiveTerminalId, reason: 'explicit_not_found' };
    if (String(assignment.payment_method || '').toUpperCase() !== normalizedMethod) {
      return { assignment, effectiveTerminalId, reason: 'method_mismatch' };
    }
    return { assignment, effectiveTerminalId, reason: null };
  }

  const methodRows = rows.filter((row) => String(row.payment_method || '').toUpperCase() === normalizedMethod);

  if (!partner?.terminal_auto_distribution_enabled) {
    const assignment = methodRows.find((row) => row.is_default) || null;
    return { assignment, effectiveTerminalId: null, reason: assignment ? null : 'no_default' };
  }

  const automatic = methodRows.filter((row) => row.auto_distribution_enabled !== false);
  if (!automatic.length) {
    return { assignment: null, effectiveTerminalId: null, reason: 'no_automatic' };
  }
  if (automatic.length === 1) {
    return { assignment: automatic[0], effectiveTerminalId: null, reason: null };
  }

  const eligible = automatic.filter((row) => amountWithinAssignmentLimits(row, amountMinor));
  if (!eligible.length) {
    return { assignment: null, effectiveTerminalId: null, reason: 'amount_not_routable' };
  }

  const sample = Number(random());
  const bounded = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 0.9999999999999999) : 0;
  return {
    assignment: eligible[Math.floor(bounded * eligible.length)],
    effectiveTerminalId: null,
    reason: null,
  };
}

async function resolveLegacyTerminalAssignment({
  db,
  partner,
  terminalId,
  projectId = null,
  amountMinor,
  method = 'SBP',
  random = Math.random,
}) {
  let query = db.from('partner_payment_routes_v2')
    .select('*')
    .eq('partner_id', Number(partner.id));
  if (projectId) query = query.eq('project_id', String(projectId));

  const { data, error } = await query
    .order('is_default', { ascending: false })
    .order('partner_terminal_id', { ascending: true });
  if (error) throw error;

  return chooseLegacyTerminalAssignment({
    rows: data || [],
    partner,
    terminalId,
    amountMinor,
    method,
    random,
  });
}

function validateLegacyQrRequest({ body = {}, partner = {}, assignment = null, runtime = null }) {
  const errors = [];
  const qrcType = body.qrcType;
  const amount = body.amount;
  const paymentPurpose = String(body.paymentPurpose || body.description || '').trim();
  const clientPam = body.clientPam === undefined ? undefined : normalizeClientPam(body.clientPam);
  const redirectUrl = resolveQrRedirectUrl(body.redirectUrl, partner.redirect_url);
  const expDt = partner.qr_exp_dt ?? 15;
  const localExpDt = partner.qr_local_exp_dt ?? 900;

  if (runtime) {
    if (String(runtime.providerCode || '').toLowerCase() === 'ingo') {
      if (!runtime.providerConfig?.ingo_tsp_merchant_id) errors.push('Для терминала Ingo не задан TSP Merchant ID');
      if (!runtime.providerConfig?.ingo_merchant_login) errors.push('Для терминала Ingo не задан Merchant Login');
    } else {
      if (!runtime.extEntityId) errors.push('Для партнера не задан partners.ext_entity_id');
      if (!runtime.merchantId) errors.push('Для партнера не задан partners.merchant_id');
      if (!runtime.account && !runtime.accAlias) errors.push('Для партнера нужно задать account или acc_alias');
    }
    if (!runtime.bankId) errors.push('Для партнера не назначен банк (partners.bank_id)');

    if (String(runtime.providerCode || '').toLowerCase() !== 'ingo') {
      if (runtime.extEntityId && String(runtime.extEntityId).length > 32) errors.push('partners.ext_entity_id не должен быть длиннее 32 символов');
      if (runtime.merchantId && String(runtime.merchantId).length > 12) errors.push('partners.merchant_id не должен быть длиннее 12 символов');
      if (runtime.account && !/^\d{5}810\d{12}$/.test(String(runtime.account))) errors.push('partners.account должен соответствовать шаблону ^\\d{5}810\\d{12}$');
      if (runtime.accAlias && String(runtime.accAlias).length > 127) errors.push('partners.acc_alias не должен быть длиннее 127 символов');
    }
  }

  errors.push(...terminalAmountErrors(assignment, amount));

  if (qrcType === undefined || qrcType === null || qrcType === '') {
    errors.push('qrcType обязателен и должен быть 02 или 03');
  } else if (!['02', '03'].includes(String(qrcType))) {
    errors.push('qrcType должен быть 02 или 03');
  }

  if (amount === undefined || amount === null || amount === '') {
    errors.push('amount обязателен');
  } else if (!/^\d{1,12}$/.test(String(amount)) || Number(amount) <= 0) {
    errors.push('amount должен быть целым числом в копейках от 1 до 12 цифр');
  }

  if (!paymentPurpose) errors.push('paymentPurpose обязателен');

  const clientPhoneError = validateClientPhone(body.clientPhone, {
    required: Boolean(partner.purpose_use_client_phone || partner.require_qr_client_identity),
  });
  if (clientPhoneError) errors.push(clientPhoneError);

  const clientPamError = validateClientPam(clientPam, {
    required: Boolean(partner.require_qr_client_identity),
  });
  if (clientPamError) errors.push(clientPamError);

  if (String(qrcType) === '03') {
    if (!body.subscriptionPurpose) errors.push('subscriptionPurpose обязателен для QR-подписки qrcType=03');
    if (!body.subscriptionServiceId) errors.push('subscriptionServiceId обязателен для QR-подписки qrcType=03');
    if (!body.subscriptionServiceName) errors.push('subscriptionServiceName обязателен для QR-подписки qrcType=03');
  }

  if (!Number.isInteger(Number(expDt)) || Number(expDt) <= 0) {
    errors.push('partners.qr_exp_dt должен быть положительным целым числом минут');
  }
  if (!Number.isInteger(Number(localExpDt)) || Number(localExpDt) <= 0) {
    errors.push('partners.qr_local_exp_dt должен быть положительным целым числом секунд');
  }

  validateMaxLength(errors, paymentPurpose, 'paymentPurpose', 140);
  validateMaxLength(errors, body.subscriptionPurpose, 'subscriptionPurpose', 140);
  validateMaxLength(errors, body.subscriptionServiceId, 'subscriptionServiceId', 32);
  validateMaxLength(errors, body.subscriptionServiceName, 'subscriptionServiceName', 70);
  validateMaxLength(errors, redirectUrl, 'redirectUrl', 1024);
  if (redirectUrl && !isAsciiHttpUrl(redirectUrl)) errors.push('redirectUrl должен быть ASCII URL');

  return {
    errors,
    normalized: {
      qrcType: qrcType == null ? null : String(qrcType),
      amountMinor: Number(amount),
      paymentPurpose,
      clientPhone: normalizeClientPhone(body.clientPhone),
      clientPam: clientPam ?? null,
      redirectUrl,
      expDt: Number(expDt),
      localExpDt: Number(localExpDt),
      subscriptionPurpose: body.subscriptionPurpose || null,
      subscriptionServiceId: body.subscriptionServiceId || null,
      subscriptionServiceName: body.subscriptionServiceName || null,
    },
  };
}

module.exports = {
  MAX_PARTNER_ORDER_ID_LENGTH,
  CLIENT_PHONE_PATTERN,
  CLIENT_PAM_MAX_LENGTH,
  normalizePartnerOrderId,
  normalizeUrlValue,
  resolveQrRedirectUrl,
  isAsciiHttpUrl,
  normalizeClientPhone,
  validateClientPhone,
  normalizeClientPam,
  validateClientPam,
  resolveBankPaymentPurpose,
  terminalAmountErrors,
  chooseLegacyTerminalAssignment,
  resolveLegacyTerminalAssignment,
  validateLegacyQrRequest,
};
