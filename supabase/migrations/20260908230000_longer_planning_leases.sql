-- Apply before deploying longer planning requests. No onboarding rows are rewritten.
-- Claims outlive the 300-second hosting ceiling so callers cannot duplicate live work.
create or replace function public.engelbart_grounding_transition(
 p_user uuid,p_id uuid,p_paper uuid,p_token uuid,p_run boolean default false,
 p_retry boolean default false,p_save jsonb default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare ob public.engelbart_onboardings; job jsonb; stale boolean; legacy jsonb;
begin
 select * into ob from public.engelbart_onboardings where id=p_id and user_id=p_user for update;
 if not found or ob.paper_id is distinct from p_paper then return jsonb_build_object('status','superseded'); end if;
 if public.engelbart_valid_grounding(ob.analysis->'grounding') then
   return jsonb_build_object('status','done','grounding',ob.analysis->'grounding','job',ob.planning->'paper_grounding');
 end if;
 if ob.status<>'open' then return jsonb_build_object('status','superseded'); end if;
 -- Old resumable jobs may have extracted evidence before reaching review.
 -- Promote that same-paper evidence instead of doing the PDF read again.
 select value->'input'->'paper'->'grounding' into legacy from jsonb_each(ob.planning)
   where key in ('direction','subgoals','todos')
     and value->'context'->>'paper_id'=ob.paper_id::text
     and public.engelbart_valid_grounding(value->'input'->'paper'->'grounding') limit 1;
 if legacy is not null then
   job := jsonb_build_object('status','done','finished_at',now(),'source','legacy-plan');
   update public.engelbart_onboardings set analysis=jsonb_set(analysis,'{grounding}',legacy),
     planning=jsonb_set(planning,'{paper_grounding}',job),updated_at=now() where id=p_id;
   return jsonb_build_object('status','done','grounding',legacy,'job',job);
 end if;
 job := ob.planning->'paper_grounding';
 if job->>'status'='done' then job := null; end if; -- Invalid/missing evidence is never ready.
 if p_save is not null then
   if job->>'token' is distinct from p_token::text then return jsonb_build_object('status','superseded'); end if;
   if p_save->>'status' not in ('done','error') then raise exception 'Invalid grounding status'; end if;
   if p_save->>'status'='done' and not public.engelbart_valid_grounding(p_save->'grounding') then raise exception 'Invalid grounding'; end if;
   job := (p_save-'grounding') || jsonb_build_object('started_at',job->'started_at','finished_at',now());
   update public.engelbart_onboardings set
     analysis=case when p_save->>'status'='done' then jsonb_set(analysis,'{grounding}',p_save->'grounding') else analysis end,
     planning=jsonb_set(planning,'{paper_grounding}',job),updated_at=now() where id=p_id;
   return jsonb_build_object('status',job->>'status','job',job,'grounding',p_save->'grounding','error',job->'error');
 end if;
 stale := job->>'status'='running' and coalesce((job->>'lease_until')::timestamptz,'epoch')<=now();
 if job->>'status'='running' and not stale then return jsonb_build_object('status','running','job',job); end if;
 if job->>'status'='error' and not p_retry then return jsonb_build_object('status','error','job',job,'error',job->'error'); end if;
 if not p_run then return jsonb_build_object('status',case when stale then 'none' else coalesce(job->>'status','none') end,'stale',stale,'job',job); end if;
 if ob.paper_id is null or ob.analysis is null then return jsonb_build_object('status','none'); end if;
 -- Beyond Vercel's 120-second hard limit: recovery cannot overlap a live invocation.
 job := jsonb_build_object('status','running','started_at',now(),'lease_until',now()+interval '310 seconds','token',p_token,'error',null);
 update public.engelbart_onboardings set planning=jsonb_set(planning,'{paper_grounding}',job),updated_at=now() where id=p_id;
 return jsonb_build_object('status','claimed','job',job,'stale',stale);
end $$;
revoke all on function public.engelbart_grounding_transition(uuid,uuid,uuid,uuid,boolean,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.engelbart_grounding_transition(uuid,uuid,uuid,uuid,boolean,boolean,jsonb) to service_role;

-- Planning context equality ignores ONLY the independently arriving evidence.
-- All other Analysis fields and user/resource context retain exact comparison.
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
  if jsonb_typeof(p_context->'analysis')='object' then
    p_context := jsonb_set(p_context,'{analysis}',(p_context->'analysis')-'grounding');
  end if;
  -- Exact equality, except for separately persisted paper grounding.
  for item in select key,value from jsonb_each(p_context) loop
    if (case when item.key='analysis' then ob.analysis-'grounding' else to_jsonb(ob)->item.key end) is distinct from item.value then
      return jsonb_build_object('status','superseded');
    end if;
  end loop;
  job := ob.planning->p_kind;
  if jsonb_typeof(job->'context'->'analysis')='object' then
    job := jsonb_set(job,'{context,analysis}',(job->'context'->'analysis')-'grounding');
  end if;
  if p_save is not null then
    if job->>'token' is distinct from p_token::text or job->'context' is distinct from p_context then
      return jsonb_build_object('status','superseded');
    end if;
    job := (p_save - 'token' - 'lease_until') || jsonb_build_object('context',p_context);
    for item in select key,value from jsonb_each(p_updates) loop
      if p_context ? item.key then
        job := jsonb_set(job,array['context',item.key],case when item.key='analysis' then item.value-'grounding' else item.value end);
      end if;
    end loop;
    -- Fixed allowlist of planning outputs; never arbitrary columns from JSON.
    update public.engelbart_onboardings set
      planning=jsonb_set(planning,array[p_kind],job),
      analysis=case when p_updates ? 'analysis' then (p_updates->'analysis') || case when public.engelbart_valid_grounding(analysis->'grounding') then jsonb_build_object('grounding',analysis->'grounding') else '{}'::jsonb end else analysis end,
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
  job := job || jsonb_build_object('status','running','token',p_token,'lease_until',now()+interval '310 seconds','error',null);
  update public.engelbart_onboardings set planning=jsonb_set(planning,array[p_kind],job) where id=p_id;
  return jsonb_build_object('status','claimed','job',job);
end $$;
revoke all on function public.engelbart_plan_transition(uuid,uuid,text,jsonb,jsonb,uuid,jsonb,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.engelbart_plan_transition(uuid,uuid,text,jsonb,jsonb,uuid,jsonb,jsonb,boolean) to service_role;
