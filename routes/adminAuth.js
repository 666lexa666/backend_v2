const express = require('express');
const { getSupabaseAdminClient } = require('../lib/supabase');
const { createSession, revokeSession, auth, verifyLogin, publicPartner } = require('../lib/auth');

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const login = String(req.body?.email || req.body?.login || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!login || !password) {
      return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'Введите email и пароль' });
    }

    const partner = await verifyLogin(login, password, { admin: true });
    if (!partner) {
      return res.status(401).json({ success: false, error: 'INVALID_CREDENTIALS', message: 'Неверный email или пароль' });
    }

    const session = await createSession(partner.id, Number(process.env.WC_V2_ADMIN_SESSION_DAYS || 1));
    await getSupabaseAdminClient().from('partners').update({ last_login_at: new Date().toISOString() }).eq('id', partner.id);

    return res.json({
      success: true,
      token: session.token,
      expiresAt: session.expiresAt,
      admin: publicPartner(partner),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/logout', auth({ admin: true }), async (req, res, next) => {
  try {
    await revokeSession(req.sessionToken);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.get('/me', auth({ admin: true }), (req, res) => {
  res.json({ success: true, admin: publicPartner(req.partner) });
});

module.exports = router;
