const { getSupabaseAdminClient } = require('./supabase');
const { rublesToMinor, validateRange } = require('./money');

function text(value, max = 500) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const out = String(value).trim().slice(0, max);
  return out || null;
}

function bool(value, fallback) {
  return value === undefined ? fallback : Boolean(value);
}

function terminalLimitsPayload(body, current = {}) {
  const minProvided = body.minAmountRub !== undefined || body.min_amount_rub !== undefined || body.minAmountMinor !== undefined || body.min_amount_minor !== undefined;
  const maxProvided = body.maxAmountRub !== undefined || body.max_amount_rub !== undefined || body.maxAmountMinor !== undefined || body.max_amount_minor !== undefined;

  let min = current.min_amount_minor ?? null;
  let max = current.max_amount_minor ?? null;

  if (minProvided) {
    const raw = body.minAmountMinor ?? body.min_amount_minor;
    min = raw !== undefined ? (raw === null || raw === '' ? null : Number(raw)) : rublesToMinor(body.minAmountRub ?? body.min_amount_rub);
  }
  if (maxProvided) {
    const raw = body.maxAmountMinor ?? body.max_amount_minor;
    max = raw !== undefined ? (raw === null || raw === '' ? null : Number(raw)) : rublesToMinor(body.maxAmountRub ?? body.max_amount_rub);
  }

  if (min != null && (!Number.isSafeInteger(min) || min <= 0)) throw Object.assign(new Error('Некорректный минимальный чек'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  if (max != null && (!Number.isSafeInteger(max) || max <= 0)) throw Object.assign(new Error('Некорректный максимальный чек'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  validateRange(min, max);

  return { min_amount_minor: min, max_amount_minor: max, minProvided, maxProvided };
}

function mapCatalog(row) {
  return {
    ...row,
    is_archived: Boolean(row.is_archived ?? row.archived_at),
    min_amount_kopecks: row.min_amount_minor == null ? null : Number(row.min_amount_minor),
    max_amount_kopecks: row.max_amount_minor == null ? null : Number(row.max_amount_minor),
    monthly_limit_kopecks: row.monthly_limit_minor == null ? null : Number(row.monthly_limit_minor),
    bank: row.bank_name ? {
      id: row.bank_id,
      name: row.bank_name,
      code: row.bank_code,
      provider_code: row.provider_code,
    } : null,
  };
}

function mapAssignment(row) {
  return {
    ...row,
    catalog_terminal_id: row.terminal_id,
    is_archived: Boolean(row.is_archived ?? row.archived_at),
    min_amount_kopecks: row.min_amount_minor == null ? null : Number(row.min_amount_minor),
    max_amount_kopecks: row.max_amount_minor == null ? null : Number(row.max_amount_minor),
    catalog_min_amount_kopecks: row.catalog_min_amount_minor == null ? null : Number(row.catalog_min_amount_minor),
    catalog_max_amount_kopecks: row.catalog_max_amount_minor == null ? null : Number(row.catalog_max_amount_minor),
    effective_min_amount_kopecks: row.effective_min_amount_minor == null ? null : Number(row.effective_min_amount_minor),
    effective_max_amount_kopecks: row.effective_max_amount_minor == null ? null : Number(row.effective_max_amount_minor),
    bank: row.bank_name ? {
      id: row.bank_id,
      name: row.bank_name,
      code: row.bank_code,
      provider_code: row.provider_code,
    } : null,
  };
}

async function listAdminCatalog() {
  const db = getSupabaseAdminClient();
  const { data, error } = await db.from('admin_terminal_catalog_v2').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapCatalog);
}

async function getCatalog(id) {
  const db = getSupabaseAdminClient();
  const { data, error } = await db.from('terminals').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function createCatalog(body) {
  const db = getSupabaseAdminClient();
  const bankId = Number(body.bankId ?? body.bank_id);
  const name = text(body.name, 160);
  const companyName = text(body.companyName ?? body.company_name, 255);
  const paymentMethod = String(body.paymentMethod ?? body.payment_method ?? '').trim().toUpperCase();
  const limits = terminalLimitsPayload(body);

  if (!Number.isSafeInteger(bankId) || bankId <= 0) throw Object.assign(new Error('Выберите банк'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  if (!name) throw Object.assign(new Error('Название терминала обязательно'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  if (!['SBP','CARD'].includes(paymentMethod)) throw Object.assign(new Error('Способ должен быть SBP или CARD'), { statusCode: 400, code: 'VALIDATION_ERROR' });

  const { data: bank, error: bankError } = await db.from('banks').select('id,is_active').eq('id', bankId).maybeSingle();
  if (bankError) throw bankError;
  if (!bank) throw Object.assign(new Error('Банк не найден'), { statusCode: 404, code: 'BANK_NOT_FOUND' });

  const monthlyRaw = body.monthlyLimitMinor ?? body.monthly_limit_minor;
  const monthlyLimit = monthlyRaw !== undefined
    ? (monthlyRaw === null || monthlyRaw === '' ? null : Number(monthlyRaw))
    : rublesToMinor(body.monthlyLimitRub ?? body.monthly_limit_rub);

  const payload = {
    bank_id: bankId,
    name,
    company_name: companyName,
    payment_method: paymentMethod,
    provider_terminal_key: text(body.providerTerminalKey ?? body.provider_terminal_key, 255),
    merchant_id: text(body.merchantId ?? body.merchant_id, 255),
    ext_entity_id: text(body.extEntityId ?? body.ext_entity_id, 255),
    account: text(body.account, 255),
    acc_alias: text(body.accAlias ?? body.acc_alias, 255),
    provider_config: body.providerConfig ?? body.provider_config ?? {},
    supports_recurrent_payments: bool(body.supportsRecurrentPayments ?? body.supports_recurrent_payments, false),
    monthly_limit_minor: monthlyLimit,
    min_amount_minor: limits.min_amount_minor,
    max_amount_minor: limits.max_amount_minor,
    is_active: bool(body.isActive ?? body.is_active, true),
  };

  const { data, error } = await db.from('terminals').insert(payload).select('*').single();
  if (error) throw error;
  return data;
}

async function updateCatalog(id, body) {
  const db = getSupabaseAdminClient();
  const current = await getCatalog(id);
  if (!current) throw Object.assign(new Error('Терминал не найден'), { statusCode: 404, code: 'TERMINAL_NOT_FOUND' });
  if (current.archived_at && (body.isActive === true || body.is_active === true)) {
    throw Object.assign(new Error('Сначала восстановите терминал из архива'), { statusCode: 409, code: 'TERMINAL_ARCHIVED' });
  }

  const limits = terminalLimitsPayload(body, current);
  const update = {};

  if (body.bankId !== undefined || body.bank_id !== undefined) {
    const bankId = Number(body.bankId ?? body.bank_id);
    if (!Number.isSafeInteger(bankId) || bankId <= 0) throw Object.assign(new Error('Некорректный банк'), { statusCode: 400, code: 'VALIDATION_ERROR' });
    update.bank_id = bankId;
  }
  if (body.name !== undefined) {
    update.name = text(body.name, 160);
    if (!update.name) throw Object.assign(new Error('Название терминала обязательно'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }
  if (body.companyName !== undefined || body.company_name !== undefined) update.company_name = text(body.companyName ?? body.company_name, 255);
  if (body.paymentMethod !== undefined || body.payment_method !== undefined) {
    const method = String(body.paymentMethod ?? body.payment_method).trim().toUpperCase();
    if (!['SBP','CARD'].includes(method)) throw Object.assign(new Error('Способ должен быть SBP или CARD'), { statusCode: 400, code: 'VALIDATION_ERROR' });
    update.payment_method = method;
  }

  const textFields = [
    ['provider_terminal_key','providerTerminalKey',255],
    ['merchant_id','merchantId',255],
    ['ext_entity_id','extEntityId',255],
    ['account','account',255],
    ['acc_alias','accAlias',255],
  ];
  for (const [snake, camel, max] of textFields) {
    if (body[camel] !== undefined || body[snake] !== undefined) update[snake] = text(body[camel] ?? body[snake], max);
  }

  if (body.providerConfig !== undefined || body.provider_config !== undefined) update.provider_config = body.providerConfig ?? body.provider_config ?? {};
  if (body.supportsRecurrentPayments !== undefined || body.supports_recurrent_payments !== undefined) update.supports_recurrent_payments = Boolean(body.supportsRecurrentPayments ?? body.supports_recurrent_payments);
  if (body.isActive !== undefined || body.is_active !== undefined) update.is_active = Boolean(body.isActive ?? body.is_active);
  if (limits.minProvided) update.min_amount_minor = limits.min_amount_minor;
  if (limits.maxProvided) update.max_amount_minor = limits.max_amount_minor;

  if (body.monthlyLimitRub !== undefined || body.monthly_limit_rub !== undefined || body.monthlyLimitMinor !== undefined || body.monthly_limit_minor !== undefined) {
    const rawMinor = body.monthlyLimitMinor ?? body.monthly_limit_minor;
    update.monthly_limit_minor = rawMinor !== undefined
      ? (rawMinor === null || rawMinor === '' ? null : Number(rawMinor))
      : rublesToMinor(body.monthlyLimitRub ?? body.monthly_limit_rub);
  }

  if (!Object.keys(update).length) throw Object.assign(new Error('Нет данных для обновления'), { statusCode: 400, code: 'EMPTY_UPDATE' });

  const { data, error } = await db.from('terminals').update(update).eq('id', id).select('*').single();
  if (error) throw error;
  return data;
}

async function setCatalogArchived(id, archived, actorId, reason) {
  const db = getSupabaseAdminClient();
  const { data, error } = await db.rpc('set_terminal_archive_v2', {
    p_terminal_id: id,
    p_archived: archived,
    p_actor_id: actorId,
    p_reason: reason || null,
  });
  if (error) throw error;
  return data;
}

async function listAdminPartnerTerminals(partnerId) {
  const db = getSupabaseAdminClient();
  const { data, error } = await db
    .from('admin_partner_terminals_v2')
    .select('*')
    .eq('partner_id', partnerId)
    .order('is_default', { ascending: false })
    .order('assigned_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(mapAssignment);
}

async function loadAssignmentContext(partnerId, projectId, terminalId) {
  const db = getSupabaseAdminClient();
  const [{ data: partner, error: pe }, { data: project, error: pre }, { data: terminal, error: te }] = await Promise.all([
    db.from('partners').select('id,is_active,archived_at').eq('id', partnerId).eq('is_admin', false).maybeSingle(),
    db.from('partner_projects').select('*').eq('id', projectId).eq('partner_id', partnerId).maybeSingle(),
    db.from('terminals').select('*').eq('id', terminalId).maybeSingle(),
  ]);
  if (pe) throw pe;
  if (pre) throw pre;
  if (te) throw te;
  if (!partner || partner.archived_at) throw Object.assign(new Error('Партнёр не найден'), { statusCode: 404, code: 'PARTNER_NOT_FOUND' });
  if (!project || project.archived_at) throw Object.assign(new Error('Проект не найден'), { statusCode: 404, code: 'PROJECT_NOT_FOUND' });
  if (!terminal || terminal.archived_at) throw Object.assign(new Error('Терминал каталога не найден'), { statusCode: 404, code: 'TERMINAL_NOT_FOUND' });
  return { partner, project, terminal };
}

function validateEffectiveRange(terminal, ownMin, ownMax) {
  const effectiveMin = ownMin == null ? terminal.min_amount_minor : terminal.min_amount_minor == null ? ownMin : Math.max(Number(ownMin), Number(terminal.min_amount_minor));
  const effectiveMax = ownMax == null ? terminal.max_amount_minor : terminal.max_amount_minor == null ? ownMax : Math.min(Number(ownMax), Number(terminal.max_amount_minor));
  validateRange(effectiveMin, effectiveMax);
  return { effectiveMin, effectiveMax };
}

async function createPartnerTerminal(partnerId, body) {
  const db = getSupabaseAdminClient();
  const projectId = String(body.projectId ?? body.project_id ?? '').trim();
  const terminalId = String(body.catalogTerminalId ?? body.catalog_terminal_id ?? body.terminalId ?? body.terminal_id ?? '').trim();
  const label = text(body.label, 160);
  if (!projectId || !terminalId || !label) throw Object.assign(new Error('Терминал, проект и название обязательны'), { statusCode: 400, code: 'VALIDATION_ERROR' });

  const { terminal } = await loadAssignmentContext(partnerId, projectId, terminalId);
  if (!terminal.is_active) throw Object.assign(new Error('Терминал каталога выключен'), { statusCode: 409, code: 'TERMINAL_DISABLED' });

  const limits = terminalLimitsPayload(body);
  validateEffectiveRange(terminal, limits.min_amount_minor, limits.max_amount_minor);

  const { count, error: countError } = await db
    .from('partner_terminals')
    .select('id', { count: 'exact', head: true })
    .eq('partner_id', partnerId)
    .eq('project_id', projectId)
    .is('archived_at', null)
    .eq('is_active', true);
  if (countError) throw countError;

  const makeDefault = Boolean(body.isDefault ?? body.is_default) || Number(count || 0) === 0;
  if (makeDefault) {
    const { error } = await db.from('partner_terminals')
      .update({ is_default: false })
      .eq('partner_id', partnerId)
      .eq('project_id', projectId)
      .eq('is_default', true);
    if (error) throw error;
  }

  const { data, error } = await db.from('partner_terminals').insert({
    partner_id: partnerId,
    project_id: projectId,
    terminal_id: terminalId,
    label,
    min_amount_minor: limits.min_amount_minor,
    max_amount_minor: limits.max_amount_minor,
    payment_form_enabled: bool(body.paymentFormEnabled ?? body.payment_form_enabled, true),
    auto_distribution_enabled: bool(body.autoDistributionEnabled ?? body.auto_distribution_enabled, true),
    is_default: makeDefault,
    is_active: true,
  }).select('*').single();
  if (error?.code === '23505') throw Object.assign(new Error('Этот терминал уже назначен проекту'), { statusCode: 409, code: 'TERMINAL_ALREADY_ASSIGNED' });
  if (error) throw error;
  return data;
}

async function updatePartnerTerminal(partnerId, assignmentId, body) {
  const db = getSupabaseAdminClient();
  const { data: current, error: currentError } = await db.from('partner_terminals')
    .select('*').eq('id', assignmentId).eq('partner_id', partnerId).maybeSingle();
  if (currentError) throw currentError;
  if (!current) throw Object.assign(new Error('Терминал партнёра не найден'), { statusCode: 404, code: 'PARTNER_TERMINAL_NOT_FOUND' });
  if (current.archived_at) throw Object.assign(new Error('Сначала восстановите терминал из архива'), { statusCode: 409, code: 'TERMINAL_ARCHIVED' });

  const projectId = String(body.projectId ?? body.project_id ?? current.project_id);
  const terminalId = String(body.catalogTerminalId ?? body.catalog_terminal_id ?? body.terminalId ?? body.terminal_id ?? current.terminal_id);
  const { terminal } = await loadAssignmentContext(partnerId, projectId, terminalId);
  const limits = terminalLimitsPayload(body, current);
  validateEffectiveRange(terminal, limits.min_amount_minor, limits.max_amount_minor);

  const update = {
    project_id: projectId,
    terminal_id: terminalId,
    min_amount_minor: limits.min_amount_minor,
    max_amount_minor: limits.max_amount_minor,
  };
  if (body.label !== undefined) {
    update.label = text(body.label, 160);
    if (!update.label) throw Object.assign(new Error('Название обязательно'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }
  if (body.paymentFormEnabled !== undefined || body.payment_form_enabled !== undefined) update.payment_form_enabled = Boolean(body.paymentFormEnabled ?? body.payment_form_enabled);
  if (body.autoDistributionEnabled !== undefined || body.auto_distribution_enabled !== undefined) update.auto_distribution_enabled = Boolean(body.autoDistributionEnabled ?? body.auto_distribution_enabled);
  if (body.isActive !== undefined || body.is_active !== undefined) update.is_active = Boolean(body.isActive ?? body.is_active);

  const makeDefault = body.isDefault ?? body.is_default;
  if (makeDefault === true) {
    const { error } = await db.from('partner_terminals')
      .update({ is_default: false })
      .eq('partner_id', partnerId)
      .eq('project_id', projectId)
      .eq('is_default', true)
      .neq('id', assignmentId);
    if (error) throw error;
    update.is_default = true;
  } else if (makeDefault === false) {
    update.is_default = false;
  }

  if (update.is_active === false) update.is_default = false;

  const { data, error } = await db.from('partner_terminals').update(update)
    .eq('id', assignmentId).eq('partner_id', partnerId).select('*').single();
  if (error) throw error;
  return data;
}

async function setPartnerTerminalArchived(partnerId, assignmentId, archived, actorId, reason) {
  const db = getSupabaseAdminClient();
  const { data: existing, error: findError } = await db
    .from('partner_terminals').select('id').eq('id', assignmentId).eq('partner_id', partnerId).maybeSingle();
  if (findError) throw findError;
  if (!existing) throw Object.assign(new Error('Терминал партнёра не найден'), { statusCode: 404, code: 'PARTNER_TERMINAL_NOT_FOUND' });

  const { data, error } = await db.rpc('set_partner_terminal_archive_v2', {
    p_partner_terminal_id: assignmentId,
    p_archived: archived,
    p_actor_id: actorId,
    p_reason: reason || null,
  });
  if (error) throw error;
  return data;
}

async function listPartnerVisible(partnerId, projectId = null, { activeOnly = false } = {}) {
  const db = getSupabaseAdminClient();
  let query = db
    .from(activeOnly ? 'partner_routable_terminals_v2' : 'partner_visible_terminals_v2')
    .select('*')
    .eq('partner_id', partnerId);
  if (projectId) query = query.eq('project_id', projectId);
  const { data, error } = await query.order('is_default', { ascending: false }).order('assigned_at', { ascending: true });
  if (error) throw error;
  return (data || []).map((row) => ({
    ...row,
    catalog_terminal_id: row.terminal_id,
    min_amount_kopecks: row.min_amount_minor == null ? null : Number(row.min_amount_minor),
    max_amount_kopecks: row.max_amount_minor == null ? null : Number(row.max_amount_minor),
    catalog_min_amount_kopecks: row.catalog_min_amount_minor == null ? null : Number(row.catalog_min_amount_minor),
    catalog_max_amount_kopecks: row.catalog_max_amount_minor == null ? null : Number(row.catalog_max_amount_minor),
    effective_min_amount_kopecks: row.effective_min_amount_minor == null ? null : Number(row.effective_min_amount_minor),
    effective_max_amount_kopecks: row.effective_max_amount_minor == null ? null : Number(row.effective_max_amount_minor),
  }));
}

module.exports = {
  listAdminCatalog,
  createCatalog,
  updateCatalog,
  setCatalogArchived,
  listAdminPartnerTerminals,
  createPartnerTerminal,
  updatePartnerTerminal,
  setPartnerTerminalArchived,
  listPartnerVisible,
};
