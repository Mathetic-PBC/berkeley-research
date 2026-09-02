-- The onboarding record: everything a reader says on /engelbart/setup, kept
-- as it is said. One live row per account; the row is the truth the page
-- mirrors, so a closed tab loses nothing and an abandoned flow still
-- leaves its calibration behind. Same posture as engelbart_pending_setups:
-- neither the browser nor the CLI reaches these tables directly.

create table if not exists public.engelbart_onboardings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'created')),
  step integer not null default 0 check (step between 0 and 10),
  name text not null default '',
  year text not null default '',
  major text not null default '',
  depth text not null default ''
    check (depth in ('', 'everyday', 'some', 'technical', 'expert')),
  paper_id uuid references berkeley.papers (id) on delete set null,
  paper_title text not null default '',
  project_url text not null default '',
  repo_url text not null default '',
  paper_familiarity integer check (paper_familiarity between 0 and 4),
  project_draft text not null default '',
  analysis jsonb,
  analysis_status text not null default 'none'
    check (analysis_status in ('none', 'running', 'done', 'error')),
  analysis_error text not null default '',
  analysis_started_at timestamptz,
  details jsonb,
  goals jsonb,
  goal_chosen text not null default '',
  todos jsonb,
  project_name text not null default '',
  pending_setup_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists engelbart_onboardings_one_open_idx
  on public.engelbart_onboardings (user_id) where status = 'open';
create index if not exists engelbart_onboardings_user_idx
  on public.engelbart_onboardings (user_id, created_at desc);

create table if not exists public.engelbart_onboarding_calibrations (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references public.engelbart_onboardings (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  area_index integer not null check (area_index between 0 and 3),
  area text not null default '',
  parent_field text not null default '',
  self_level integer not null check (self_level in (0, 25, 50, 75, 100)),
  question_level integer not null check (question_level in (0, 25, 50, 75, 100)),
  question text not null default '',
  sample_response text not null default '',
  answer text not null default '',
  graded_level integer check (graded_level in (0, 25, 50, 75, 100)),
  grade_confidence real check (grade_confidence between 0 and 1),
  grade_rationale text not null default '',
  asked_at timestamptz not null default now(),
  answered_at timestamptz,
  unique (onboarding_id, area_index, question_level)
);

create table if not exists public.engelbart_onboarding_asks (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references public.engelbart_onboardings (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  step integer not null default 0,
  quote text not null default '',
  question text not null default '',
  level text not null default '',
  answer text not null default '',
  created_at timestamptz not null default now()
);

alter table public.engelbart_onboardings enable row level security;
alter table public.engelbart_onboarding_calibrations enable row level security;
alter table public.engelbart_onboarding_asks enable row level security;

revoke all on public.engelbart_onboardings from anon, authenticated;
revoke all on public.engelbart_onboarding_calibrations from anon, authenticated;
revoke all on public.engelbart_onboarding_asks from anon, authenticated;
