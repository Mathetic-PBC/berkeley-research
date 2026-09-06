-- Bart telemetry: the Operation, Snapshot and Event entities of
-- docs/observability/data-contract.md as three tables. The Run is derived
-- (its id is the onboarding row's id, or a test run's name), so it has no
-- table of its own. Columns are the contract's fields, verbatim, because the
-- store writes the records as they are.
--
-- Written only by the service role, from the Vercel functions, and only when
-- ENGELBART_TELEMETRY_STORE is on. Same posture as every other Engelbart
-- table: neither the browser nor the CLI reaches these directly. No foreign
-- key to engelbart_onboardings: a reset deletes the row, and what happened to
-- it is exactly what the record must keep.

create table if not exists public.engelbart_telemetry_operations (
  operation_id uuid primary key,
  trace_id text not null,
  span_id text not null,
  parent_span_id text,
  run_id text,
  onboarding_id uuid,
  test_run_id text,
  action text,
  name text not null,
  type text not null check (type in ('workflow', 'model', 'database', 'storage', 'http', 'processing')),
  -- What the operation means to a reader: the root, a step worth showing, or
  -- the implementation a step is made of.
  level text not null default 'stage' check (level in ('workflow', 'stage', 'detail')),
  status text not null check (status in ('running', 'waiting', 'completed', 'failed')),
  started_at timestamptz not null,
  ended_at timestamptz,
  duration_ms double precision,
  attributes jsonb not null default '{}'::jsonb,
  snapshots jsonb not null default '{}'::jsonb,
  error jsonb,
  environment text,
  code_version text,
  deployment text,
  created_at timestamptz not null default now()
);

create index if not exists engelbart_telemetry_operations_trace_idx
  on public.engelbart_telemetry_operations (trace_id, started_at);
create index if not exists engelbart_telemetry_operations_run_idx
  on public.engelbart_telemetry_operations (run_id, started_at desc);
create index if not exists engelbart_telemetry_operations_test_run_idx
  on public.engelbart_telemetry_operations (test_run_id, started_at desc)
  where test_run_id is not null;

-- Payloads, by kind, beside the operation they belong to. Always redacted
-- before they are written; `truncated` says the byte bound cut them.
create table if not exists public.engelbart_telemetry_snapshots (
  snapshot_id uuid primary key,
  operation_id uuid not null,
  trace_id text not null,
  span_id text not null,
  run_id text,
  onboarding_id uuid,
  test_run_id text,
  kind text not null,
  content jsonb,
  bytes integer not null default 0,
  truncated boolean not null default false,
  redacted boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists engelbart_telemetry_snapshots_operation_idx
  on public.engelbart_telemetry_snapshots (operation_id);
create index if not exists engelbart_telemetry_snapshots_trace_idx
  on public.engelbart_telemetry_snapshots (trace_id);

-- Lifecycle events, in the order they happened (`sequence` orders events
-- that share a millisecond). They carry the same trace, span and parent
-- span ids as the operation they belong to.
create table if not exists public.engelbart_telemetry_events (
  event_id uuid primary key,
  sequence bigint not null,
  type text not null check (type in ('operation.started', 'operation.progress', 'operation.completed', 'operation.failed')),
  at timestamptz not null,
  operation_id uuid not null,
  trace_id text not null,
  span_id text not null,
  parent_span_id text,
  run_id text,
  onboarding_id uuid,
  test_run_id text,
  action text,
  name text not null,
  operation_type text not null,
  level text not null default 'stage' check (level in ('workflow', 'stage', 'detail')),
  status text not null,
  attributes jsonb,
  snapshots jsonb,
  duration_ms double precision,
  progress jsonb,
  error jsonb,
  created_at timestamptz not null default now()
);

create index if not exists engelbart_telemetry_events_trace_idx
  on public.engelbart_telemetry_events (trace_id, sequence);
create index if not exists engelbart_telemetry_events_run_idx
  on public.engelbart_telemetry_events (run_id, at desc);

alter table public.engelbart_telemetry_operations enable row level security;
alter table public.engelbart_telemetry_snapshots enable row level security;
alter table public.engelbart_telemetry_events enable row level security;
revoke all on public.engelbart_telemetry_operations from anon, authenticated;
revoke all on public.engelbart_telemetry_snapshots from anon, authenticated;
revoke all on public.engelbart_telemetry_events from anon, authenticated;
