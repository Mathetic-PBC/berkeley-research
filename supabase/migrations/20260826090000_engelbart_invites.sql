-- Engelbart invite-only signup.
-- The admin RPC is intentionally callable by anon while /engelbart/admin is public.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.engelbart_invites (
  id uuid primary key default gen_random_uuid(),
  code_hash bytea not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  reserved_email text,
  reserved_at timestamptz,
  used_by uuid references auth.users (id) on delete set null,
  used_at timestamptz,
  constraint engelbart_invite_reservation_pair check (
    (reserved_email is null and reserved_at is null)
    or (reserved_email is not null and reserved_at is not null)
  ),
  constraint engelbart_invite_use_pair check (used_at is not null or used_by is null)
);

create table if not exists public.engelbart_signup_approvals (
  email text primary key,
  invite_id uuid not null unique references public.engelbart_invites (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists public.engelbart_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  invite_id uuid references public.engelbart_invites (id) on delete set null,
  joined_at timestamptz not null default now(),
  source text not null default 'invite' check (source in ('invite', 'legacy'))
);

alter table public.engelbart_invites enable row level security;
alter table public.engelbart_signup_approvals enable row level security;
alter table public.engelbart_members enable row level security;

revoke all on public.engelbart_invites from anon, authenticated;
revoke all on public.engelbart_signup_approvals from anon, authenticated;
revoke all on public.engelbart_members from anon, authenticated;
grant select on public.engelbart_members to authenticated;

drop policy if exists "members can read their Engelbart membership" on public.engelbart_members;
create policy "members can read their Engelbart membership"
  on public.engelbart_members
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.engelbart_generate_invite()
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  raw_code text;
  normalized_code text;
begin
  raw_code := upper(encode(extensions.gen_random_bytes(10), 'hex'));
  code := 'EGB-' || substr(raw_code, 1, 4)
    || '-' || substr(raw_code, 5, 4)
    || '-' || substr(raw_code, 9, 4)
    || '-' || substr(raw_code, 13, 4)
    || '-' || substr(raw_code, 17, 4);
  normalized_code := upper(regexp_replace(code, '[^A-Z0-9]', '', 'g'));
  expires_at := now() + interval '14 days';

  insert into public.engelbart_invites (code_hash, expires_at)
  values (extensions.digest(normalized_code, 'sha256'), expires_at);

  return next;
end;
$$;

comment on function public.engelbart_generate_invite() is
  'Temporary public-admin RPC. Revoke anon execute before enabling paid credits.';

create or replace function public.engelbart_redeem_invite(invite_code text, signup_email text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_code text;
  normalized_email text;
  matching_invite public.engelbart_invites%rowtype;
begin
  normalized_code := upper(regexp_replace(coalesce(invite_code, ''), '[^A-Z0-9]', '', 'g'));
  normalized_email := lower(trim(coalesce(signup_email, '')));

  if normalized_code !~ '^EGB[A-F0-9]{20}$'
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return false;
  end if;

  select *
  into matching_invite
  from public.engelbart_invites
  where code_hash = extensions.digest(normalized_code, 'sha256')
  for update;

  if not found
     or matching_invite.used_at is not null
     or matching_invite.expires_at <= now() then
    return false;
  end if;

  if matching_invite.reserved_email is not null
     and matching_invite.reserved_email <> normalized_email
     and matching_invite.reserved_at > now() - interval '30 minutes' then
    return false;
  end if;

  delete from public.engelbart_signup_approvals
  where invite_id = matching_invite.id
     or email = normalized_email
     or expires_at <= now();

  insert into public.engelbart_signup_approvals (email, invite_id, expires_at)
  values (normalized_email, matching_invite.id, now() + interval '30 minutes');

  update public.engelbart_invites
  set reserved_email = normalized_email,
      reserved_at = now()
  where id = matching_invite.id;

  return true;
end;
$$;

create or replace function public.engelbart_before_user_created(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  signup_email text;
  approved boolean;
begin
  signup_email := lower(trim(coalesce(event -> 'user' ->> 'email', '')));

  select exists (
    select 1
    from public.engelbart_signup_approvals approval
    join public.engelbart_invites invite on invite.id = approval.invite_id
    where approval.email = signup_email
      and approval.expires_at > now()
      and invite.expires_at > now()
      and invite.used_at is null
      and invite.reserved_email = signup_email
  ) into approved;

  if approved then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'A valid Engelbart invite is required to create an account.'
    )
  );
end;
$$;

create or replace function public.engelbart_finish_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_email text;
  approved_invite uuid;
begin
  normalized_email := lower(trim(coalesce(new.email, '')));

  select approval.invite_id
  into approved_invite
  from public.engelbart_signup_approvals approval
  join public.engelbart_invites invite on invite.id = approval.invite_id
  where approval.email = normalized_email
    and approval.expires_at > now()
    and invite.expires_at > now()
    and invite.used_at is null
    and invite.reserved_email = normalized_email
  for update of approval, invite;

  if approved_invite is null then
    raise exception 'A valid Engelbart invite is required to create an account.';
  end if;

  insert into public.engelbart_members (user_id, invite_id, source)
  values (new.id, approved_invite, 'invite');

  update public.engelbart_invites
  set used_by = new.id,
      used_at = now()
  where id = approved_invite;

  delete from public.engelbart_signup_approvals
  where invite_id = approved_invite;

  return new;
end;
$$;

-- Accounts that predate the invite gate remain valid login accounts.
insert into public.engelbart_members (user_id, source)
select id, 'legacy'
from auth.users
on conflict (user_id) do nothing;

drop trigger if exists engelbart_finish_signup on auth.users;
create trigger engelbart_finish_signup
  after insert on auth.users
  for each row execute function public.engelbart_finish_signup();

revoke execute on function public.engelbart_generate_invite() from public;
revoke execute on function public.engelbart_redeem_invite(text, text) from public;
revoke execute on function public.engelbart_before_user_created(jsonb) from public;
revoke execute on function public.engelbart_finish_signup() from public;

grant execute on function public.engelbart_generate_invite() to anon, authenticated;
grant execute on function public.engelbart_redeem_invite(text, text) to anon, authenticated;
grant execute on function public.engelbart_before_user_created(jsonb) to supabase_auth_admin;

grant usage on schema public to supabase_auth_admin;
