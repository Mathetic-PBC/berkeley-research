-- Reuse the existing transcript and planning state. Topic answers are deliberately
-- absent from the claim key: they improve later turns, never invalidate the opener.
create or replace function public.engelbart_brainstorm_opening(
  p_user uuid, p_id uuid, p_paper uuid, p_token uuid,
  p_save jsonb default null, p_retry boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare ob public.engelbart_onboardings; job jsonb; turn public.engelbart_onboarding_turns;
begin
  select * into ob from public.engelbart_onboardings where id=p_id and user_id=p_user for update;
  if not found or ob.status <> 'open' or ob.paper_id is distinct from p_paper then
    return jsonb_build_object('status','superseded');
  end if;
  select * into turn from public.engelbart_onboarding_turns
    where onboarding_id=p_id and stage='brainstorm' and role='assistant' order by created_at limit 1;
  if found then return jsonb_build_object('status','done','turn',to_jsonb(turn)); end if;
  job := ob.planning->'brainstorm_initial';
  if p_save is not null then
    if job->>'token' is distinct from p_token::text then return jsonb_build_object('status','superseded'); end if;
    if p_save->>'status' = 'done' then
      insert into public.engelbart_onboarding_turns(onboarding_id,user_id,stage,role,content,card)
        values(p_id,p_user,'brainstorm','assistant',p_save->>'content',p_save->'card') returning * into turn;
    end if;
    job := p_save - 'content' - 'card';
  else
    if job->>'status' = 'error' and not p_retry then return job; end if;
    if job->>'status' = 'running' and (job->>'lease_until')::timestamptz > now() then
      return jsonb_build_object('status','running');
    end if;
    job := jsonb_build_object('status','running','token',p_token,'lease_until',now()+interval '45 seconds');
  end if;
  update public.engelbart_onboardings set planning=jsonb_set(planning,'{brainstorm_initial}',job),updated_at=now() where id=p_id;
  return jsonb_build_object('status',case when p_save is null then 'claimed' else job->>'status' end,
    'turn',case when turn.id is not null then to_jsonb(turn) else null end,'error',job->>'error');
end $$;
revoke all on function public.engelbart_brainstorm_opening(uuid,uuid,uuid,uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.engelbart_brainstorm_opening(uuid,uuid,uuid,uuid,jsonb,boolean) to service_role;

-- A replacement paper must not inherit a conversation (or an in-flight claim).
create or replace function public.engelbart_clear_brainstorm_for_paper()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if old.paper_id is distinct from new.paper_id then
    new.planning := coalesce(new.planning,'{}'::jsonb) - 'brainstorm_initial';
    delete from public.engelbart_onboarding_turns where onboarding_id=new.id and stage='brainstorm';
    delete from public.engelbart_onboarding_calibrations where onboarding_id=new.id;
  end if;
  return new;
end $$;
create trigger engelbart_brainstorm_paper_change before update of paper_id on public.engelbart_onboardings
for each row execute function public.engelbart_clear_brainstorm_for_paper();
