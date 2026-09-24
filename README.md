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
