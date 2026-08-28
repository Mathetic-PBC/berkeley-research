-- Open account creation: anyone signs up with just email + password, and the
-- invite code moves to the authorization step. engelbart_claim_credit_account
-- already refuses to mint a key for a member without a bound invite unless a
-- valid, unused code is consumed in the same transaction, so credits (and the
-- pairing flow's credit setup) stay invite-gated even though accounts are not.

alter table public.engelbart_members
  drop constraint engelbart_members_source_check;
alter table public.engelbart_members
  add constraint engelbart_members_source_check
  check (source in ('invite', 'legacy', 'open'));

-- The Before User Created hook stays registered in the dashboard, so the
-- function must keep existing; it just stops refusing anyone.
create or replace function public.engelbart_before_user_created(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return '{}'::jsonb;
end;
$$;

-- A signup that did redeem an invite beforehand still binds it, so the old
-- reserve-then-signup path keeps working. Everyone else becomes an 'open'
-- member with no invite, which is exactly the state the credit claim treats
-- as "must present a code now".
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
    insert into public.engelbart_members (user_id, source)
    values (new.id, 'open');
    return new;
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
