const fs = require("node:fs");
const assert = require("node:assert/strict");

const server = fs.readFileSync("src/server.js", "utf8");
const migration = fs.readFileSync(
  "supabase/migrations/202611100001_delayed_provider_transfers.sql",
  "utf8"
);

assert.match(server, /STRIPE_PAYMENTS_ENABLED === "true"/, "payments must require an explicit feature flag");
assert.match(server, /^(sk|rk)_test_/, "payments must reject live Stripe keys");
assert.match(server, /stripe\.v2\.core\.accounts\.retrieve\(accountId,\s*\{\s*include:\s*\["configuration\.recipient"\]/,
  "transfers must retrieve Accounts v2 recipient configuration");
assert.match(server, /stripe_transfers\?\.status/,"transfers must check the v2 recipient transfer capability");
assert.match(server, /handyman_completed_at/,"provider completion confirmation is required");
assert.match(server, /customer_completed_at/,"customer completion confirmation is required");
assert.match(server, /source_transaction:\s*chargeId/,"provider transfer must be associated with the originating charge");
assert.match(server, /handygo:job:\$\{jobId\}:provider-transfer:v1/,"provider transfer must use a stable idempotency key");
assert.match(server, /constructEvent\(req\.body, signature, process\.env\.STRIPE_WEBHOOK_SECRET\)/,
  "webhook signatures must be verified");
assert.doesNotMatch(server, /application_fee_amount|transfer_data\s*:/,
  "separate charges and transfers must not use destination-charge parameters");
assert.match(migration, /CREATE OR REPLACE FUNCTION public\.confirm_job_completion/);
assert.match(migration, /stripe_webhook_events/);
assert.match(migration, /payments_stripe_transfer_id_unique/);

console.log("Payment architecture safety checks passed.");
