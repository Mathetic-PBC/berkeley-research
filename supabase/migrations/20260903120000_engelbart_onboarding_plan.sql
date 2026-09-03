-- Onboarding v2: install early, brainstorm from the paper's assets, one
-- direction. Everything additive. The flow's steps are renumbered
-- (0 Name … 4 Paper · 5 Install · 6 Topics · 7 Brainstorm · 8 Assets ·
-- 9 Direction · 10 Subgoals · 11 Todos · 12 Done), so the step bound widens;
-- the project draft, details and goals columns stay for rows that have them.

alter table public.engelbart_onboardings
  drop constraint if exists engelbart_onboardings_step_check;
alter table public.engelbart_onboardings
  add constraint engelbart_onboardings_step_check check (step between 0 and 12);

alter table public.engelbart_onboardings
  -- The asset hunt: what the paper rests on or produces, in its own register.
  add column if not exists assets jsonb,
  add column if not exists assets_brief jsonb,
  add column if not exists assets_status text not null default 'none'
    check (assets_status in ('none', 'running', 'done', 'error')),
  add column if not exists assets_error text not null default '',
  add column if not exists assets_started_at timestamptz,
  -- What the topic questions found, compiled once they are all answered.
  add column if not exists assessment jsonb,
  -- The assets re-cut for this reader, with beginner stand-ins as children.
  add column if not exists leveled jsonb,
  add column if not exists leveled_status text not null default 'none'
    check (leveled_status in ('none', 'running', 'done', 'error')),
  add column if not exists leveled_error text not null default '',
  add column if not exists leveled_started_at timestamptz,
  -- What the brainstorm found they are drawn to, one line, kept current.
  add column if not exists interest text not null default '',
  -- The deliverable they picked, the direction, and its three pieces.
  add column if not exists asset_chosen jsonb,
  add column if not exists direction jsonb,
  add column if not exists subgoals jsonb;

-- Every conversational turn on the page: the brainstorm, a question about
-- one asset, and the change requests on the direction and the subgoals.
create table if not exists public.engelbart_onboarding_turns (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references public.engelbart_onboardings (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  stage text not null check (stage in ('brainstorm', 'asset', 'direction', 'subgoals')),
  asset_key text not null default '',
  role text not null check (role in ('user', 'assistant')),
  content text not null default '',
  card jsonb,
  created_at timestamptz not null default now()
);

create index if not exists engelbart_onboarding_turns_row_idx
  on public.engelbart_onboarding_turns (onboarding_id, stage, created_at);

alter table public.engelbart_onboarding_turns enable row level security;
revoke all on public.engelbart_onboarding_turns from anon, authenticated;
