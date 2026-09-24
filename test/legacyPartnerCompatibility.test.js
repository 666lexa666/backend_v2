const test=require('node:test');
const assert=require('node:assert/strict');
const {
  normalizePartnerOrderId,
  resolveQrRedirectUrl,
  isAsciiHttpUrl,
  validateClientPhone,
  normalizeClientPam,
  validateClientPam,
  resolveBankPaymentPurpose,
  chooseLegacyTerminalAssignment,
  validateLegacyQrRequest,
}=require('../lib/legacyPartnerCompatibility');

test('V1 orderId normalization matches production contract',()=>{
  assert.deepEqual(normalizePartnerOrderId(undefined),{value:null,error:null});
  assert.deepEqual(normalizePartnerOrderId('  ORD-42  '),{value:'ORD-42',error:null});
  assert.equal(normalizePartnerOrderId(42).error,'orderId должен быть строкой');
  assert.equal(normalizePartnerOrderId('x'.repeat(129)).error,'orderId не должен быть длиннее 128 символов');
  assert.equal(normalizePartnerOrderId('bad\nvalue').error,'orderId не должен содержать управляющие символы');
});

test('V1 URL and client identity validators retain exact rules',()=>{
  assert.equal(resolveQrRedirectUrl('  https://one.example/x  ','https://fallback.example'),'https://one.example/x');
  assert.equal(resolveQrRedirectUrl('', ' https://fallback.example '),'https://fallback.example');
  assert.equal(isAsciiHttpUrl('https://merchant.example/callback'),true);
  assert.equal(isAsciiHttpUrl('ftp://merchant.example/callback'),false);
  assert.equal(isAsciiHttpUrl('https://пример.рф/callback'),false);
  assert.equal(validateClientPhone(null,{required:true}),'clientPhone обязателен и должен быть в формате 0079999999999');
  assert.equal(validateClientPhone('0079999999999'),null);
  assert.equal(validateClientPhone('+79999999999'),'clientPhone должен быть строго в формате 0079999999999: 13 цифр, префикс 007');
  assert.equal(normalizeClientPam('  payer  '),'payer');
  assert.equal(validateClientPam('',{required:true}),'clientPam обязателен');
  assert.equal(validateClientPam('x'.repeat(141)),'clientPam не должен быть длиннее 140 символов');
});

test('bank purpose override keeps V1 precedence',()=>{
  assert.equal(resolveBankPaymentPurpose({
    originalPurpose:'original',
    paymentId:'payment-uuid',
    clientPhone:'0079999999999',
    useClientPhone:true,
    useTransactionId:true,
  }),'0079999999999;payment-uuid');
  assert.equal(resolveBankPaymentPurpose({
    originalPurpose:'original',
    paymentId:'payment-uuid',
    useTransactionId:true,
  }),'payment-uuid');
  assert.equal(resolveBankPaymentPurpose({
    originalPurpose:'original',
    paymentId:'payment-uuid',
  }),'original');
});

const rows=[
  {partner_terminal_id:'sbp-default',payment_method:'SBP',is_default:true,auto_distribution_enabled:true,effective_min_amount_minor:100,effective_max_amount_minor:10000},
  {partner_terminal_id:'sbp-2',payment_method:'SBP',is_default:false,auto_distribution_enabled:true,effective_min_amount_minor:100,effective_max_amount_minor:10000},
  {partner_terminal_id:'sbp-manual',payment_method:'SBP',is_default:false,auto_distribution_enabled:false,effective_min_amount_minor:100,effective_max_amount_minor:10000},
  {partner_terminal_id:'card-default',payment_method:'CARD',is_default:true,auto_distribution_enabled:true,effective_min_amount_minor:100,effective_max_amount_minor:10000},
];

test('legacy routing uses Default when auto distribution is disabled',()=>{
  const r=chooseLegacyTerminalAssignment({
    rows,
    partner:{terminal_auto_distribution_enabled:false},
    amountMinor:500,
    method:'SBP',
  });
  assert.equal(r.assignment.partner_terminal_id,'sbp-default');
});

test('legacy routing honors ignore_request_terminal_id',()=>{
  const r=chooseLegacyTerminalAssignment({
    rows,
    partner:{ignore_request_terminal_id:true,terminal_auto_distribution_enabled:false},
    terminalId:'sbp-2',
    amountMinor:500,
    method:'SBP',
  });
  assert.equal(r.effectiveTerminalId,null);
  assert.equal(r.assignment.partner_terminal_id,'sbp-default');
});

test('legacy routing detects explicit method mismatch instead of silently falling back',()=>{
  const r=chooseLegacyTerminalAssignment({
    rows,
    partner:{terminal_auto_distribution_enabled:true},
    terminalId:'card-default',
    amountMinor:500,
    method:'SBP',
  });
  assert.equal(r.reason,'method_mismatch');
  assert.equal(r.assignment.partner_terminal_id,'card-default');
});

test('legacy auto distribution excludes manual terminals, filters limits and chooses randomly',()=>{
  const r=chooseLegacyTerminalAssignment({
    rows,
    partner:{terminal_auto_distribution_enabled:true},
    amountMinor:500,
    method:'SBP',
    random:()=>0.999,
  });
  assert.equal(r.assignment.partner_terminal_id,'sbp-2');

  const none=chooseLegacyTerminalAssignment({
    rows:rows.map((x)=>x.payment_method==='SBP'?{...x,effective_min_amount_minor:10000}:x),
    partner:{terminal_auto_distribution_enabled:true},
    amountMinor:500,
    method:'SBP',
    random:()=>0,
  });
  assert.equal(none.reason,'amount_not_routable');
});

test('single automatic terminal is selected before amount validation just like V1',()=>{
  const r=chooseLegacyTerminalAssignment({
    rows:[{
      partner_terminal_id:'only',
      payment_method:'SBP',
      is_default:true,
      auto_distribution_enabled:true,
      effective_min_amount_minor:10000,
      effective_max_amount_minor:20000,
    }],
    partner:{terminal_auto_distribution_enabled:true},
    amountMinor:500,
    method:'SBP',
  });
  assert.equal(r.assignment.partner_terminal_id,'only');

  const checked=validateLegacyQrRequest({
    body:{qrcType:'02',amount:500,paymentPurpose:'test'},
    partner:{qr_exp_dt:5,qr_local_exp_dt:300},
    assignment:r.assignment,
    runtime:{
      providerCode:'mtls_json',
      extEntityId:'ENTITY',
      merchantId:'123',
      account:null,
      accAlias:'alias',
      bankId:1,
      providerConfig:{},
    },
  });
  assert.ok(checked.errors.some((x)=>x.startsWith('Сумма меньше минимально допустимой')));
});

test('V1 QR validation distinguishes missing and invalid qrcType',()=>{
  const common={
    partner:{qr_exp_dt:5,qr_local_exp_dt:300},
    assignment:{effective_min_amount_minor:null,effective_max_amount_minor:null},
    runtime:{providerCode:'mtls_json',extEntityId:'ENTITY',merchantId:'123',accAlias:'alias',bankId:1,providerConfig:{}},
  };
  const missing=validateLegacyQrRequest({...common,body:{amount:100,paymentPurpose:'test'}});
  assert.ok(missing.errors.includes('qrcType обязателен и должен быть 02 или 03'));

  const invalid=validateLegacyQrRequest({...common,body:{qrcType:'99',amount:100,paymentPurpose:'test'}});
  assert.ok(invalid.errors.includes('qrcType должен быть 02 или 03'));
  assert.equal(invalid.errors.includes('qrcType обязателен и должен быть 02 или 03'),false);
});
