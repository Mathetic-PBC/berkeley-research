-- Permit an article, a dataset, a PDF, or a combination as project sources.
alter table public.engelbart_onboardings add column if not exists source_article jsonb,
  add column if not exists source_revision bigint not null default 0;

create or replace function public.engelbart_clear_brainstorm_for_paper()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if old.paper_id is distinct from new.paper_id
     or old.source_article is distinct from new.source_article
     or old.dataset_resource is distinct from new.dataset_resource then
    new.source_revision := old.source_revision + 1;
    new.planning := '{}'::jsonb;
    delete from public.engelbart_onboarding_turns where onboarding_id=new.id and stage='brainstorm';
    delete from public.engelbart_onboarding_calibrations where onboarding_id=new.id;
    new.analysis := null; new.analysis_status := 'none'; new.analysis_error := ''; new.analysis_started_at := null;
    new.assets := null; new.assets_brief := null; new.assets_status := 'none'; new.assets_error := ''; new.assets_started_at := null;
    new.leveled := null; new.leveled_status := 'none'; new.leveled_error := ''; new.leveled_started_at := null;
    new.assessment := null; new.asset_chosen := null; new.direction := null; new.subgoals := null; new.todos := null;
  end if;
  return new;
end $$;
drop trigger if exists engelbart_brainstorm_paper_change on public.engelbart_onboardings;
create trigger engelbart_brainstorm_paper_change before update of paper_id,source_article,dataset_resource on public.engelbart_onboardings
for each row execute function public.engelbart_clear_brainstorm_for_paper();
