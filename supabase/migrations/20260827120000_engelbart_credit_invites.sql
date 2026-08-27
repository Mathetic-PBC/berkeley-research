-- Require a redeemed Engelbart invite before allocating a new LiteLLM key.
--
-- Accounts created through the invite-only signup flow already own an invite.
-- Legacy accounts can claim one here. Existing credit accounts are returned
-- before the entitlement check so this migration does not revoke live keys.

create or replace function public.engelbart_claim_credit_account(
  p_user_id uuid,
  p_email text,
  p_invite_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.engelbart_credit_settings%rowtype;
  v_account public.engelbart_credit_accounts%rowtype;
  v_member public.engelbart_members%rowtype;
  v_invite public.engelbart_invites%rowtype;
  v_normalized_code text;
  v_normalized_email text;
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

  -- A previously provisioned key remains retrievable. Requiring a fresh code
  -- here would strand existing users without revoking the LiteLLM key itself.
  select *
  into v_account
  from public.engelbart_credit_accounts
  where user_id = p_user_id;

  if found then
    return jsonb_build_object('account', to_jsonb(v_account), 'claimed', false);
  end if;

  select *
  into v_member
  from public.engelbart_members
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'This account is not an Engelbart member';
  end if;

  -- Invite-only signups already bind their consumed invite to the member.
  -- Legacy members must atomically consume an unused code before allocation.
  if v_member.invite_id is null then
    v_normalized_code := upper(regexp_replace(
      coalesce(p_invite_code, ''), '[^A-Z0-9]', '', 'g'));
    v_normalized_email := lower(trim(coalesce(p_email, '')));

    if v_normalized_code !~ '^EGB[A-F0-9]{20}$' then
      raise exception 'A valid Engelbart invite is required for Claude credits';
    end if;

    select *
    into v_invite
    from public.engelbart_invites
    where code_hash = extensions.digest(v_normalized_code, 'sha256')
    for update;

    if not found
       or v_invite.used_at is not null
       or v_invite.expires_at <= now()
       or (
         v_invite.reserved_email is not null
         and v_invite.reserved_email <> v_normalized_email
         and v_invite.reserved_at > now() - interval '30 minutes'
       ) then
      raise exception 'A valid Engelbart invite is required for Claude credits';
    end if;

    update public.engelbart_invites
    set reserved_email = v_normalized_email,
        reserved_at = now(),
        used_by = p_user_id,
        used_at = now()
    where id = v_invite.id;

    update public.engelbart_members
    set invite_id = v_invite.id,
        source = 'invite'
    where user_id = p_user_id;

    delete from public.engelbart_signup_approvals
    where invite_id = v_invite.id
       or email = v_normalized_email
       or expires_at <= now();
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

-- Keep the two-argument contract during rollout. Applying the migration before
-- deploying the page immediately closes the old no-code provisioning path,
-- while already-invited members and existing keys continue to work.
create or replace function public.engelbart_claim_credit_account(
  p_user_id uuid,
  p_email text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.engelbart_claim_credit_account(p_user_id, p_email, null);
$$;

revoke all on function public.engelbart_claim_credit_account(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.engelbart_claim_credit_account(uuid, text, text)
  to service_role;
revoke all on function public.engelbart_claim_credit_account(uuid, text)
  from public, anon, authenticated;
grant execute on function public.engelbart_claim_credit_account(uuid, text)
  to service_role;

comment on function public.engelbart_claim_credit_account(uuid, text, text) is
  'Atomically redeems credit entitlement and allocates one LiteLLM account.';
