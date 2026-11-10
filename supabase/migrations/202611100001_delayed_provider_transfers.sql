-- HandyGo delayed provider transfers: additive, reviewable migration.
-- Apply only to a non-production database after review and test coverage.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS customer_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS handyman_completed_at timestamptz;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS stripe_transfer_id text,
  ADD COLUMN IF NOT EXISTS transfer_group text,
  ADD COLUMN IF NOT EXISTS transfer_status text NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS refunded_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS disputed_amount numeric(12,2) NOT NULL DEFAULT 0;

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_transfer_status_check;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_transfer_status_check
  CHECK (transfer_status IN ('not_started','pending','transferred','partially_reversed','reversed','failed'));

CREATE UNIQUE INDEX IF NOT EXISTS payments_stripe_transfer_id_unique
  ON public.payments (stripe_transfer_id)
  WHERE stripe_transfer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payments_one_active_payment_per_job
  ON public.payments (job_id)
  WHERE job_id IS NOT NULL
    AND status IN ('pending','authorized','succeeded','partially_refunded','disputed');

CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  processing_status text NOT NULL DEFAULT 'processing'
    CHECK (processing_status IN ('processing','processed','failed')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stripe_webhook_events FROM anon, authenticated;
GRANT ALL ON TABLE public.stripe_webhook_events TO service_role;

CREATE OR REPLACE FUNCTION public.confirm_job_completion(p_job_id uuid, p_actor_id uuid)
RETURNS public.jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job public.jobs;
  v_handyman_id uuid;
BEGIN
  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT q.handyman_id INTO v_handyman_id
  FROM public.quotes q
  WHERE q.job_id = p_job_id AND q.status = 'accepted'
  ORDER BY q.created_at DESC
  LIMIT 1;

  IF v_handyman_id IS NULL THEN
    RAISE EXCEPTION 'Accepted provider not found' USING ERRCODE = 'P0001';
  END IF;

  IF p_actor_id <> v_job.customer_id AND p_actor_id <> v_handyman_id THEN
    RAISE EXCEPTION 'Actor is not a job participant' USING ERRCODE = '42501';
  END IF;

  IF v_job.status NOT IN ('booked','in_progress','completed') THEN
    RAISE EXCEPTION 'Job is not eligible for completion confirmation' USING ERRCODE = 'P0001';
  END IF;

  IF p_actor_id = v_job.customer_id THEN
    UPDATE public.jobs
    SET customer_completed_at = COALESCE(customer_completed_at, now()),
        updated_at = now()
    WHERE id = p_job_id;
  ELSE
    UPDATE public.jobs
    SET handyman_completed_at = COALESCE(handyman_completed_at, now()),
        updated_at = now()
    WHERE id = p_job_id;
  END IF;

  UPDATE public.jobs
  SET status = 'completed', updated_at = now()
  WHERE id = p_job_id
    AND customer_completed_at IS NOT NULL
    AND handyman_completed_at IS NOT NULL;

  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id;
  RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_job_completion(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_job_completion(uuid, uuid) TO service_role;
