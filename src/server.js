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
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2 })
  : null;

const CONNECT_RETURN_URL = process.env.CONNECT_RETURN_URL || "";
const CONNECT_REFRESH_URL = process.env.CONNECT_REFRESH_URL || "";
const CONNECT_PLATFORM_FEE_PERCENT = 0.12;

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

function requireStripe(res) {
  if (!stripe) {
    res.status(503).json({ error: "Stripe is not configured" });
    return false;
  }
  return true;
}

function stripeTransferCapabilityActive(account) {
  return account?.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status === "active";
}

function amountToMinorUnits(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return null;
  const minor = Math.round(value * 100);
  return minor > 0 ? minor : null;
}

async function getHandymanProfile(userId) {
  const { data, error } = await supabase.from("handyman_profiles")
    .select("user_id,business_name,country_code,stripe_connected_account_id,stripe_onboarding_complete")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
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
  try {
    if (!requireStripe(res)) return;

    const { job_id, quote_id } = req.body || {};
    if (!job_id || !quote_id) {
      return res.status(400).json({ error: "job_id and quote_id are required" });
    }

    const [{ data: job, error: jobError }, { data: quote, error: quoteError }] = await Promise.all([
      supabase.from("jobs").select("id,customer_id,status,currency_code").eq("id", job_id).maybeSingle(),
      supabase.from("quotes").select("id,job_id,handyman_id,amount,currency_code,status").eq("id", quote_id).maybeSingle()
    ]);
    if (jobError) return next(jobError);
    if (quoteError) return next(quoteError);
    if (!job || !quote) return res.status(404).json({ error: "Job or quote not found" });
    if (job.customer_id !== req.user.id) return res.status(403).json({ error: "Only the customer can pay for this job" });
    if (quote.job_id !== job.id || quote.status !== "accepted" || job.status !== "booked") {
      return res.status(409).json({ error: "The accepted quote is not payable" });
    }

    const amount = amountToMinorUnits(quote.amount);
    if (!amount) return res.status(400).json({ error: "Invalid quote amount" });

    const profile = await getHandymanProfile(quote.handyman_id);
    if (!profile?.stripe_connected_account_id) {
      return res.status(409).json({ error: "The handyman has not completed Stripe onboarding" });
    }

    const connectedAccount = await stripe.v2.core.accounts.retrieve(profile.stripe_connected_account_id, {
      include: ["configuration.recipient"]
    });
    if (!stripeTransferCapabilityActive(connectedAccount)) {
      return res.status(409).json({ error: "The handyman is not yet eligible to receive transfers" });
    }

    const { data: existingPayment, error: existingPaymentError } = await supabase.from("payments")
      .select("id,stripe_payment_intent_id,status,amount,currency_code")
      .eq("job_id", job.id)
      .in("status", ["pending", "authorized", "succeeded"])
      .maybeSingle();
    if (existingPaymentError) return next(existingPaymentError);
    if (existingPayment?.stripe_payment_intent_id) {
      const existingIntent = await stripe.paymentIntents.retrieve(existingPayment.stripe_payment_intent_id);
      return res.json({
        payment: existingPayment,
        payment_intent: existingIntent,
        publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || null
      });
    }

    // The Stripe Platform Pricing Tool is the source of truth for the platform fee.
    // Do not set application_fee_amount here: Stripe applies the configured pricing
    // scheme and processing-cost protection to destination charges.
    const intent = await stripe.paymentIntents.create({
      amount,
      currency: (quote.currency_code || job.currency_code || "USD").toLowerCase(),
      transfer_data: { destination: profile.stripe_connected_account_id },
      metadata: {
        handygo_job_id: job.id,
        handygo_quote_id: quote.id,
        handygo_customer_id: req.user.id,
        handygo_handyman_id: quote.handyman_id,
        handygo_platform_fee_percent: String(CONNECT_PLATFORM_FEE_PERCENT)
      },
      description: "HandyGo job " + job.id
    });

    const { data: payment, error: paymentError } = await supabase.from("payments").insert({
      job_id: job.id,
      customer_id: req.user.id,
      handyman_id: quote.handyman_id,
      stripe_payment_intent_id: intent.id,
      amount: Number(quote.amount),
      currency_code: (quote.currency_code || job.currency_code || "USD").toUpperCase(),
      platform_fee: 0,
      provider_amount: Number(quote.amount),
      status: "pending"
    }).select("*").single();
    if (paymentError) {
      try { await stripe.paymentIntents.cancel(intent.id); } catch (_) {}
      return next(paymentError);
    }

    res.status(201).json({
      payment,
      payment_intent: intent,
      publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || null
    });
  } catch (err) {
    next(err);
  }
});

app.post("/connect/onboarding", auth, async (req, res, next) => {
  try {
    if (!requireStripe(res)) return;
    if (!CONNECT_RETURN_URL || !CONNECT_REFRESH_URL) {
      return res.status(503).json({ error: "Connect onboarding URLs are not configured" });
    }

    const profile = await getHandymanProfile(req.user.id);
    if (!profile) return res.status(403).json({ error: "A handyman profile is required for Stripe onboarding" });

    let accountId = profile.stripe_connected_account_id;
    if (!accountId) {
      const account = await stripe.v2.core.accounts.create({
        contact_email: req.user.email || undefined,
        display_name: profile.business_name || req.user.email || "HandyGo Handyman",
        dashboard: "express",
        identity: {
          country: (profile.country_code || "US").toLowerCase(),
          entity_type: (req.body?.entity_type === "company" ? "company" : "individual")
        },
        configuration: {
          recipient: {
            capabilities: {
              stripe_balance: { stripe_transfers: { requested: true } }
            }
          }
        },
        defaults: {
          currency: "usd",
          responsibilities: {
            fees_collector: "application",
            losses_collector: "application"
          }
        }
      });
      accountId = account.id;

      const { error: saveError } = await supabase.from("handyman_profiles")
        .update({ stripe_connected_account_id: accountId, stripe_onboarding_complete: false })
        .eq("user_id", req.user.id);
      if (saveError) return next(saveError);
    }

    const accountLink = await stripe.v2.core.accountLinks.create({
      account: accountId,
      use_case: {
        type: "account_onboarding",
        account_onboarding: {
          configurations: ["recipient"],
          refresh_url: CONNECT_REFRESH_URL,
          return_url: CONNECT_RETURN_URL
        }
      }
    });

    res.json({ account_id: accountId, onboarding_url: accountLink.url });
  } catch (err) {
    next(err);
  }
});

app.get("/connect/status", auth, async (req, res, next) => {
  try {
    if (!requireStripe(res)) return;
    const profile = await getHandymanProfile(req.user.id);
    if (!profile?.stripe_connected_account_id) {
      return res.json({ connected: false, transfers_active: false, onboarding_complete: false });
    }

    const account = await stripe.v2.core.accounts.retrieve(profile.stripe_connected_account_id, {
      include: ["configuration.recipient", "requirements"]
    });
    const transfersActive = stripeTransferCapabilityActive(account);
    const onboardingComplete = transfersActive && (account.requirements?.currently_due?.length || 0) === 0;

    if (onboardingComplete !== Boolean(profile.stripe_onboarding_complete)) {
      await supabase.from("handyman_profiles")
        .update({ stripe_onboarding_complete: onboardingComplete })
        .eq("user_id", req.user.id);
    }

    res.json({
      connected: true,
      account_id: profile.stripe_connected_account_id,
      transfers_active: transfersActive,
      onboarding_complete: onboardingComplete,
      currently_due: account.requirements?.currently_due || []
    });
  } catch (err) {
    next(err);
  }
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

app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send("Stripe webhook not configured");
  const signature = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object;
      if (intent.id) {
        const paymentUpdate = { status: "succeeded", stripe_payment_intent_id: intent.id };
        if (intent.latest_charge) paymentUpdate.stripe_charge_id = intent.latest_charge;
        await supabase.from("payments").update(paymentUpdate).eq("stripe_payment_intent_id", intent.id);
      }
    } else if (event.type === "payment_intent.payment_failed") {
      const intent = event.data.object;
      if (intent.id) {
        await supabase.from("payments").update({ status: "failed", stripe_payment_intent_id: intent.id }).eq("stripe_payment_intent_id", intent.id);
      }
    } else if (event.type === "payment_intent.canceled") {
      const intent = event.data.object;
      if (intent.id) {
        await supabase.from("payments").update({ status: "cancelled", stripe_payment_intent_id: intent.id }).eq("stripe_payment_intent_id", intent.id);
      }
    } else if (event.type === "charge.refunded") {
      const charge = event.data.object;
      if (charge.payment_intent) {
        await supabase.from("payments").update({
          status: charge.amount_refunded >= charge.amount ? "refunded" : "partially_refunded",
          stripe_charge_id: charge.id
        }).eq("stripe_payment_intent_id", charge.payment_intent);
      }
    } else if (event.type === "charge.dispute.created") {
      const dispute = event.data.object;
      if (dispute.payment_intent) {
        await supabase.from("payments").update({ status: "disputed" }).eq("stripe_payment_intent_id", dispute.payment_intent);
      }
    } else if (event.type === "account.updated") {
      const account = event.data.object;
      const transfersActive = stripeTransferCapabilityActive(account);
      if (account.id) {
        await supabase.from("handyman_profiles")
          .update({ stripe_onboarding_complete: transfersActive })
          .eq("stripe_connected_account_id", account.id);
      }
    }
    res.json({ received: true });
  } catch (err) {
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
