const http = require('node:http');
const { processPartnerWebhookBatch } = require('../lib/partnerWebhookOutbox');

const pollIntervalMs = Number(process.env.PARTNER_WEBHOOK_POLL_INTERVAL_MS || 2000);
const batchSize = Number(process.env.PARTNER_WEBHOOK_BATCH_SIZE || 50);
const leaseSeconds = Number(process.env.PARTNER_WEBHOOK_LEASE_SECONDS || 120);
const workerId = process.env.PARTNER_WEBHOOK_WORKER_ID || `partner-webhook-${process.pid}`;
const healthPort = Number(process.env.PORT || 10000);
let stopping = false;
let lastTickAt = null;
let lastSuccessAt = null;
let lastError = null;
let readyLogged = false;

async function tick() {
  lastTickAt = new Date().toISOString();
  try {
    const results = await processPartnerWebhookBatch({
      workerId,
      limit: batchSize,
      leaseSeconds,
    });
    lastSuccessAt = new Date().toISOString();
    lastError = null;
    if (!readyLogged) {
      readyLogged = true;
      console.log('[partner-webhook-worker:ready]', {
        workerId,
        database: 'WHITECAPITAL',
        claimed: results.length,
      });
    }
    if (results.length) {
      console.log('[partner-webhook-worker]', {
        claimed: results.length,
        delivered: results.filter((x) => x.delivered).length,
        failed: results.filter((x) => !x.delivered).length,
      });
    }
  } catch (error) {
    lastError = error?.message || String(error);
    console.error('[partner-webhook-worker:error]', error);
  }
}

const healthServer = http.createServer((req, res) => {
  if (req.url !== '/health') {
    res.statusCode = 404;
    return res.end('not found');
  }

  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    status: lastError ? 'degraded' : 'ok',
    service: 'whitecapital-webhook-worker-v2',
    workerId,
    lastTickAt,
    lastSuccessAt,
    lastError,
  }));
});

healthServer.listen(healthPort, '0.0.0.0', () => {
  console.log(`WHITECAPITAL webhook worker health listening on 0.0.0.0:${healthPort}`);
});

async function loop() {
  while (!stopping) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

function stop() {
  stopping = true;
  healthServer.close();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

loop();
