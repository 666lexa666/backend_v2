const express = require('express');
const { auth } = require('../lib/auth');
const { listPartnerVisible } = require('../lib/terminalService');
const { getSupabaseAdminClient } = require('../lib/supabase');

const router = express.Router();
router.use(auth());

router.get('/terminals', async (req, res, next) => {
  try {
    const projectId = req.query.projectId ? String(req.query.projectId) : null;
    const terminals = await listPartnerVisible(req.partner.id, projectId, { activeOnly: false });
    res.json({ success: true, terminals });
  } catch (error) { next(error); }
});

router.get('/projects/:projectId/terminals', async (req, res, next) => {
  try {
    const db = getSupabaseAdminClient();
    const { data: project, error } = await db.from('partner_projects')
      .select('id,partner_id,name,is_active,archived_at')
      .eq('id', req.params.projectId)
      .eq('partner_id', req.partner.id)
      .is('archived_at', null)
      .maybeSingle();
    if (error) throw error;
    if (!project) return res.status(404).json({ success: false, error: 'PROJECT_NOT_FOUND', message: 'Проект не найден' });

    const terminals = await listPartnerVisible(req.partner.id, project.id, { activeOnly: false });
    res.json({ success: true, project, terminals });
  } catch (error) { next(error); }
});

module.exports = router;
