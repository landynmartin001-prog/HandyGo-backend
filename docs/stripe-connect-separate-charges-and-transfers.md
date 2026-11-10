# HandyGo Stripe Connect: delayed provider transfers

## Approved product decision

HandyGo uses **separate charges and transfers**. The customer payment is created on HandyGo's platform Stripe account. The provider's share is transferred to the provider's connected Stripe account only after the job is marked completed and the completion conditions are satisfied.

This supersedes the earlier destination-charges decision.

## Configuration to preserve

- Business model: marketplace; HandyGo owns the customer checkout and payment-support relationship.
- Connected-account dashboard: Express.
- Connected-account fee collection: platform-managed pricing.
- Connected-account negative-balance liability: HandyGo/platform.
- Connected-account model: Accounts v2 recipient configuration with the `stripe_transfers` capability.
- Provider share: calculated from the server-verified accepted quote and fee rules; never accepted from a client-supplied amount.
- Platform fee: 12% is the current product decision, but the net transfer must also account for Stripe processing costs and any applicable taxes/other charges. Do not assume 12% guarantees a positive margin.
- Do not set `application_fee_amount` with separate charges and transfers. Retain the platform fee by transferring only the provider's net share.

## Required payment lifecycle

1. Verify the authenticated customer owns the booked job and the accepted quote is the source of the amount and currency.
2. Create a platform PaymentIntent with no destination/transfer_data. Attach stable metadata and an idempotency key. Do not accept price, fee, recipient, or connected-account identifiers from the client.
3. Persist a payment record that links the job, customer, provider, PaymentIntent, full charged amount, platform fee, provider amount, and lifecycle status.
4. Confirm payment success only from a verified Stripe webhook. A browser/app success screen is not proof of payment.
5. Keep the provider transfer pending while the job is underway.
6. On the server, verify the job's completion state and the required completion confirmation(s). Re-check the provider's Accounts v2 recipient transfer capability is active immediately before transfer.
7. Create one idempotent Transfer to the connected account, associated with the originating charge using `source_transaction` where appropriate and a stable `transfer_group`. Persist the transfer ID and mark the payout lifecycle as transferred only after Stripe confirms it.
8. Make completion and transfer retries safe. Duplicate API requests or webhook deliveries must not create duplicate transfers.
9. On refunds, reverse any related provider transfer as needed before/alongside refund processing. On disputes, handle `charge.dispute.created`, record the dispute, and explicitly attempt recovery of any transfer already made. Alert on reversals that cannot be recovered.
10. Reconcile Stripe charges, refunds, disputes, transfers, transfer reversals, and database state.

## Mandatory webhook coverage

At minimum, design and test handlers for:
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.updated`
- `charge.dispute.closed`
- connected-account capability/account updates needed to keep recipient transfer readiness current

All webhook signatures must be verified against the raw request body. Persist event IDs or otherwise implement idempotent event processing.

## Database work required before enabling these routes

The current production `payments` table has PaymentIntent, charge, amount, currency, platform fee, provider amount, and status fields, but it does not yet have durable transfer/reversal identifiers or an explicit payout lifecycle. Add a reviewed migration for fields such as:
- `stripe_transfer_id` (unique, nullable)
- `transfer_status` (pending, transferred, reversed, failed)
- `transfer_group`
- `refunded_amount`
- `disputed_amount`
- `last_stripe_event_id` or a separate webhook event ledger with a unique Stripe event ID

The migration must preserve RLS and ensure only trusted server-side code can mutate payment and transfer state. Do not grant clients direct write access to payment, transfer, or webhook-ledger fields.

The current `handyman_profiles.stripe_connected_account_id` and `stripe_onboarding_complete` fields are not sufficient proof of current readiness. Do not trust the boolean alone; use Accounts v2 capability state and update it from verified account events.

## Critical business and Stripe constraints

- Separate charges and transfers make HandyGo the merchant of record for the customer payment. HandyGo must own receipts, customer payment support, refunds, disputes, and reconciliation.
- A delayed transfer is not escrow and does not create a legally protected escrow arrangement.
- Stripe's permitted holding period, account-country rules, funds availability, and platform approval must be confirmed for HandyGo's actual Stripe account before launch.
- For this charge pattern, Stripe debits refunds and disputes to the platform. The platform must maintain sufficient available balance and implement transfer reversals; recovery can fail if the connected account has insufficient balance.
- Express connected accounts have reduced payment/dispute visibility for this charge pattern. HandyGo needs operational tooling and support procedures.
- Do not use `application_fee_amount` with this charge pattern.
- Do not enable live charges, connected-account onboarding, or transfers until the platform's authorized adult/business representative has completed Stripe's required business and identity verification and the complete test suite passes.

## Current verified implementation gap

The currently inspected backend deliberately returns HTTP 503 from `POST /payments/create-intent` and `POST /connect/onboarding`. Its Stripe webhook only updates basic PaymentIntent success/failure statuses. It does not yet implement the delayed transfer lifecycle, transfer persistence, refund/dispute recovery, or complete account capability tracking.

The current backend package uses Stripe Node SDK `^18.5.0`; confirm and pin a compatible SDK/API version for Accounts v2 before implementing account creation and capability retrieval. Never substitute legacy `charges_enabled` or `payouts_enabled` checks for the v2 recipient capability check.

## Release gates

- [ ] Confirm the authorized adult/business representative and Stripe platform account eligibility.
- [ ] Confirm Stripe approves the delayed-transfer funds flow and permitted holding period for this account.
- [ ] Add and review the database migration; verify RLS and grants.
- [ ] Implement and test the complete backend lifecycle in a Stripe sandbox.
- [ ] Add a verified webhook endpoint and test duplicate, out-of-order, and failed deliveries.
- [ ] Test completion confirmation, transfer idempotency, refund-before-transfer, refund-after-transfer, dispute-before-transfer, dispute-after-transfer, insufficient connected balance, and platform insufficient balance.
- [ ] Verify the live account only after all sandbox and legal gates pass.
- [ ] Keep production payments disabled until an explicit go-live approval by the authorized adult/business representative.
