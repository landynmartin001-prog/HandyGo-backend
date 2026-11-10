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
    const { data, error } = await supabase.from("jobs").select("*").or(`customer_id.eq.${req.user.id},handyman_id.eq.${req.user.id}`).order("created_at", { ascending: false });
    if (error) return next(error);
    res.json({ jobs: data || [] });
  } catch (err) { next(err); }
});

app.post("/jobs", auth, async (req, res, next) => {
  try {
    const { title, description, service_id, latitude, longitude, address, scheduled_start } = req.body || {};
    if (!title || !description) return res.status(400).json({ error: "title and description are required" });
    const { data, error } = await supabase.from("jobs").insert({
      customer_id: req.user.id, title, description, service_id,
      latitude, longitude, address, scheduled_start, status: "open"
    }).select("*").single();
    if (error) return next(error);
    res.status(201).json({ job: data });
  } catch (err) { next(err); }
});

app.get("/jobs/:id", auth, async (req, res, next) => {
  try {
    const { data, error } = await supabase.from("jobs").select("*").eq("id", req.params.id).single();
    if (error) return next(error);
    if (data.customer_id !== req.user.id && data.handyman_id !== req.user.id) return res.status(403).json({ error: "Forbidden" });
    res.json({ job: data });
  } catch (err) { next(err); }
});

app.get("/jobs/:id/quotes", auth, async (req, res, next) => {
  try {
    const { data: job, error: jobError } = await supabase.from("jobs").select("*").eq("id", req.params.id).single();
    if (jobError) return next(jobError);
    const { data, error } = await supabase.from("quotes").select("*").eq("job_id", req.params.id).order("created_at");
    if (error) return next(error);
    if (job.customer_id !== req.user.id && job.handyman_id !== req.user.id) return res.status(403).json({ error: "Forbidden" });
    res.json({ quotes: data || [] });
  } catch (err) { next(err); }
});

app.post("/jobs/:id/quotes", auth, async (req, res, next) => {
  try {
    const { amount, message, estimated_duration_minutes } = req.body || {};
    if (amount == null) return res.status(400).json({ error: "amount is required" });
    const { data, error } = await supabase.from("quotes").insert({
      job_id: req.params.id, handyman_id: req.user.id, amount, message, estimated_duration_minutes, status: "pending"
    }).select("*").single();
    if (error) return next(error);
    res.status(201).json({ quote: data });
  } catch (err) { next(err); }
});

app.post("/quotes/:id/accept", auth, async (req, res, next) => {
  try {
    const { data: quote, error: qErr } = await supabase.from("quotes").select("*").eq("id", req.params.id).single();
    if (qErr) return next(qErr);
    const { data: job, error: jErr } = await supabase.from("jobs").select("*").eq("id", quote.job_id).single();
    if (jErr) return next(jErr);
    if (job.customer_id !== req.user.id) return res.status(403).json({ error: "Only the customer can accept a quote" });
    const { data, error } = await supabase.from("jobs").update({
      handyman_id: quote.handyman_id, accepted_quote_id: quote.id, status: "accepted"
    }).eq("id", job.id).select("*").single();
    if (error) return next(error);
    await supabase.from("quotes").update({ status: "rejected" }).eq("job_id", job.id).neq("id", quote.id);
    await supabase.from("quotes").update({ status: "accepted" }).eq("id", quote.id);
    res.json({ job: data });
  } catch (err) { next(err); }
});

app.post("/payments/create-intent", auth, async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: "Stripe is not configured" });
    const { amount, currency = "usd", job_id, connected_account_id, platform_fee_amount } = req.body || {};
    if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: "amount must be a positive integer in minor currency units" });
    const params = {
      amount, currency, automatic_payment_methods: { enabled: true },
      metadata: { job_id: job_id || "", customer_id: req.user.id }
    };
    if (connected_account_id) {
      params.transfer_data = { destination: connected_account_id };
      if (Number.isInteger(platform_fee_amount) && platform_fee_amount >= 0) params.application_fee_amount = platform_fee_amount;
    }
    const intent = await stripe.paymentIntents.create(params);
    res.json({ payment_intent_id: intent.id, client_secret: intent.client_secret });
  } catch (err) { next(err); }
});

app.post("/connect/onboarding", auth, async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: "Stripe is not configured" });
    const { connected_account_id, refresh_url, return_url } = req.body || {};
    if (!connected_account_id || !refresh_url || !return_url) return res.status(400).json({ error: "connected_account_id, refresh_url and return_url are required" });
    const link = await stripe.accountLinks.create({
      account: connected_account_id, type: "account_onboarding", refresh_url, return_url
    });
    res.json({ url: link.url });
  } catch (err) { next(err); }
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
