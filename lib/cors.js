function allowedOrigins() {
  return new Set(
    String(process.env.WC_V2_ALLOWED_ORIGINS || 'https://whitecapital.tech,https://www.whitecapital.tech')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function cors(req, res, next) {
  const origin = req.headers.origin;
  const allowed = allowedOrigins();

  if (origin && allowed.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-Request-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');

  if (req.method === 'OPTIONS') {
    if (origin && !allowed.has(origin)) return res.status(403).end();
    return res.status(204).end();
  }
  return next();
}

module.exports = { cors };
