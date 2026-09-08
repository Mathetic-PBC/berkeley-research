-- Each member's placing of the design mock-ups in the `mock-us` storage
-- bucket: a single-elimination bracket played at /engelbart/mockups, two
-- mock-ups side by side, the better one picked until four places are
-- decided. One row per member, replaced when they rank again.
--
-- `top` is the placing, first to fourth: [{rank, id, name}], where id is the
-- storage object's id and name its file name without the extension. `picks`
-- is every comparison in the order it was made: [{a, b, winner, at}].
-- `entrants` is how many mock-ups were in the bracket.
--
-- Written and read only by the service role, from the Vercel function; the
-- browser reaches it through /api/engelbart-mockups and nothing else.

create table if not exists public.engelbart_mockup_rankings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  top jsonb not null default '[]'::jsonb,
  picks jsonb not null default '[]'::jsonb,
  entrants integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.engelbart_mockup_rankings enable row level security;
revoke all on public.engelbart_mockup_rankings from public, anon, authenticated;
