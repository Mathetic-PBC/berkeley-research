-- Engelbart CLI device authorization.
--
-- The installer never asks for a password. It starts a pairing session, opens
-- the browser the member already signs in to, and exchanges its device code
-- for a CLI-scoped token once that member approves the displayed user code.
--
-- Two secrets exist per pairing. The device code is held only by the CLI and
-- is never displayed; the user code is short enough to read aloud and is the
-- only half that reaches the browser. Both are stored as base64url SHA-256
-- digests, computed in the Vercel function, the same way admin recovery codes
-- already are.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.engelbart_cli_sessions (
  id uuid primary key default gen_random_uuid(),
  device_code_hash text not null unique,
  user_code text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'claimed')),
  user_id uuid references auth.users (id) on delete cascade,
  email text,
  client_label text,
  poll_count integer not null default 0 check (poll_count >= 0),
  last_polled_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  approved_at timestamptz,
  claimed_at timestamptz,
  -- A session that names a member has been approved by that member; one that
  -- does not can never be claimed.
  constraint engelbart_cli_session_approval_pair check (
    (status in ('pending', 'denied') and user_id is null and approved_at is null)
    or (status in ('approved', 'claimed') and user_id is not null and approved_at is not null)
  ),
  constraint engelbart_cli_session_claim_pair check (
    (status = 'claimed') = (claimed_at is not null)
  )
);

create index if not exists engelbart_cli_sessions_expiry_idx
  on public.engelbart_cli_sessions (expires_at);

create table if not exists public.engelbart_cli_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  session_id uuid references public.engelbart_cli_sessions (id) on delete set null,
  token_hash text not null unique,
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists engelbart_cli_tokens_user_idx
  on public.engelbart_cli_tokens (user_id, revoked_at);

alter table public.engelbart_cli_sessions enable row level security;
alter table public.engelbart_cli_tokens enable row level security;

revoke all on public.engelbart_cli_sessions from anon, authenticated;
revoke all on public.engelbart_cli_tokens from anon, authenticated;

-- Every pairing step runs through the Vercel functions with the service role,
-- so no browser or CLI reaches these directly.
create or replace function public.engelbart_start_cli_session(
  p_device_code_hash text,
  p_user_code text,
  p_client_label text,
  p_ttl_seconds integer
)
returns public.engelbart_cli_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  created public.engelbart_cli_sessions%rowtype;
begin
  delete from public.engelbart_cli_sessions
  where expires_at <= now() - interval '1 hour';

  insert into public.engelbart_cli_sessions
    (device_code_hash, user_code, client_label, expires_at)
  values (
    p_device_code_hash,
    upper(p_user_code),
    nullif(left(coalesce(p_client_label, ''), 100), ''),
    now() + make_interval(secs => greatest(60, least(1800, coalesce(p_ttl_seconds, 600))))
  )
  returning * into created;

  return created;
end;
$$;

-- Approval binds the pairing to the member who is signed in to the browser.
-- It is a single transition out of 'pending', so a code that is approved,
-- rejected, or replayed cannot be resolved a second time.
create or replace function public.engelbart_resolve_cli_session(
  p_user_code text,
  p_user_id uuid,
  p_email text,
  p_approve boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  compact text;
  normalized text;
  target public.engelbart_cli_sessions%rowtype;
begin
  compact := upper(regexp_replace(coalesce(p_user_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if compact !~ '^[A-Z0-9]{8}$' then
    return jsonb_build_object('resolved', false, 'reason', 'not_found');
  end if;
  normalized := substr(compact, 1, 4) || '-' || substr(compact, 5, 4);

  select * into target
  from public.engelbart_cli_sessions
  where user_code = normalized
  for update;

  if not found or target.expires_at <= now() then
    return jsonb_build_object('resolved', false, 'reason', 'not_found');
  end if;

  if target.status <> 'pending' then
    return jsonb_build_object('resolved', false, 'reason', 'already_resolved');
  end if;

  if p_approve then
    update public.engelbart_cli_sessions
    set status = 'approved',
        user_id = p_user_id,
        email = lower(trim(coalesce(p_email, ''))),
        approved_at = now()
    where id = target.id;
  else
    update public.engelbart_cli_sessions
    set status = 'denied'
    where id = target.id;
  end if;

  return jsonb_build_object(
    'resolved', true,
    'approved', p_approve,
    'label', target.client_label
  );
end;
$$;

-- The poll and the token issue are the same transaction: an approved session
-- mints exactly one token and is immediately spent, so a replayed device code
-- reads as expired rather than handing out a second credential.
create or replace function public.engelbart_claim_cli_session(
  p_device_code_hash text,
  p_token_hash text,
  p_min_interval_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.engelbart_cli_sessions%rowtype;
  previous_poll timestamptz;
begin
  select * into target
  from public.engelbart_cli_sessions
  where device_code_hash = p_device_code_hash
  for update;

  if not found then
    return jsonb_build_object('status', 'expired');
  end if;

  previous_poll := target.last_polled_at;

  update public.engelbart_cli_sessions
  set poll_count = target.poll_count + 1,
      last_polled_at = now()
  where id = target.id;

  if target.expires_at <= now() or target.poll_count >= 600 then
    return jsonb_build_object('status', 'expired');
  end if;

  if previous_poll is not null
     and previous_poll > now() - make_interval(
       secs => greatest(1, coalesce(p_min_interval_seconds, 5)))
  then
    return jsonb_build_object('status', 'slow_down');
  end if;

  if target.status = 'denied' then
    return jsonb_build_object('status', 'denied');
  end if;

  if target.status = 'claimed' then
    return jsonb_build_object('status', 'expired');
  end if;

  if target.status = 'pending' then
    return jsonb_build_object('status', 'pending');
  end if;

  if not exists (
    select 1 from public.engelbart_members member
    where member.user_id = target.user_id
  ) then
    return jsonb_build_object('status', 'denied');
  end if;

  insert into public.engelbart_cli_tokens (user_id, session_id, token_hash, label)
  values (target.user_id, target.id, p_token_hash, target.client_label);

  update public.engelbart_cli_sessions
  set status = 'claimed', claimed_at = now()
  where id = target.id;

  return jsonb_build_object(
    'status', 'ready',
    'email', target.email,
    'user_id', target.user_id
  );
end;
$$;

-- Membership is rechecked on every use, so removing a member closes their
-- installed CLIs without having to find each token.
create or replace function public.engelbart_touch_cli_token(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.engelbart_cli_tokens%rowtype;
  member_email text;
begin
  select * into target
  from public.engelbart_cli_tokens
  where token_hash = p_token_hash
  for update;

  if not found or target.revoked_at is not null then
    return jsonb_build_object('valid', false);
  end if;

  select lower(account.email) into member_email
  from auth.users account
  join public.engelbart_members member on member.user_id = account.id
  where account.id = target.user_id;

  if member_email is null then
    return jsonb_build_object('valid', false);
  end if;

  update public.engelbart_cli_tokens
  set last_used_at = now()
  where id = target.id;

  return jsonb_build_object(
    'valid', true,
    'user_id', target.user_id,
    'email', member_email
  );
end;
$$;

create or replace function public.engelbart_revoke_cli_token(p_token_hash text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  revoked integer;
begin
  update public.engelbart_cli_tokens
  set revoked_at = now()
  where token_hash = p_token_hash and revoked_at is null;
  get diagnostics revoked = row_count;
  return revoked > 0;
end;
$$;

revoke execute on function public.engelbart_start_cli_session(text, text, text, integer)
  from anon, authenticated;
revoke execute on function public.engelbart_resolve_cli_session(text, uuid, text, boolean)
  from anon, authenticated;
revoke execute on function public.engelbart_claim_cli_session(text, text, integer)
  from anon, authenticated;
revoke execute on function public.engelbart_touch_cli_token(text)
  from anon, authenticated;
revoke execute on function public.engelbart_revoke_cli_token(text)
  from anon, authenticated;
