const { getSupabaseAdminClient } = require('./supabase');
const { sha256, randomToken, addDays, verifyPassword, normalizeEmail } = require('./security');

function bearer(req) {
  const value = String(req.headers.authorization || '');
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : null;
}

async function createSession(partnerId, days = 7) {
  const db = getSupabaseAdminClient();
  const token = randomToken('wcv2sess_');
  const expiresAt = addDays(new Date(), days);
  const { error } = await db.from('partner_sessions').insert({
    partner_id: partnerId,
    token_hash: sha256(token),
    expires_at: expiresAt,
  });
  if (error) throw error;
  return { token, expiresAt };
}

async function revokeSession(token) {
  if (!token) return;
  const db = getSupabaseAdminClient();
  const { error } = await db
    .from('partner_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('token_hash', sha256(token))
    .is('revoked_at', null);
  if (error) throw error;
}

async function findLogin(login) {
  const db = getSupabaseAdminClient();
  const normalized = normalizeEmail(login);
  let result = await db.from('partners').select('*').eq('email', normalized).maybeSingle();
  if (result.error) throw result.error;
  if (result.data) return result.data;
  result = await db.from('partners').select('*').eq('login', normalized).maybeSingle();
  if (result.error) throw result.error;
  return result.data || null;
}

async function getSessionPartner(token) {
  if (!token) return null;
  const db = getSupabaseAdminClient();
  const { data, error } = await db
    .from('partner_sessions')
    .select('id,partner_id,expires_at,revoked_at,partner:partners(*)')
    .eq('token_hash', sha256(token))
    .maybeSingle();
  if (error) throw error;
  if (!data || data.revoked_at || new Date(data.expires_at).getTime() <= Date.now()) return null;
  if (!data.partner || data.partner.archived_at) return null;
  return { session: data, partner: data.partner };
}

function auth({ admin = false } = {}) {
  return async (req, res, next) => {
    try {
      const token = bearer(req);
      const result = await getSessionPartner(token);
      if (!result) return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Требуется авторизация' });
      if (result.partner.is_active === false) return res.status(403).json({ success: false, error: 'ACCOUNT_DISABLED', message: 'Учётная запись отключена' });
      if (admin && result.partner.is_admin !== true) return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Недостаточно прав' });
      req.sessionToken = token;
      req.partner = result.partner;
      req.partnerSession = result.session;
      next();
    } catch (error) {
      next(error);
    }
  };
}

async function verifyLogin(login, password, { admin = false } = {}) {
  const partner = await findLogin(login);
  if (!partner || partner.archived_at || !partner.is_active) return null;
  if (admin && !partner.is_admin) return null;
  if (!partner.password_hash || !(await verifyPassword(password, partner.password_hash))) return null;
  return partner;
}

function publicPartner(partner) {
  return {
    id: partner.id,
    public_id: partner.public_id,
    login: partner.login,
    email: partner.email,
    company_name: partner.company_name,
    is_admin: Boolean(partner.is_admin),
    is_active: Boolean(partner.is_active),
    environment: partner.environment || 'production',
    environment_revision: Number(partner.environment_revision || 0),
  };
}

module.exports = { bearer, createSession, revokeSession, getSessionPartner, auth, verifyLogin, publicPartner };
