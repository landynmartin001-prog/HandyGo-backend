"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  moneyToCents, centsToMoney, isTestPaymentsEnabled, calculatePaymentSplit,
  refundReversalTargetCents, reversalDeltaCents, reconcilePayment
} = require("../src/payment-logic");

test("money conversion uses integer cents and rejects invalid input", () => {
  assert.equal(moneyToCents("19.99"), 1999);
  assert.equal(centsToMoney(1999), "19.99");
  assert.throws(() => moneyToCents(0));
  assert.throws(() => moneyToCents("not-money"));
  assert.throws(() => centsToMoney(-1));
});

test("payments require explicit enablement and a test-mode Stripe key", () => {
  assert.equal(isTestPaymentsEnabled("true", "sk_test_example"), true);
  assert.equal(isTestPaymentsEnabled("true", "rk_test_example"), true);
  assert.equal(isTestPaymentsEnabled("false", "sk_test_example"), false);
  assert.equal(isTestPaymentsEnabled("true", "sk_live_example"), false);
  assert.equal(isTestPaymentsEnabled("true", "rk_live_example"), false);
  assert.equal(isTestPaymentsEnabled("true", undefined), false);
});

test("12 percent platform fee split is calculated in cents", () => {
  assert.deepEqual(calculatePaymentSplit(10000), {
    grossCents: 10000, platformFeeCents: 1200, providerCents: 8800
  });
  assert.deepEqual(calculatePaymentSplit(999), {
    grossCents: 999, platformFeeCents: 120, providerCents: 879
  });
  assert.throws(() => calculatePaymentSplit(0));
});

test("partial and full refunds calculate cumulative provider reversal targets", () => {
  assert.equal(refundReversalTargetCents(8800, 2500, 10000), 2200);
  assert.equal(refundReversalTargetCents(8800, 10000, 10000), 8800);
  assert.equal(refundReversalTargetCents(8800, 12000, 10000), 8800);
  assert.equal(refundReversalTargetCents(8800, 0, 10000), 0);
});

test("reversal deltas are idempotent and never exceed the transfer", () => {
  assert.equal(reversalDeltaCents(8800, 0, 2200), 2200);
  assert.equal(reversalDeltaCents(8800, 2200, 2200), 0);
  assert.equal(reversalDeltaCents(8800, 2200, 4400), 2200);
  assert.equal(reversalDeltaCents(8800, 0, 12000), 8800);
});

test("reconciliation flags mismatched Stripe and database state", () => {
  const payment = {
    stripe_payment_intent_id: "pi_123", amount_cents: 10000,
    refunded_amount_cents: 2500, stripe_transfer_id: "tr_123",
    transfer_reversed_cents: 2200
  };
  const matching = {
    paymentIntentId: "pi_123", chargedCents: 10000, refundedCents: 2500,
    transferId: "tr_123", transferReversedCents: 2200
  };
  assert.deepEqual(reconcilePayment(payment, matching), { status: "matched", issues: [] });
  const mismatch = reconcilePayment(payment, { ...matching, refundedCents: 3000 });
  assert.equal(mismatch.status, "manual_review");
  assert.deepEqual(mismatch.issues, ["refund_amount_mismatch"]);
});
