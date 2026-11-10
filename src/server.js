const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const PLATFORM_FEE_BPS = 1200; // 12% of the accepted quote, in basis points.
const TEST_PAYMENTS_ONLY = process.env.STRIPE_PAYMENTS_ENABLED === "true" &&
  Boolean(process.env.STRIPE_SECRET_KEY && /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY));

function moneyToCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid payment amount");
  return Math.round((amount + Number.EPSILON) * 100);
}

function centsToMoney(value) {
  return (Number(value) / 100).toFixed(2);
}

function paymentFeatureUnavailable(res) {
  return res.status(503).json({
    error: "HandyGo payments are disabled. Only an explicitly enabled Stripe test-mode environment can use this unfinished integration."
  });
}

async function getAcceptedQuote(jobId) {
  const { data, error } = await supabase.from("quotes").select("*")
    .eq("job_id", jobId).eq("status", "accepted").order("created_at", { ascending: false })
    .limit(1).maybeSingle();
  if (error) throw error;
  return data;
}

async function releaseProviderTransfer(jobId) {
  if (!stripe) throw new Error("Stripe is not configured");
  const { data: job, error: jobError } = await supabase.from("jobs").select("*").eq("id", jobId).maybeSingle();
  if (jobError) throw jobError;
  if (!job || job.status !== "completed" ||
      !job.customer_completed_at || !job.handyman_completed_at) {
    return { transferred: false, reason: "Both customer and provider completion confirmations are required" };
  }

  const { data: payment, error: paymentError } = await supabase.from("payments").select("*")
    .eq("job_id", jobId).eq("status", "succeeded").maybeSingle();
  if (paymentError) throw paymentError;
  if (!payment) return { transferred: false, reason: "A successful customer payment is required" };
  if (payment.stripe_transfer_id || payment.transfer_status === "transferred") {
    return { transferred: true, transfer_id: payment.stripe_transfer_id };
  }

  const quote = await getAcceptedQuote(jobId);
  if (!quote || quote.handyman_id !== payment.handyman_id) {
    throw new Error("Accepted quote and payment provider do not match");
  }

  const { data: profile, error: profileError } = await supabase.from("handyman_profiles")
    .select("stripe_connected_account_id").eq("user_id", payment.handyman_id).maybeSingle();
  if (profileError) throw profileError;
  const accountId = profile?.stripe_connected_account_id;
  if (!accountId) return { transferred: false, reason: "Provider has not completed Stripe onboarding" };

  // Accounts v2 capability state is checked immediately before every transfer.
  const account = await stripe.v2.core.accounts.retrieve(accountId);
  const transferCapabilityStatus =
    account?.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status;
  if (transferCapabilityStatus !== "active") {
    return { transferred: false, reason: "Provider transfer capability is not active" };
  }

  let chargeId = payment.stripe_charge_id;
  if (!chargeId && payment.stripe_payment_intent_id) {
    const intent = await stripe.paymentIntents.retrieve(payment.stripe_payment_intent_id);
    chargeId = typeof intent.latest_charge === "string"
      ? intent.latest_charge
      : intent.latest_charge?.id;
  }
  if (!chargeId) return { transferred: false, reason: "The successful charge is not yet available" };

  const transferAmount = moneyToCents(payment.provider_amount);
  if (transferAmount <= 0) throw new Error("Provider transfer amount must be positive");
  const transferGroup = payment.transfer_group || `handygo_job_${jobId}`;

  // Stripe idempotency prevents duplicate transfers if completion requests race or retry.
  const transfer = await stripe.transfers.create({
    amount: transferAmount,
    currency: String(payment.currency_code || "USD").toLowerCase(),
    destination: accountId,
    source_transaction: chargeId,
    transfer_group: transferGroup,
    metadata: { handygo_job_id: jobId, handygo_payment_id: payment.id }
  }, { idempotencyKey: `handygo:job:${jobId}:provider-transfer:v1` });

  const { error: updateError } = await supabase.from("payments").update({
    stripe_transfer_id: transfer.id,
    transfer_group: transferGroup,
    transfer_status: "transferred",
    updated_at: new Date().toISOString()
  }).eq("id", payment.id);
  if (updateError) throw updateError;
  return { transferred: true, transfer_id: transfer.id };
}

async function reverseProviderTransfer(payment, targetReversedCents, idempotencyKey) {
  if (!payment.stripe_transfer_id || !stripe) return;
  const transfer = await stripe.transfers.retrieve(payment.stripe_transfer_id);
  const alreadyReversed = Number(transfer.amount_reversed || 0);
  const target = Math.min(Number(transfer.amount), Math.max(0, targetReversedCents));
  const delta = target - alreadyReversed;
  if (delta <= 0) return;
  await stripe.transfers.createReversal(transfer.id, { amount: delta }, { idempotencyKey });
  const nextStatus = target >= Number(transfer.amount) ? "reversed" : "partially_reversed";
  const { error } = await supabase.from("payments").update({
    transfer_status: nextStatus,
    updated_at: new Date().toISOString()
  }).eq("id", payment.id);
  if (error) throw error;
}

app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map(s => s.trim()) }));
app.use(rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));
// Parse JSON for API routes, but leave Stripe webhook bodies untouched for signature verification.
app.use(express.json({ limit: "2mb", type: req => req.path !== "/webhooks/stripe" && req.is("application/json") }));

function requireConfig() {
  const missing = [];
  for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (!process.env[key]) missing.push(key);
  }
  return missing;
}

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return res.status(401).json({ error: "Missing bearer token" });
    const token = header.slice(7);
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: "Invalid authentication token" });
    req.user = data.user;
    next();
  } catch (err) {
    next(err);
  }
}

app.get("/health", async (_req, res) => {
  const missing = requireConfig();
  res.status(missing.length ? 503 : 200).json({
    ok: missing.length === 0,
    service: "handygo-backend",
    environment: process.env.NODE_ENV || "development",
    configured: { supabase: missing.length === 0, stripe: Boolean(process.env.STRIPE_SECRET_KEY) },
    missing
  });
});

app.get("/me", auth, async (req, res, next) => {
  try {
    const { data, error } = await supabase.from("users").select("*").eq("id", req.user.id).maybeSingle();
    if (error) return next(error);
    res.json({ user: req.user, profile: data });
  } catch (err) { next(err); }
});

app.get("/services", async (_req, res, next) => {
  try {
    const { data, error } = await supabase.from("services").select("*").order("name");
    if (error) return next(error);
    res.json({ services: data || [] });
  } catch (err) { next(err); }
});

app.get("/jobs", auth, async (req, res, next) => {
  try {
    const [{ data: customerJobs, error: customerError }, { data: providerQuotes, error: quoteError }] = await Promise.all([
      supabase.from("jobs").select("*").eq("customer_id", req.user.id),
      supabase.from("quotes").select("job_id").eq("handyman_id", req.user.id)
    ]);
    if (customerError) return next(customerError);
    if (quoteError) return next(quoteError);
    const quotedJobIds = [...new Set((providerQuotes || []).map(q => q.job_id))];
    let providerJobs = [];
    if (quotedJobIds.length) {
      const { data, error } = await supabase.from("jobs").select("*").in("id", quotedJobIds);
      if (error) return next(error);
      providerJobs = data || [];
    }
    const jobs = [...new Map([...(customerJobs || []), ...providerJobs].map(job => [job.id, job])).values()]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ jobs });
  } catch (err) { next(err); }
});

app.post("/jobs", auth, async (req, res, next) => {
  try {
    const { title, description, service_id, address_text, address, scheduled_start, budget_min, budget_max } = req.body || {};
    if (typeof title !== "string" || !title.trim() || typeof description !== "string" || !description.trim()) {
      return res.status(400).json({ error: "title and description are required" });
    }
    const insert = {
      customer_id: req.user.id,
      title: title.trim(),
      description: description.trim(),
      service_id: service_id || null,
      address_text: typeof address_text === "string" ? address_text.trim() : (typeof address === "string" ? address.trim() : null),
      scheduled_start: scheduled_start || null,
      budget_min: budget_min == null ? null : Number(budget_min),
      budget_max: budget_max == null ? null : Number(budget_max),
      status: "open"
    };
    if ((insert.budget_min !== null && (!Number.isFinite(insert.budget_min) || insert.budget_min < 0)) ||
        (insert.budget_max !== null && (!Number.isFinite(insert.budget_max) || insert.budget_max < 0)) ||
        (insert.budget_min !== null && insert.budget_max !== null && insert.budget_min > insert.budget_max)) {
      return res.status(400).json({ error: "Invalid budget range" });
    }
    const { data, error } = await supabase.from("jobs").insert(insert).select("*").single();
    if (error) return next(error);
    res.status(201).json({ job: data });
  } catch (err) { next(err); }
});

app.get("/jobs/:id", auth, async (req, res, next) => {
  try {
    const { data: job, error } = await supabase.from("jobs").select("*").eq("id", req.params.id).maybeSingle();
    if (error) return next(error);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.customer_id !== req.user.id) {
      const { data: quote, error: quoteError } = await supabase.from("quotes").select("id")
        .eq("job_id", job.id).eq("handyman_id", req.user.id).limit(1).maybeSingle();
      if (quoteError) return next(quoteError);
      if (!quote) return res.status(403).json({ error: "Forbidden" });
    }
    res.json({ job });
  } catch (err) { next(err); }
});

app.get("/jobs/:id/quotes", auth, async (req, res, next) => {
  try {
    const { data: job, error: jobError } = await supabase.from("jobs").select("*").eq("id", req.params.id).maybeSingle();
    if (jobError) return next(jobError);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.customer_id !== req.user.id) {
      const { data: ownQuote, error: ownQuoteError } = await supabase.from("quotes").select("id")
        .eq("job_id", job.id).eq("handyman_id", req.user.id).limit(1).maybeSingle();
      if (ownQuoteError) return next(ownQuoteError);
      if (!ownQuote) return res.status(403).json({ error: "Forbidden" });
    }
    const { data, error } = await supabase.from("quotes").select("*").eq("job_id", req.params.id).order("created_at");
    if (error) return next(error);
    res.json({ quotes: data || [] });
  } catch (err) { next(err); }
});

app.post("/jobs/:id/quotes", auth, async (req, res, next) => {
  try {
    const amount = Number((req.body || {}).amount);
    const { message, estimated_duration_minutes } = req.body || {};
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "A positive quote amount is required" });
    if (estimated_duration_minutes != null && (!Number.isInteger(Number(estimated_duration_minutes)) || Number(estimated_duration_minutes) <= 0)) {
      return res.status(400).json({ error: "estimated_duration_minutes must be a positive integer" });
    }
    const { data: job, error: jobError } = await supabase.from("jobs").select("id,status").eq("id", req.params.id).maybeSingle();
    if (jobError) return next(jobError);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (!["open", "quoted"].includes(job.status)) return res.status(409).json({ error: "This job is not accepting quotes" });
    const { data: profile, error: profileError } = await supabase.from("handyman_profiles")
      .select("user_id,verification_status").eq("user_id", req.user.id).maybeSingle();
    if (profileError) return next(profileError);
    if (!profile) return res.status(403).json({ error: "A handyman profile is required to submit a quote" });
    if (profile.verification_status !== "verified") return res.status(403).json({ error: "Handyman verification is required before quoting" });
    const { data, error } = await supabase.from("quotes").insert({
      job_id: req.params.id, handyman_id: req.user.id, amount,
      message: typeof message === "string" ? message : null,
      estimated_duration_minutes: estimated_duration_minutes == null ? null : Number(estimated_duration_minutes),
      status: "pending"
    }).select("*").single();
    if (error) return next(error);
    res.status(201).json({ quote: data });
  } catch (err) { next(err); }
});

app.post("/quotes/:id/accept", auth, async (req, res, next) => {
  try {
    const { data: quote, error: qErr } = await supabase.from("quotes").select("*").eq("id", req.params.id).maybeSingle();
    if (qErr) return next(qErr);
    if (!quote) return res.status(404).json({ error: "Quote not found" });
    const { data: job, error: jErr } = await supabase.from("jobs").select("*").eq("id", quote.job_id).maybeSingle();
    if (jErr) return next(jErr);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.customer_id !== req.user.id) return res.status(403).json({ error: "Only the customer can accept a quote" });
    if (quote.status !== "pending" || !["open", "quoted"].includes(job.status)) {
      return res.status(409).json({ error: "This quote can no longer be accepted" });
    }
    const { data: updatedJob, error: jobUpdateError } = await supabase.from("jobs")
      .update({ status: "booked" }).eq("id", job.id).in("status", ["open", "quoted"]).select("*").maybeSingle();
    if (jobUpdateError) return next(jobUpdateError);
    if (!updatedJob) return res.status(409).json({ error: "The job was changed by another request; refresh and try again" });
    const { error: acceptError } = await supabase.from("quotes").update({ status: "accepted" })
      .eq("id", quote.id).eq("status", "pending");
    if (acceptError) return next(acceptError);
    const { error: declineError } = await supabase.from("quotes").update({ status: "declined" })
      .eq("job_id", job.id).neq("id", quote.id).eq("status", "pending");
    if (declineError) return next(declineError);
    res.json({ job: updatedJob, accepted_quote_id: quote.id, handyman_id: quote.handyman_id });
  } catch (err) { next(err); }
});

app.post("/payments/create-intent", auth, async (req, res, next) => {
  if (!TEST_PAYMENTS_ONLY || !stripe) return paymentFeatureUnavailable(res);
  try {
    const { job_id } = req.body || {};
    if (typeof job_id !== "string" || !job_id) return res.status(400).json({ error: "job_id is required" });

    const { data: job, error: jobError } = await supabase.from("jobs").select("*").eq("id", job_id).maybeSingle();
    if (jobError) return next(jobError);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.customer_id !== req.user.id) return res.status(403).json({ error: "Only the job customer can pay" });
    if (job.status !== "booked") return res.status(409).json({ error: "Only booked jobs can be paid" });

    const quote = await getAcceptedQuote(job_id);
    if (!quote) return res.status(409).json({ error: "An accepted quote is required before payment" });
    if (String(quote.currency_code || job.currency_code || "USD").toUpperCase() !== "USD") {
      return res.status(400).json({ error: "This test implementation currently supports USD payments only" });
    }

    const grossCents = moneyToCents(quote.amount);
    const platformFeeCents = Math.round(grossCents * PLATFORM_FEE_BPS / 10000);
    const providerCents = grossCents - platformFeeCents;
    if (providerCents <= 0) return res.status(400).json({ error: "Quote is too small for the configured platform fee" });

    const { data: existing, error: existingError } = await supabase.from("payments").select("*")
      .eq("job_id", job_id).in("status", ["pending", "authorized", "succeeded", "partially_refunded", "disputed"])
      .maybeSingle();
    if (existingError) return next(existingError);
    if (existing?.stripe_payment_intent_id) {
      const existingIntent = await stripe.paymentIntents.retrieve(existing.stripe_payment_intent_id);
      if (existingIntent.status === "succeeded") {
        return res.status(409).json({ error: "This job has already been paid" });
      }
      return res.json({
        payment_intent_id: existingIntent.id,
        client_secret: existingIntent.client_secret,
        amount: existing.amount,
        currency: existing.currency_code,
        status: existingIntent.status
      });
    }

    const transferGroup = `handygo_job_${job_id}`;
    const idempotencyKey = `handygo:job:${job_id}:payment-intent:v1`;
    const intent = await stripe.paymentIntents.create({
      amount: grossCents,
      currency: "usd",
      automatic_payment_methods: { enabled: true },
      transfer_group: transferGroup,
      metadata: {
        handygo_job_id: job_id,
        handygo_customer_id: req.user.id,
        handygo_provider_id: quote.handyman_id,
        handygo_quote_id: quote.id,
        handygo_platform_fee_cents: String(platformFeeCents),
        handygo_provider_amount_cents: String(providerCents)
      }
    }, { idempotencyKey });

    const { data: payment, error: insertError } = await supabase.from("payments").insert({
      job_id,
      customer_id: req.user.id,
      handyman_id: quote.handyman_id,
      stripe_payment_intent_id: intent.id,
      amount: centsToMoney(grossCents),
      currency_code: "USD",
      platform_fee: centsToMoney(platformFeeCents),
      provider_amount: centsToMoney(providerCents),
      status: "pending",
      transfer_group: transferGroup,
      transfer_status: "pending"
    }).select("id").single();

    if (insertError) {
      // A retry uses the same Stripe idempotency key; never create a second charge.
      return next(insertError);
    }
    res.status(201).json({
      payment_id: payment.id,
      payment_intent_id: intent.id,
      client_secret: intent.client_secret,
      amount: centsToMoney(grossCents),
      currency: "USD",
      platform_fee: centsToMoney(platformFeeCents),
      provider_amount: centsToMoney(providerCents),
      status: intent.status
    });
  } catch (err) { next(err); }
});

app.post("/connect/onboarding", auth, (_req, res) => {
  // Connected-account creation is deliberately disabled until adult-authorized business verification
  // and the Accounts v2 onboarding flow are completed and reviewed.
  res.status(503).json({ error: "Provider onboarding is not enabled. Complete authorized business verification before enabling Connect." });
});

app.post("/notifications/register-token", auth, async (req, res, next) => {
  try {
    const { token, platform } = req.body || {};
    if (!token || !platform) return res.status(400).json({ error: "token and platform are required" });
    const { data, error } = await supabase.from("push_tokens").upsert({
      user_id: req.user.id, token, platform, updated_at: new Date().toISOString()
    }, { onConflict: "token" }).select("*").single();
    if (error) return next(error);
    res.json({ token: data });
  } catch (err) { next(err); }
});

app.post("/reports", auth, async (req, res, next) => {
  try {
    const { job_id, reported_user_id, reason, details } = req.body || {};
    const { data, error } = await supabase.from("reports").insert({
      reporter_id: req.user.id, job_id, reported_user_id, reason, details, status: "open"
    }).select("*").single();
    if (error) return next(error);
    res.status(201).json({ report: data });
  } catch (err) { next(err); }
});

app.post("/jobs/:id/complete", auth, async (req, res, next) => {
  try {
    const { data: payment, error: paymentError } = await supabase.from("payments").select("id,status")
      .eq("job_id", req.params.id).maybeSingle();
    if (paymentError) return next(paymentError);
    if (!payment || payment.status !== "succeeded") {
      return res.status(409).json({ error: "A successful customer payment is required before completion confirmation" });
    }

    const { data: job, error } = await supabase.rpc("confirm_job_completion", {
      p_job_id: req.params.id,
      p_actor_id: req.user.id
    });
    if (error) return next(error);
    if (job.status !== "completed") {
      return res.json({ job, transfer: { transferred: false, reason: "Waiting for the other participant to confirm completion" } });
    }

    if (!TEST_PAYMENTS_ONLY || !stripe) {
      return res.json({ job, transfer: { transferred: false, reason: "Payment transfers are disabled" } });
    }
    const transfer = await releaseProviderTransfer(job.id);
    res.json({ job, transfer });
  } catch (err) { next(err); }
});

app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send("Stripe webhook not configured");
  const signature = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send("Webhook signature verification failed");
  }

  try {
    const { data: priorEvent, error: eventLookupError } = await supabase.from("stripe_webhook_events")
      .select("processing_status").eq("id", event.id).maybeSingle();
    if (eventLookupError) throw eventLookupError;
    if (priorEvent?.processing_status === "processed") return res.json({ received: true, duplicate: true });

    if (!priorEvent) {
      const { error: eventInsertError } = await supabase.from("stripe_webhook_events").insert({
        id: event.id, event_type: event.type, processing_status: "processing"
      });
      if (eventInsertError && eventInsertError.code !== "23505") throw eventInsertError;
    } else {
      const { error: retryError } = await supabase.from("stripe_webhook_events").update({
        processing_status: "processing", last_error: null
      }).eq("id", event.id);
      if (retryError) throw retryError;
    }

    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object;
      const chargeId = typeof intent.latest_charge === "string" ? intent.latest_charge : intent.latest_charge?.id;
      const { error } = await supabase.from("payments").update({
        status: "succeeded",
        stripe_charge_id: chargeId || null,
        stripe_payment_intent_id: intent.id,
        updated_at: new Date().toISOString()
      }).eq("stripe_payment_intent_id", intent.id);
      if (error) throw error;
    } else if (event.type === "payment_intent.payment_failed") {
      const intent = event.data.object;
      const { error } = await supabase.from("payments").update({
        status: "failed", updated_at: new Date().toISOString()
      }).eq("stripe_payment_intent_id", intent.id).eq("status", "pending");
      if (error) throw error;
    } else if (event.type === "charge.refunded") {
      const charge = event.data.object;
      const { data: payment, error } = await supabase.from("payments").select("*")
        .eq("stripe_charge_id", charge.id).maybeSingle();
      if (error) throw error;
      if (payment) {
        const refunded = Number(charge.amount_refunded || 0);
        const charged = Number(charge.amount || 0);
        const targetReversed = charged > 0
          ? Math.round(moneyToCents(payment.provider_amount) * refunded / charged)
          : 0;
        if (payment.stripe_transfer_id && targetReversed > 0) {
          await reverseProviderTransfer(payment, targetReversed, `handygo:refund:${event.id}:transfer-reversal`);
        }
        const { error: updateError } = await supabase.from("payments").update({
          status: charge.refunded ? "refunded" : "partially_refunded",
          refunded_amount: centsToMoney(refunded),
          updated_at: new Date().toISOString()
        }).eq("id", payment.id);
        if (updateError) throw updateError;
      }
    } else if (event.type === "charge.dispute.created") {
      const dispute = event.data.object;
      const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
      const { data: payment, error } = await supabase.from("payments").select("*")
        .eq("stripe_charge_id", chargeId).maybeSingle();
      if (error) throw error;
      if (payment) {
        if (payment.stripe_transfer_id) {
          await reverseProviderTransfer(payment, moneyToCents(payment.provider_amount), `handygo:dispute:${event.id}:transfer-reversal`);
        }
        const { error: updateError } = await supabase.from("payments").update({
          status: "disputed",
          disputed_amount: centsToMoney(Number(dispute.amount || 0)),
          updated_at: new Date().toISOString()
        }).eq("id", payment.id);
        if (updateError) throw updateError;
      }
    }

    const { error: markProcessedError } = await supabase.from("stripe_webhook_events").update({
      processing_status: "processed", processed_at: new Date().toISOString(), last_error: null
    }).eq("id", event.id);
    if (markProcessedError) throw markProcessedError;
    res.json({ received: true });
  } catch (err) {
    try {
      await supabase.from("stripe_webhook_events").update({
        processing_status: "failed", last_error: String(err.message || "processing error").slice(0, 500)
      }).eq("id", event.id);
    } catch (_) {}
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HandyGo backend listening on ${PORT}`);
});
