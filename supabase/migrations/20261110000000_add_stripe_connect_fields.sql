alter table public.handyman_profiles
  add column if not exists stripe_connected_account_id text;

alter table public.handyman_profiles
  add column if not exists stripe_onboarding_complete boolean not null default false;

create unique index if not exists handyman_profiles_stripe_connected_account_id_key
  on public.handyman_profiles (stripe_connected_account_id)
  where stripe_connected_account_id is not null;
