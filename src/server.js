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

app.post("/payments/create-intent", auth, (_req, res) => {
  // Fail closed until server-verified job pricing and delayed Connect transfers are implemented.
  res.status(503).json({ error: "Payments are temporarily disabled pending completion of the delayed-transfer payment flow." });
});

app.post("/connect/onboarding", auth, (_req, res) => {
  // Do not accept client-supplied connected-account IDs for onboarding.
  res.status(503).json({ error: "Provider onboarding is temporarily disabled pending server-managed Stripe Connect accounts." });
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
        await supabase.from("payments").update({ status: "succeeded", stripe_payment_intent_id: intent.id }).eq("stripe_payment_intent_id", intent.id);
      }
    } else if (event.type === "payment_intent.payment_failed") {
      const intent = event.data.object;
      if (intent.id) {
        await supabase.from("payments").update({ status: "failed", stripe_payment_intent_id: intent.id }).eq("stripe_payment_intent_id", intent.id);
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
