const { processPartnerWebhookBatch } = require('../lib/partnerWebhookOutbox');

const pollIntervalMs = Number(process.env.PARTNER_WEBHOOK_POLL_INTERVAL_MS || 2000);
const batchSize = Number(process.env.PARTNER_WEBHOOK_BATCH_SIZE || 50);
const leaseSeconds = Number(process.env.PARTNER_WEBHOOK_LEASE_SECONDS || 120);
const workerId = process.env.PARTNER_WEBHOOK_WORKER_ID || `partner-webhook-${process.pid}`;
let stopping = false;

async function tick() {
  try {
    const results = await processPartnerWebhookBatch({
      workerId,
      limit: batchSize,
      leaseSeconds,
    });
    if (results.length) {
      console.log('[partner-webhook-worker]', {
        claimed: results.length,
        delivered: results.filter((x) => x.delivered).length,
        failed: results.filter((x) => !x.delivered).length,
      });
    }
  } catch (error) {
    console.error('[partner-webhook-worker:error]', error);
  }
}

async function loop() {
  while (!stopping) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

loop();
