-- Engelbart admin authentication and metered LiteLLM accounts.
--
-- The bootstrap admin passcode is represented only by its salted scrypt
-- digest. Application code reads these private tables with the service-role
-- key; neither anon nor authenticated clients receive table privileges.

create table if not exists public.engelbart_admin_config (
  singleton boolean primary key default true check (singleton),
  password_hash text not null,
  session_generation integer not null default 1 check (session_generation > 0),
  totp_secret_ciphertext text,
  totp_secret_iv text,
  totp_secret_tag text,
  totp_pending_until timestamptz,
  totp_enabled boolean not null default false,
  recovery_code_hashes text[] not null default '{}'::text[],
  updated_at timestamptz not null default now(),
  constraint engelbart_admin_totp_cipher_triplet check (
    (totp_secret_ciphertext is null and totp_secret_iv is null and totp_secret_tag is null)
    or
    (totp_secret_ciphertext is not null and totp_secret_iv is not null and totp_secret_tag is not null)
  )
);

alter table public.engelbart_admin_config
  add column if not exists recovery_code_hashes text[] not null default '{}'::text[];

insert into public.engelbart_admin_config (singleton, password_hash)
values (
  true,
  'scrypt$16384$8$1$nP7Ia32S6xXFU3Una1brUw$BNTzQAqRjMfTaZh6Uph1rWCR0lOxxwS1DMdX0GnaBDs'
)
on conflict (singleton) do nothing;

create table if not exists public.engelbart_credit_settings (
  singleton boolean primary key default true check (singleton),
  pool_budget_usd numeric(12, 2) not null default 1000 check (pool_budget_usd > 0),
  default_budget_usd numeric(12, 2) not null default 25 check (default_budget_usd > 0),
  default_models text[] not null default array['claude-sonnet-4-6', 'claude-haiku-4-5']::text[],
  default_rpm_limit integer default 60 check (default_rpm_limit is null or default_rpm_limit > 0),
  default_tpm_limit integer default 1000000 check (default_tpm_limit is null or default_tpm_limit > 0),
  updated_at timestamptz not null default now(),
  constraint engelbart_credit_default_within_pool
    check (default_budget_usd <= pool_budget_usd),
  constraint engelbart_credit_models_nonempty
    check (cardinality(default_models) > 0)
);

insert into public.engelbart_credit_settings (singleton)
values (true)
on conflict (singleton) do nothing;

update public.engelbart_credit_settings
set default_rpm_limit = coalesce(default_rpm_limit, 60),
    default_tpm_limit = coalesce(default_tpm_limit, 1000000)
where singleton = true;

create table if not exists public.engelbart_credit_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  litellm_user_id text not null unique,
  key_ciphertext text,
  key_iv text,
  key_tag text,
  budget_usd numeric(12, 2) not null check (budget_usd > 0),
  models text[] not null,
  rpm_limit integer check (rpm_limit is null or rpm_limit > 0),
  tpm_limit integer check (tpm_limit is null or tpm_limit > 0),
  spend_usd numeric(12, 6) not null default 0 check (spend_usd >= 0),
  blocked boolean not null default false,
  status text not null default 'provisioning'
    check (status in ('provisioning', 'ready', 'error')),
  provision_nonce uuid not null default gen_random_uuid(),
  error_message text,
  provisioned_at timestamptz,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint engelbart_credit_key_triplet check (
    (key_ciphertext is null and key_iv is null and key_tag is null)
    or
    (key_ciphertext is not null and key_iv is not null and key_tag is not null)
  ),
  constraint engelbart_credit_models_nonempty check (cardinality(models) > 0),
  constraint engelbart_credit_ready_has_key check (
    status <> 'ready' or key_ciphertext is not null
  )
);

create index if not exists engelbart_credit_accounts_status_idx
  on public.engelbart_credit_accounts (status, updated_at);

-- Serialize first-time account claims against the singleton settings row so
-- concurrent signups cannot allocate more than the configured pool. Existing
-- accounts remain retrievable even when the pool is exactly full.
create or replace function public.engelbart_claim_credit_account(
  p_user_id uuid,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.engelbart_credit_settings%rowtype;
  v_account public.engelbart_credit_accounts%rowtype;
  v_allocated numeric(12, 2);
begin
  select *
  into v_settings
  from public.engelbart_credit_settings
  where singleton = true
  for update;

  if not found then
    raise exception 'Engelbart credit settings are not initialized';
  end if;

  select *
  into v_account
  from public.engelbart_credit_accounts
  where user_id = p_user_id;

  if found then
    return jsonb_build_object('account', to_jsonb(v_account), 'claimed', false);
  end if;

  select coalesce(sum(budget_usd), 0)
  into v_allocated
  from public.engelbart_credit_accounts
  where status <> 'error';

  if v_allocated + v_settings.default_budget_usd > v_settings.pool_budget_usd then
    raise exception 'Engelbart credit pool is fully allocated';
  end if;

  insert into public.engelbart_credit_accounts (
    user_id,
    email,
    litellm_user_id,
    budget_usd,
    models,
    rpm_limit,
    tpm_limit,
    status
  ) values (
    p_user_id,
    lower(trim(p_email)),
    p_user_id::text,
    v_settings.default_budget_usd,
    v_settings.default_models,
    v_settings.default_rpm_limit,
    v_settings.default_tpm_limit,
    'provisioning'
  )
  returning * into v_account;

  return jsonb_build_object('account', to_jsonb(v_account), 'claimed', true);
end;
$$;

-- Recovery codes are random high-entropy values hashed by the control plane.
-- Consume one while holding the singleton row lock so concurrent requests can
-- never redeem the same code twice. Redemption also revokes older sessions.
create or replace function public.engelbart_consume_admin_recovery_code(
  p_code_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_config public.engelbart_admin_config%rowtype;
begin
  select *
  into v_config
  from public.engelbart_admin_config
  where singleton = true
  for update;

  if v_config.singleton is null
     or not (p_code_hash = any(v_config.recovery_code_hashes)) then
    return jsonb_build_object('consumed', false);
  end if;

  update public.engelbart_admin_config
  set recovery_code_hashes = array_remove(recovery_code_hashes, p_code_hash),
      session_generation = session_generation + 1,
      updated_at = now()
  where singleton = true
  returning * into v_config;

  return jsonb_build_object(
    'consumed', true,
    'session_generation', v_config.session_generation,
    'remaining', cardinality(v_config.recovery_code_hashes)
  );
end;
$$;

create or replace function public.engelbart_update_credit_settings(
  p_pool_budget_usd numeric,
  p_default_budget_usd numeric,
  p_default_models text[],
  p_default_rpm_limit integer,
  p_default_tpm_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.engelbart_credit_settings%rowtype;
  v_allocated numeric(12, 2);
begin
  select *
  into v_settings
  from public.engelbart_credit_settings
  where singleton = true
  for update;

  if not found then
    raise exception 'Engelbart credit settings are not initialized';
  end if;

  select coalesce(sum(budget_usd), 0)
  into v_allocated
  from public.engelbart_credit_accounts
  where status <> 'error';

  if p_pool_budget_usd < v_allocated then
    raise exception 'Engelbart pool cannot be lower than the allocated budget';
  end if;

  update public.engelbart_credit_settings
  set pool_budget_usd = p_pool_budget_usd,
      default_budget_usd = p_default_budget_usd,
      default_models = p_default_models,
      default_rpm_limit = p_default_rpm_limit,
      default_tpm_limit = p_default_tpm_limit,
      updated_at = now()
  where singleton = true
  returning * into v_settings;

  return to_jsonb(v_settings);
end;
$$;

create or replace function public.engelbart_update_account_policy(
  p_user_id uuid,
  p_budget_usd numeric,
  p_models text[],
  p_rpm_limit integer,
  p_tpm_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.engelbart_credit_settings%rowtype;
  v_account public.engelbart_credit_accounts%rowtype;
  v_allocated numeric(12, 2);
begin
  select *
  into v_settings
  from public.engelbart_credit_settings
  where singleton = true
  for update;

  select *
  into v_account
  from public.engelbart_credit_accounts
  where user_id = p_user_id
  for update;

  if not found or v_account.status <> 'ready' then
    raise exception 'Engelbart credit account is not ready';
  end if;

  select coalesce(sum(budget_usd), 0)
  into v_allocated
  from public.engelbart_credit_accounts
  where status <> 'error'
    and user_id <> p_user_id;

  if v_allocated + p_budget_usd > v_settings.pool_budget_usd then
    raise exception 'Engelbart credit pool is fully allocated';
  end if;

  update public.engelbart_credit_accounts
  set budget_usd = p_budget_usd,
      models = p_models,
      rpm_limit = p_rpm_limit,
      tpm_limit = p_tpm_limit,
      updated_at = now()
  where user_id = p_user_id
  returning * into v_account;

  return to_jsonb(v_account);
end;
$$;

alter table public.engelbart_admin_config enable row level security;
alter table public.engelbart_credit_settings enable row level security;
alter table public.engelbart_credit_accounts enable row level security;

revoke all on public.engelbart_admin_config from public, anon, authenticated;
revoke all on public.engelbart_credit_settings from public, anon, authenticated;
revoke all on public.engelbart_credit_accounts from public, anon, authenticated;
revoke all on function public.engelbart_claim_credit_account(uuid, text)
  from public, anon, authenticated;
grant execute on function public.engelbart_claim_credit_account(uuid, text)
  to service_role;
revoke all on function public.engelbart_update_credit_settings(
  numeric, numeric, text[], integer, integer
) from public, anon, authenticated;
grant execute on function public.engelbart_update_credit_settings(
  numeric, numeric, text[], integer, integer
) to service_role;
revoke all on function public.engelbart_update_account_policy(
  uuid, numeric, text[], integer, integer
)
  from public, anon, authenticated;
grant execute on function public.engelbart_update_account_policy(
  uuid, numeric, text[], integer, integer
)
  to service_role;
revoke all on function public.engelbart_consume_admin_recovery_code(text)
  from public, anon, authenticated;
grant execute on function public.engelbart_consume_admin_recovery_code(text)
  to service_role;

-- Invite creation now crosses the authenticated Vercel control plane. The
-- redemption RPC remains public because prospective members are anonymous.
revoke execute on function public.engelbart_generate_invite() from public, anon, authenticated;
grant execute on function public.engelbart_generate_invite() to service_role;

comment on table public.engelbart_admin_config is
  'Private admin password/MFA configuration; service-role access only.';
comment on table public.engelbart_credit_accounts is
  'One encrypted LiteLLM virtual key and budget policy per Supabase member.';
