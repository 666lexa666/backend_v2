const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const privateKeyCache = new Map();

function extractPrivateKeyPem(bank) {
  const cacheKey = String(bank.id || bank.code || bank.name || 'bank');
  if (privateKeyCache.has(cacheKey)) return privateKeyCache.get(cacheKey);
  if (!bank.certificate_base64) throw new Error('У банка не задан certificate_base64');

  const tmpFile = path.join(os.tmpdir(), `wc-card-${crypto.randomUUID()}.p12`);
  fs.writeFileSync(tmpFile, Buffer.from(bank.certificate_base64, 'base64'));
  try {
    const output = execFileSync(
      'openssl',
      ['pkcs12', '-in', tmpFile, '-nocerts', '-nodes', '-passin', 'stdin'],
      { input: bank.certificate_password || '', encoding: 'utf8' },
    );
    const match = output.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/);
    if (!match) throw new Error('Не удалось извлечь приватный ключ из сертификата');
    privateKeyCache.set(cacheKey, match[0]);
    return match[0];
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

function signRequestBody(rawBody, privateKeyPem) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(rawBody, 'utf8');
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}

async function chargeCardToken(bank, requestBody) {
  if (!bank?.card_init_url) {
    throw new Error(`У банка "${bank?.name || bank?.id}" не задан card_init_url (нужен для определения хоста)`);
  }
  const origin = new URL(bank.card_init_url).origin;
  return postCardRequest(bank, `${origin}/ecom/payment/charge`, requestBody);
}

function postCardRequest(bank, fullUrl, requestBody) {
  if (!fullUrl) throw new Error('Не задан URL карточного шлюза');
  if (!bank.certificate_base64) throw new Error('У банка не задан certificate_base64');

  const url = new URL(fullUrl);
  const payload = JSON.stringify(requestBody || {});
  const pfx = Buffer.from(bank.certificate_base64, 'base64');
  const signature = signRequestBody(payload, extractPrivateKeyPem(bank));
  const requestId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      pfx,
      passphrase: bank.certificate_password,
      rejectUnauthorized: bank.tls_reject_unauthorized === false ? false : true,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Accept: 'application/json',
        'X-Request-Id': requestId,
        Signature: signature,
      },
      timeout: Number(process.env.CARD_GATEWAY_TIMEOUT_MS || 30000),
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = rawBody ? JSON.parse(rawBody) : {}; } catch { parsed = { rawBody }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`Card gateway error: ${res.statusCode}`);
          error.statusCode = res.statusCode;
          error.responseBody = parsed;
          return reject(error);
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Card gateway timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { chargeCardToken };
