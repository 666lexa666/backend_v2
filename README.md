# WHITECAPITAL backend V2

Dedicated backend for the new WHITECAPITAL infrastructure.

This repository is intentionally separate from the current production backend.

## Database boundary

The server connects only through:

- `WC_V2_SUPABASE_URL`
- `WC_V2_SUPABASE_SERVICE_ROLE_KEY`

There is no fallback to production Supabase variables.

## Implemented

- admin authentication/session foundation;
- global terminal catalogue;
- archive/restore for global terminals;
- partner terminal assignments and archive/restore;
- archived terminals are completely hidden from partner-facing API;
- global min/max cheque limits; empty bound means unlimited;
- partner assignment cheque limits constrained by global terminal limits;
- expenses CRUD/categories/private attachments;
- payout preview from the previous recorded payout;
- actual partner payout recording/history;
- partial payout carry-forward;
- payouts disabled on Saturday and Sunday.

## Run

```bash
npm install
npm start
```

Default port: `3100`.


## Render deployment

The repository includes a `render.yaml` Blueprint with two independent services:

- `whitecapital-backend-v2` - public Express API.
- `whitecapital-webhook-worker-v2` - durable partner webhook outbox worker.

Required secrets/config on both services:

```env
WC_V2_SUPABASE_URL=https://tftauggijrgtrhqwliks.supabase.co
WC_V2_SUPABASE_SERVICE_ROLE_KEY=...
```

Web service also requires:

```env
WC_V2_ALLOWED_ORIGINS=https://<frontend-preview>,https://whitecapital.tech,https://www.whitecapital.tech
PUBLIC_API_URL=https://<backend-v2-host>
```

Only the new WHITECAPITAL Supabase project is used. Never point these variables at the legacy Supabase project.
