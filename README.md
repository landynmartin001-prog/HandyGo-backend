# HandyGo Backend

Production-oriented API for HandyGo.

## Required production environment variables

- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- STRIPE_SECRET_KEY
- STRIPE_WEBHOOK_SECRET
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
- POST /payments/create-intent
- POST /connect/onboarding
- POST /webhooks/stripe
- POST /notifications/register-token
- POST /reports

The Stripe webhook route uses the raw request body and Stripe signature verification.
