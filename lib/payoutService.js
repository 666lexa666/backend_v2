const crypto = require('crypto');
const { getSupabaseAdminClient } = require('./supabase');
const { rublesToMinor } = require('./money');

function toPublicPayout(row) {
  if (!row) return null;
  return {
    id: row.id,
    partnerId: Number(row.partner_id),
    paidAt: row.paid_at,
    payoutDay: row.payout_day,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    openingOutstanding: Number(row.opening_outstanding_minor || 0),
    successAmount: Number(row.gross_success_minor || 0),
    successCommission: Number(row.commission_minor || 0),
    refundAmount: Number(row.refund_minor || 0),
    accruedAmount: Number(row.accrued_minor || 0),
    dueBeforePayment: Number(row.due_before_payment_minor || 0),
    amountPaid: Number(row.amount_paid_minor || 0),
    closingOutstanding: Number(row.closing_outstanding_minor || 0),
    currency: String(row.currency || 'RUB').trim(),
    externalRef: row.external_ref || null,
    note: row.note || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    replayed: Boolean(row.replayed),
    projects: row.projects || undefined,
  };
}

async function previewPartnerPayout(partnerId, payoutDay) {
  const db = getSupabaseAdminClient();
  const { data, error } = await db.rpc('get_partner_payout_preview_v2', {
    p_partner_id: partnerId,
    p_payout_day: payoutDay || null,
  });
  if (error) throw error;
  return data;
}

async function previewAllPartnerPayouts(payoutDay) {
  const db = getSupabaseAdminClient();
  const { data: partners, error } = await db
    .from('partners')
    .select('id,company_name,email,login,account_currency,is_active,archived_at')
    .eq('is_admin', false)
    .is('archived_at', null)
    .order('id', { ascending: true });
  if (error) throw error;

  const rows = [];
  for (const partner of partners || []) {
    const preview = await previewPartnerPayout(Number(partner.id), payoutDay);
    rows.push({
      ...preview,
      partnerId: Number(partner.id),
      partnerName: partner.company_name || partner.email || partner.login || `Партнёр #${partner.id}`,
      partnerActive: Boolean(partner.is_active),
      currency: partner.account_currency || preview?.currency || 'RUB',
    });
  }
  return rows;
}

async function recordPartnerPayout({
  partnerId,
  amountRub,
  amountMinor,
  paidAt,
  idempotencyKey,
  actorId,
  externalRef,
  note,
}) {
  const db = getSupabaseAdminClient();
  const resolvedAmount = amountMinor == null ? rublesToMinor(amountRub, { nullable: false }) : Number(amountMinor);
  if (!Number.isSafeInteger(resolvedAmount) || resolvedAmount <= 0) {
    throw Object.assign(new Error('Некорректная сумма выплаты'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }

  const when = paidAt ? new Date(paidAt) : new Date();
  if (!Number.isFinite(when.getTime())) {
    throw Object.assign(new Error('Некорректная дата выплаты'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }

  const key = String(idempotencyKey || '').trim() || crypto.randomUUID();
  const { data, error } = await db.rpc('record_partner_payout_v2', {
    p_partner_id: partnerId,
    p_amount_paid_minor: resolvedAmount,
    p_paid_at: when.toISOString(),
    p_idempotency_key: key,
    p_created_by: actorId,
    p_external_ref: externalRef ? String(externalRef).trim().slice(0, 255) : null,
    p_note: note ? String(note).trim().slice(0, 2000) : null,
  });

  if (error) {
    const wrapped = new Error(
      error.message === 'PAYOUTS_DISABLED_ON_WEEKENDS' ? 'В субботу и воскресенье выплаты отключены'
        : error.message === 'NOTHING_TO_PAYOUT' ? 'Сейчас партнёру нечего выплачивать'
        : error.message === 'PAYOUT_EXCEEDS_DUE' ? 'Сумма выплаты больше рассчитанной суммы к выплате'
        : error.message || 'Ошибка выплаты',
    );
    wrapped.code = error.message || error.code || 'PAYOUT_ERROR';
    wrapped.statusCode = ['PAYOUTS_DISABLED_ON_WEEKENDS','NOTHING_TO_PAYOUT','PAYOUT_EXCEEDS_DUE','PAYOUT_AMOUNT_MUST_BE_POSITIVE'].includes(error.message) ? 400 : 500;
    throw wrapped;
  }

  return toPublicPayout(data);
}

async function listPartnerPayouts(partnerId, { limit = 50, beforePaidAt = null, beforeId = null } = {}) {
  const db = getSupabaseAdminClient();
  const { data, error } = await db.rpc('list_partner_payouts_v2', {
    p_partner_id: partnerId,
    p_limit: Math.max(1, Math.min(Number(limit) || 50, 200)),
    p_before_paid_at: beforePaidAt || null,
    p_before_id: beforeId || null,
  });
  if (error) throw error;
  return (data || []).map(toPublicPayout);
}

module.exports = { previewPartnerPayout, previewAllPartnerPayouts, recordPartnerPayout, listPartnerPayouts };
