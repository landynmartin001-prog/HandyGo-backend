"use strict";

const PLATFORM_FEE_BPS = 1200;

function moneyToCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid payment amount");
  return Math.round((amount + Number.EPSILON) * 100);
}

function centsToMoney(value) {
  const cents = Number(value);
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("Invalid cent amount");
  return (cents / 100).toFixed(2);
}

function isTestPaymentsEnabled(flag, secretKey) {
  return flag === "true" && typeof secretKey === "string" && /^(sk|rk)_test_/.test(secretKey);
}

function calculatePaymentSplit(grossCents, feeBps = PLATFORM_FEE_BPS) {
  if (!Number.isSafeInteger(grossCents) || grossCents <= 0) throw new Error("Invalid gross amount");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10000) throw new Error("Invalid fee basis points");
  const platformFeeCents = Math.round(grossCents * feeBps / 10000);
  return { grossCents, platformFeeCents, providerCents: grossCents - platformFeeCents };
}

function refundReversalTargetCents(providerTransferCents, refundedGrossCents, chargedGrossCents) {
  if (![providerTransferCents, refundedGrossCents, chargedGrossCents].every(Number.isSafeInteger) ||
      providerTransferCents < 0 || refundedGrossCents < 0 || chargedGrossCents <= 0) {
    throw new Error("Invalid refund reconciliation amounts");
  }
  return Math.min(providerTransferCents,
    Math.round(providerTransferCents * Math.min(refundedGrossCents, chargedGrossCents) / chargedGrossCents));
}

function reversalDeltaCents(transferAmountCents, alreadyReversedCents, targetReversedCents) {
  if (![transferAmountCents, alreadyReversedCents, targetReversedCents].every(Number.isSafeInteger) ||
      transferAmountCents < 0 || alreadyReversedCents < 0 || targetReversedCents < 0) {
    throw new Error("Invalid transfer reversal amounts");
  }
  const target = Math.min(transferAmountCents, targetReversedCents);
  return Math.max(0, target - Math.min(transferAmountCents, alreadyReversedCents));
}

function reconcilePayment(payment, stripeSnapshot) {
  const issues = [];
  if (!payment || !stripeSnapshot) return { status: "manual_review", issues: ["Missing payment or Stripe snapshot"] };
  if (payment.stripe_payment_intent_id !== stripeSnapshot.paymentIntentId) issues.push("payment_intent_mismatch");
  if (Number(payment.amount_cents) !== Number(stripeSnapshot.chargedCents)) issues.push("charged_amount_mismatch");
  if (Number(payment.refunded_amount_cents || 0) !== Number(stripeSnapshot.refundedCents || 0)) issues.push("refund_amount_mismatch");
  if ((payment.stripe_transfer_id || null) !== (stripeSnapshot.transferId || null)) issues.push("transfer_id_mismatch");
  if (Number(payment.transfer_reversed_cents || 0) !== Number(stripeSnapshot.transferReversedCents || 0)) issues.push("transfer_reversal_mismatch");
  return { status: issues.length ? "manual_review" : "matched", issues };
}

module.exports = {
  PLATFORM_FEE_BPS, moneyToCents, centsToMoney, isTestPaymentsEnabled,
  calculatePaymentSplit, refundReversalTargetCents, reversalDeltaCents, reconcilePayment
};
