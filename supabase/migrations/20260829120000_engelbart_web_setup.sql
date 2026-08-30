-- Engelbart web-first onboarding.
--
-- A member who sets their first project up on the website leaves two things
-- behind for the installer to collect: the approved setup payload, and a
-- short-lived setup code the CLI redeems for a machine token without a second
-- browser trip. The code is browser-issued and single-secret -- the member is
-- already in the browser, so there is no terminal to hold a device code --
-- which is why it is longer than an approval code, expires in minutes, is
-- spent in the same transaction that mints the token, and rechecks membership
-- at redemption. Only base64url SHA-256 digests of codes are stored, the same
-- way device codes already are.

create table if not exists public.engelbart_pending_setups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'claimed')),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  constraint engelbart_pending_setup_claim_pair check (
    (status = 'claimed') = (claimed_at is not null)
  )
);

-- One live setup per account: a second save replaces the first, and the
-- claim-ordering questions of a queue have no user story yet.
create unique index if not exists engelbart_pending_setups_one_live_idx
  on public.engelbart_pending_setups (user_id) where status = 'pending';

create table if not exists public.engelbart_setup_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  code_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz
);

create index if not exists engelbart_setup_codes_expiry_idx
  on public.engelbart_setup_codes (expires_at);

alter table public.engelbart_pending_setups enable row level security;
alter table public.engelbart_setup_codes enable row level security;

revoke all on public.engelbart_pending_setups from anon, authenticated;
revoke all on public.engelbart_setup_codes from anon, authenticated;

-- Every step runs through the Vercel functions with the service role: the
-- browser writes with its Supabase JWT via the API, and the CLI reads with
-- its machine token via the API. Neither reaches these tables directly.
create or replace function public.engelbart_save_pending_setup(
  p_user_id uuid,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  created uuid;
begin
  -- Opportunistic GC, the way session start already GCs pairing sessions:
  -- a claimed or abandoned setup is not worth keeping for a month.
  delete from public.engelbart_pending_setups
  where created_at <= now() - interval '30 days';

  delete from public.engelbart_pending_setups
  where user_id = p_user_id and status = 'pending';

  insert into public.engelbart_pending_setups (user_id, payload)
  values (p_user_id, p_payload)
  returning id into created;

  return created;
end;
$$;

-- The claim is a single transition, like a pairing session's: the payload is
-- handed out exactly once, so an install that got it is the install that owns
-- materializing it.
create or replace function public.engelbart_claim_pending_setup(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.engelbart_pending_setups%rowtype;
begin
  select * into target
  from public.engelbart_pending_setups
  where user_id = p_user_id and status = 'pending'
  for update;

  if not found then
    return jsonb_build_object('found', false);
  end if;

  update public.engelbart_pending_setups
  set status = 'claimed', claimed_at = now()
  where id = target.id;

  return jsonb_build_object('found', true, 'payload', target.payload);
end;
$$;

create or replace function public.engelbart_issue_setup_code(
  p_user_id uuid,
  p_code_hash text,
  p_ttl_seconds integer
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  ends timestamptz;
begin
  delete from public.engelbart_setup_codes
  where expires_at <= now() - interval '1 hour';

  -- One live code per account: asking again invalidates the code on screen,
  -- which is what "get a new code" should mean.
  delete from public.engelbart_setup_codes
  where user_id = p_user_id and claimed_at is null;

  ends := now() + make_interval(
    secs => greatest(60, least(3600, coalesce(p_ttl_seconds, 900))));

  insert into public.engelbart_setup_codes (user_id, code_hash, expires_at)
  values (p_user_id, p_code_hash, ends);

  return ends;
end;
$$;

-- Redemption and the token issue are the same transaction, exactly as the
-- device-flow claim is: a replayed code reads as used rather than handing out
-- a second credential. Membership is rechecked here because the code may have
-- been issued before the member was removed.
create or replace function public.engelbart_redeem_setup_code(
  p_code_hash text,
  p_token_hash text,
  p_label text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.engelbart_setup_codes%rowtype;
  member_email text;
begin
  select * into target
  from public.engelbart_setup_codes
  where code_hash = p_code_hash
  for update;

  if not found or target.expires_at <= now() then
    return jsonb_build_object('status', 'invalid');
  end if;

  if target.claimed_at is not null then
    return jsonb_build_object('status', 'used');
  end if;

  select lower(account.email) into member_email
  from auth.users account
  join public.engelbart_members member on member.user_id = account.id
  where account.id = target.user_id;

  if member_email is null then
    return jsonb_build_object('status', 'denied');
  end if;

  insert into public.engelbart_cli_tokens (user_id, token_hash, label)
  values (
    target.user_id,
    p_token_hash,
    nullif(left(coalesce(p_label, ''), 100), '')
  );

  update public.engelbart_setup_codes
  set claimed_at = now()
  where id = target.id;

  return jsonb_build_object(
    'status', 'ready',
    'email', member_email,
    'user_id', target.user_id
  );
end;
$$;

revoke execute on function public.engelbart_save_pending_setup(uuid, jsonb)
  from anon, authenticated;
revoke execute on function public.engelbart_claim_pending_setup(uuid)
  from anon, authenticated;
revoke execute on function public.engelbart_issue_setup_code(uuid, text, integer)
  from anon, authenticated;
revoke execute on function public.engelbart_redeem_setup_code(text, text, text)
  from anon, authenticated;
