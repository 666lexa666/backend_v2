const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const { scopePayoutSummaryToProject }=require('../lib/payoutService');

test('payout SQL settles from account-currency snapshots',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','db','2026-09-24-payout-currency-preview.sql'),'utf8');
  assert.ok(source.includes('sum(p.amount_currency_minor)'));
  assert.ok(source.includes('sum(p.commission_currency_minor)'));
  assert.ok(source.includes('sum(rr.amount_currency_minor)'));
  assert.ok(source.includes("'successNet',pf.gross-pf.comm"));
  assert.ok(source.includes("'refundDeduction',pf.refund"));
  assert.ok(source.includes("'refundCount',pf.refund_count"));
});

test('project payout scoping exposes exactly the frontend financial shape',()=>{
  const summary={
    currency:'EUR',
    isPayoutDay:true,
    commissionPercent:1.5,
    successAmount:10000,
    successCommission:150,
    successNet:9850,
    refundAmount:0,
    refundCount:0,
    refundDeduction:0,
    payoutAmount:9850,
    projects:[
      {
        projectId:'11111111-1111-4111-8111-111111111111',
        projectName:'Main',
        currency:'EUR',
        commissionPercent:1.5,
        openingOutstanding:250,
        successAmount:5000,
        successCount:2,
        successCommission:75,
        successNet:4925,
        refundAmount:1000,
        refundCount:1,
        refundDeduction:1000,
        accruedAmount:3925,
        payoutAmount:4175,
      },
    ],
  };

  const scoped=scopePayoutSummaryToProject(summary,'11111111-1111-4111-8111-111111111111');
  assert.equal(scoped.currency,'EUR');
  assert.equal(scoped.successAmount,5000);
  assert.equal(scoped.successCount,2);
  assert.equal(scoped.successCommission,75);
  assert.equal(scoped.successNet,4925);
  assert.equal(scoped.refundAmount,1000);
  assert.equal(scoped.refundCount,1);
  assert.equal(scoped.refundDeduction,1000);
  assert.equal(scoped.openingOutstanding,250);
  assert.equal(scoped.payoutAmount,4175);
  assert.equal(scoped.projects.length,1);
});

test('missing project scopes to deterministic zero values instead of partner totals',()=>{
  const scoped=scopePayoutSummaryToProject({
    currency:'RUB',
    isPayoutDay:true,
    commissionPercent:0.5,
    successAmount:999999,
    payoutAmount:999999,
    projects:[],
  },'22222222-2222-4222-8222-222222222222');

  assert.equal(scoped.successAmount,0);
  assert.equal(scoped.successCommission,0);
  assert.equal(scoped.refundAmount,0);
  assert.equal(scoped.payoutAmount,0);
  assert.equal(scoped.canExecute,false);
});
