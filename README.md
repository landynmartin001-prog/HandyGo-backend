# HandyGo Backend

Production-oriented API for HandyGo.

## Required production environment variables

- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- STRIPE_SECRET_KEY
- STRIPE_WEBHOOK_SECRET
- STRIPE_PAYMENTS_ENABLED (must remain unset/false in production; test flow requires true and a Stripe test-mode key)
- CORS_ORIGIN
- PORT (Render supplies this automatically; 10000 is the local default)

## Endpoints

- GET /health
- GET /me
- GET /services
- GET /jobs
- GET /jobs/:id
- POST /jobs
- GET /jobs/:id/quotes
- POST /jobs/:id/quotes
- POST /quotes/:id/accept
- POST /payments/create-intent (test mode only; customer-owned booked jobs with an accepted quote)
- POST /jobs/:id/complete (customer and provider must each confirm; transfer is attempted only after both confirmations)
- POST /connect/onboarding
- POST /webhooks/stripe
- POST /notifications/register-token
- POST /reports

The Stripe webhook route uses the raw request body and Stripe signature verification.


## Delayed provider transfers

HandyGo uses separate charges and transfers. Customer payments are created on the platform account without destination transfer parameters. The provider share is transferred only after both the customer and provider confirm job completion, and only after Stripe Accounts v2 reports the recipient `stripe_transfers` capability as active.

The current implementation is deliberately test-gated:
- `STRIPE_PAYMENTS_ENABLED=true` is required.
- `STRIPE_SECRET_KEY` must be a Stripe test-mode key (`sk_test_` or `rk_test_`).
- A live-mode key is rejected by the feature gate, even if the flag is accidentally enabled.
- Connect account creation/onboarding remains disabled.
- Do not set the flag on a production service.

The additive SQL migration is in `supabase/migrations/202611100001_delayed_provider_transfers.sql`. It has **not** been applied to the production database. Apply and validate it only in an isolated development/test database first.

The 12% platform fee is currently calculated from the accepted USD quote. This is not a profitability guarantee; Stripe processing fees and other operating costs must be modeled separately.

## Validation

Run `npm run check` to syntax-check the backend and verify key delayed-transfer safety invariants.
