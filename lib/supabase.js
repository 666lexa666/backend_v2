const { createClient } = require('@supabase/supabase-js');

let cachedClient = null;
let cachedUrl = null;

function getSupabaseAdminClient() {
  const url = String(process.env.WC_V2_SUPABASE_URL || '').trim();
  const serviceRoleKey = String(process.env.WC_V2_SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!url || !serviceRoleKey) {
    throw new Error('WC_V2_SUPABASE_URL и WC_V2_SUPABASE_SERVICE_ROLE_KEY обязательны');
  }

  if (!cachedClient || cachedUrl !== url) {
    cachedUrl = url;
    cachedClient = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cachedClient;
}

module.exports = { getSupabaseAdminClient };
