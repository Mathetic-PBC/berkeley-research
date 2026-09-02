-- The invite gate returns to account creation. 20260828150000 opened signup
-- and moved the code to the credit claim; the onboarding that follows
-- signup now spends the member's key on its first screen, so an account
-- without an invite is an account that cannot do anything. The credit
-- claim keeps consuming the bound invite; 'open' stays a legal source for
-- the rows that already exist.

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
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'A valid Engelbart invite is required to create an account.'));
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
  select approval.invite_id into approved_invite
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
  set used_by = new.id, used_at = now()
  where id = approved_invite;
  delete from public.engelbart_signup_approvals where invite_id = approved_invite;
  return new;
end;
$$;
