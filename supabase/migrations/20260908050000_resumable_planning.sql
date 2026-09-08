-- Server-only, atomic stage claims and completions. No lock is held during model calls.
alter table public.engelbart_onboardings add column if not exists planning jsonb not null default '{}'::jsonb;

create or replace function public.engelbart_plan_transition(
  p_user uuid, p_id uuid, p_kind text, p_context jsonb, p_initial jsonb,
  p_token uuid, p_save jsonb default null, p_updates jsonb default '{}'::jsonb,
  p_retry boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  ob public.engelbart_onboardings;
  job jsonb;
  item record;
begin
  if p_kind not in ('direction','subgoals','todos') then raise exception 'Invalid plan kind'; end if;
  select * into ob from public.engelbart_onboardings where id=p_id and user_id=p_user for update;
  if not found or ob.status <> 'open' then return jsonb_build_object('status','superseded'); end if;
  -- Exact equality per input field, including explicit null; never subset containment.
  for item in select key,value from jsonb_each(p_context) loop
    if (to_jsonb(ob)->item.key) is distinct from item.value then
      return jsonb_build_object('status','superseded');
    end if;
  end loop;
  job := ob.planning->p_kind;
  if p_save is not null then
    if job->>'token' is distinct from p_token::text or job->'context' is distinct from p_context then
      return jsonb_build_object('status','superseded');
    end if;
    job := (p_save - 'token' - 'lease_until') || jsonb_build_object('context',p_context);
    for item in select key,value from jsonb_each(p_updates) loop
      if p_context ? item.key then
        job := jsonb_set(job,array['context',item.key],item.value);
      end if;
    end loop;
    -- Fixed allowlist of planning outputs; never arbitrary columns from JSON.
    update public.engelbart_onboardings set
      planning=jsonb_set(planning,array[p_kind],job),
      analysis=case when p_updates ? 'analysis' then p_updates->'analysis' else analysis end,
      asset_chosen=case when p_updates ? 'asset_chosen' then p_updates->'asset_chosen' else asset_chosen end,
      leveled=case when p_updates ? 'leveled' then p_updates->'leveled' else leveled end,
      direction=case when p_updates ? 'direction' then nullif(p_updates->'direction','null'::jsonb) else direction end,
      subgoals=case when p_updates ? 'subgoals' then nullif(p_updates->'subgoals','null'::jsonb) else subgoals end,
      todos=case when p_updates ? 'todos' then nullif(p_updates->'todos','null'::jsonb) else todos end,
      project_name=case when p_updates ? 'project_name' then p_updates->>'project_name' else project_name end,
      goal_chosen=case when p_updates ? 'goal_chosen' then p_updates->>'goal_chosen' else goal_chosen end,
      step=greatest(step,coalesce((p_updates->>'step')::integer,step)), updated_at=now()
    where id=p_id;
    if job->>'status' = 'complete' and p_kind in ('direction','subgoals') then
      if coalesce(job->'input'->>'feedback','') <> '' then
        insert into public.engelbart_onboarding_turns(onboarding_id,user_id,stage,role,content)
        values(p_id,p_user,p_kind,'user',job->'input'->>'feedback');
      end if;
      insert into public.engelbart_onboarding_turns(onboarding_id,user_id,stage,role,content,card)
      values(p_id,p_user,p_kind,'assistant',
        case when p_kind='direction' then job->'draft'->>'title' else 'Three checked subgoals' end,job->'draft');
    end if;
    return jsonb_build_object('status',job->>'status','job',job);
  end if;
  if job is null or job->'context' is distinct from p_context
      or job->>'fingerprint' is distinct from p_initial->>'fingerprint'
      or (coalesce(p_initial->>'request_id','') <> '' and job->>'request_id' is distinct from p_initial->>'request_id') then
    job := p_initial || jsonb_build_object('context',p_context);
  end if;
  if job->>'status' = 'complete' then return jsonb_build_object('status','complete','job',job); end if;
  if job->>'status' = 'error' and (not p_retry or job->'error'->>'type' = 'rejected') then return jsonb_build_object('status','error','job',job); end if;
  if job->>'status' = 'running' and (job->>'lease_until')::timestamptz > now() then
    return jsonb_build_object('status','running','job',job);
  end if;
  job := job || jsonb_build_object('status','running','token',p_token,'lease_until',now()+interval '115 seconds','error',null);
  update public.engelbart_onboardings set planning=jsonb_set(planning,array[p_kind],job) where id=p_id;
  return jsonb_build_object('status','claimed','job',job);
end $$;
revoke all on function public.engelbart_plan_transition(uuid,uuid,text,jsonb,jsonb,uuid,jsonb,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.engelbart_plan_transition(uuid,uuid,text,jsonb,jsonb,uuid,jsonb,jsonb,boolean) to service_role;
