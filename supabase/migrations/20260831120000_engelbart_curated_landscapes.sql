-- Engelbart: canonical paper entities + participant-curated research landscapes.
--
-- Two layers, kept deliberately separate (per the task clarifications):
--
--   A. The canonical `berkeley` graph is global and shared. Facts about labs,
--      PIs, students, their work and their papers -- including images,
--      descriptions, websites, DOIs and stored PDFs -- live here and are
--      reusable by everyone. This migration adds the fact columns the graph was
--      missing (person/lab images, a lab description), a real canonical papers
--      entity with PDF storage, and SECURITY DEFINER write functions so a
--      manual correction updates the shared graph rather than hiding inside one
--      participant's record.
--
--   B. A participant's curation is a thin layer on top: which canonical labs /
--      people / works / papers appear, in what order, with optional per-
--      participant notes or presentation overrides, plus an optional snapshot
--      for a deterministic test session. It references canonical ids only; it
--      never duplicates canonical facts and never holds a PDF or a signed URL.
--
-- Onboarding prefers a participant's curated landscape when one exists (keeping
-- its ordering); otherwise it falls back to the existing generic interest
-- retrieval over the canonical graph. Nothing here changes that fallback.

-- =========================================================================
-- A. canonical fact columns (additive, no data migration)
-- =========================================================================

-- Images are new canonical facts: the graph had no image anywhere. A person's
-- own website is already `url`; a lab's is already `lab_url`. A lab is 1:1 with
-- its PI professor in this data (labs live as `lab_name`/`lab_url` on the
-- professor), so the lab's description and image live on the professor too --
-- no new labs table for a one-to-one fact.
alter table berkeley.people
  add column if not exists image_url text not null default '',
  add column if not exists lab_description text not null default '',
  add column if not exists lab_image_url text not null default '';

-- =========================================================================
-- A. canonical papers (dedicated entity, on the live uuid graph)
-- =========================================================================
-- The scaffold `berkeley.papers` from the abandoned ext_id/people_v3 scheme is
-- empty (0 rows) and unreferenced by any code. Reshape it onto the live graph:
-- a paper is authored by real `berkeley.people`, carries its own metadata and
-- source/DOI, and may have one stored PDF. The PDF bytes live in Supabase
-- Storage (private bucket `berkeley-papers`); the record stores only the stable
-- object PATH -- never a signed URL, which is minted fresh per view.
-- Drop the linkage first (child before parent): `drop table papers cascade`
-- only sheds the FK *constraint* on an old paper_authors, not the table, so a
-- surviving scaffold would collide on re-run (42P07). Both drops make this
-- migration safely re-runnable on a partially-applied database.
drop table if exists berkeley.paper_authors cascade;
drop table if exists berkeley.papers cascade;

create table berkeley.papers (
  id uuid primary key default gen_random_uuid(),
  title text not null default '',
  -- Display authors, including any not in the Berkeley graph. Curated text;
  -- the graph linkage is berkeley.paper_authors below.
  authors text[] not null default '{}'::text[],
  year int,
  venue text not null default '',
  doi_url text not null default '',      -- source / DOI URL
  url text not null default '',          -- landing / source URL (optional)
  -- Supabase Storage object path in the private `berkeley-papers` bucket, e.g.
  -- 'papers/<uuid>.pdf'. Empty when no PDF is stored. NEVER a signed URL.
  pdf_path text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Which real people a paper belongs to -- the graph linkage that lets a paper
-- attach at the lab/PI level (author = the professor) or the student level
-- (author = the student), and to several people at once. A paper is never
-- forced onto a student: it belongs to whoever actually authored it.
create table berkeley.paper_authors (
  paper_id uuid not null references berkeley.papers(id) on delete cascade,
  person_id uuid not null references berkeley.people(id) on delete cascade,
  primary key (paper_id, person_id)
);
create index if not exists berkeley_paper_authors_person_idx
  on berkeley.paper_authors(person_id);

-- Same posture as the rest of berkeley.*: RLS on, reached only through the
-- SECURITY DEFINER functions below (service_role); PDF bytes reached only
-- through short-lived signed URLs the API mints. No anon/authenticated grants.
alter table berkeley.papers enable row level security;
alter table berkeley.paper_authors enable row level security;

-- The private bucket for canonical paper PDFs. Private: every read is a signed
-- URL minted by the API with the service role; the browser never holds the key.
insert into storage.buckets (id, name, public)
values ('berkeley-papers', 'berkeley-papers', false)
on conflict (id) do nothing;

-- =========================================================================
-- A. extend the lab read to carry the new facts + papers
-- =========================================================================
-- Same jsonb shape as before, plus: image_url on the PI and each member,
-- lab_description / lab_image_url on the PI, and a `papers` list for the PI
-- (metadata + `has_pdf` only -- never the path or a signed URL). Adding keys to
-- a jsonb result is backward-compatible: onboarding ignores keys it does not
-- read and gains the new ones when it is ready.
create or replace function public.engelbart_research_lab(p_pi_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, berkeley, pg_temp
as $$
  select jsonb_build_object(
    'pi', (
      select jsonb_build_object(
        'id', p.id, 'name', p.name, 'title', p.title, 'bio', p.bio,
        'interests', to_jsonb(p.interests), 'lab_name', p.lab_name,
        'lab_url', p.lab_url, 'url', p.url,
        'image_url', p.image_url,
        'lab_description', p.lab_description,
        'lab_image_url', p.lab_image_url,
        'department', (select d.name from berkeley.departments d where d.id = p.department_id))
      from berkeley.people p
      where p.id = p_pi_id and p.kind = 'professor'),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'name', s.name, 'title', s.title,
               'image_url', s.image_url) order by s.name)
      from berkeley.people s where s.advisor_id = p_pi_id), '[]'::jsonb),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pr.id, 'title', pr.title, 'description', pr.description,
               'status', pr.status, 'url', pr.url) order by pr.status, pr.title)
      from berkeley.projects pr where pr.person_id = p_pi_id), '[]'::jsonb),
    'papers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pa.id, 'title', pa.title, 'authors', to_jsonb(pa.authors),
               'year', pa.year, 'venue', pa.venue, 'doi_url', pa.doi_url,
               'url', pa.url, 'has_pdf', (pa.pdf_path <> ''),
               'author_ids', (select coalesce(jsonb_agg(a2.person_id), '[]'::jsonb)
                              from berkeley.paper_authors a2 where a2.paper_id = pa.id))
               order by pa.year desc nulls last, pa.title)
      from berkeley.papers pa
      join berkeley.paper_authors au on au.paper_id = pa.id
      where au.person_id = p_pi_id), '[]'::jsonb));
$$;

-- One person's own work and papers -- for the curator (to show/attach works and
-- papers under a PI or a specific student) and for student-level detail. Papers
-- carry `has_pdf` only, never the path.
create or replace function public.engelbart_research_person_works(p_person_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, berkeley, pg_temp
as $$
  select jsonb_build_object(
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pr.id, 'title', pr.title, 'description', pr.description,
               'status', pr.status, 'url', pr.url) order by pr.status, pr.title)
      from berkeley.projects pr where pr.person_id = p_person_id), '[]'::jsonb),
    'papers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pa.id, 'title', pa.title, 'authors', to_jsonb(pa.authors),
               'year', pa.year, 'venue', pa.venue, 'doi_url', pa.doi_url,
               'url', pa.url, 'has_pdf', (pa.pdf_path <> ''),
               'author_ids', (select coalesce(jsonb_agg(a2.person_id), '[]'::jsonb)
                              from berkeley.paper_authors a2 where a2.paper_id = pa.id))
               order by pa.year desc nulls last, pa.title)
      from berkeley.papers pa
      join berkeley.paper_authors au on au.paper_id = pa.id
      where au.person_id = p_person_id), '[]'::jsonb));
$$;

-- The Engelbart members, with emails, so the curator can bind a participant
-- record to a real login. Service-role only (it reads auth.users).
create or replace function public.engelbart_curator_members()
returns jsonb
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object('user_id', u.id, 'email', u.email)
    order by u.created_at), '[]'::jsonb)
  from auth.users u
  join public.engelbart_members m on m.user_id = u.id;
$$;

-- The stored-PDF reference for one paper, for the API to mint a signed URL.
-- Returns the path plus the source fallbacks; the path never leaves the server.
create or replace function public.engelbart_paper_source(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, berkeley, pg_temp
as $$
  select jsonb_build_object(
    'id', pa.id, 'title', pa.title, 'pdf_path', pa.pdf_path,
    'doi_url', pa.doi_url, 'url', pa.url)
  from berkeley.papers pa where pa.id = p_id;
$$;

-- =========================================================================
-- A. canonical writes for the curator (service_role only)
-- =========================================================================
-- A manual factual correction updates the shared graph. All run as the definer
-- (bypassing RLS on berkeley.*) and are granted to service_role only --
-- reachable through the admin-gated curator API, never a browser key. Only a
-- whitelist of fields is touched; a key absent from the patch leaves its column
-- unchanged, so a partial edit never blanks a field.

create or replace function public.engelbart_curator_update_person(
  p_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, berkeley, pg_temp
as $$
declare r berkeley.people;
begin
  update berkeley.people p set
    name            = coalesce(p_patch->>'name', p.name),
    title           = coalesce(p_patch->>'title', p.title),
    bio             = coalesce(p_patch->>'bio', p.bio),
    url             = coalesce(p_patch->>'url', p.url),
    image_url       = coalesce(p_patch->>'image_url', p.image_url),
    lab_name        = coalesce(p_patch->>'lab_name', p.lab_name),
    lab_url         = coalesce(p_patch->>'lab_url', p.lab_url),
    lab_description = coalesce(p_patch->>'lab_description', p.lab_description),
    lab_image_url   = coalesce(p_patch->>'lab_image_url', p.lab_image_url),
    updated_at      = now()
  where p.id = p_id
  returning * into r;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', r.id, 'kind', r.kind, 'name', r.name, 'title', r.title, 'bio', r.bio,
    'url', r.url, 'image_url', r.image_url, 'lab_name', r.lab_name,
    'lab_url', r.lab_url, 'lab_description', r.lab_description,
    'lab_image_url', r.lab_image_url);
end;
$$;

create or replace function public.engelbart_curator_upsert_project(
  p_id uuid, p_person_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, berkeley, pg_temp
as $$
declare r berkeley.projects;
begin
  if p_id is not null then
    update berkeley.projects pr set
      title       = coalesce(p_patch->>'title', pr.title),
      description = coalesce(p_patch->>'description', pr.description),
      status      = coalesce(nullif(p_patch->>'status', ''), pr.status),
      url         = coalesce(p_patch->>'url', pr.url)
    where pr.id = p_id
    returning * into r;
    if not found then return null; end if;
  else
    if p_person_id is null then
      raise exception 'a person id is required to create a project';
    end if;
    insert into berkeley.projects (person_id, title, description, status, url)
    values (
      p_person_id,
      coalesce(p_patch->>'title', ''),
      coalesce(p_patch->>'description', ''),
      coalesce(nullif(p_patch->>'status', ''), 'active'),
      coalesce(p_patch->>'url', ''))
    returning * into r;
  end if;
  return jsonb_build_object('id', r.id, 'person_id', r.person_id, 'title', r.title,
    'description', r.description, 'status', r.status, 'url', r.url);
end;
$$;

-- Create or edit a canonical paper's metadata. PDF is handled separately
-- (set_paper_pdf, after the bytes land in Storage). Authors linkage is set by
-- engelbart_curator_set_paper_authors.
create or replace function public.engelbart_curator_upsert_paper(
  p_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, berkeley, pg_temp
as $$
declare r berkeley.papers;
begin
  if p_id is not null then
    update berkeley.papers pa set
      title   = coalesce(p_patch->>'title', pa.title),
      authors = coalesce(
                  case when p_patch ? 'authors'
                       then array(select jsonb_array_elements_text(p_patch->'authors'))
                       else null end, pa.authors),
      year    = coalesce((p_patch->>'year')::int, pa.year),
      venue   = coalesce(p_patch->>'venue', pa.venue),
      doi_url = coalesce(p_patch->>'doi_url', pa.doi_url),
      url     = coalesce(p_patch->>'url', pa.url),
      updated_at = now()
    where pa.id = p_id
    returning * into r;
    if not found then return null; end if;
  else
    insert into berkeley.papers (title, authors, year, venue, doi_url, url)
    values (
      coalesce(p_patch->>'title', ''),
      coalesce(case when p_patch ? 'authors'
                    then array(select jsonb_array_elements_text(p_patch->'authors'))
                    else null end, '{}'::text[]),
      (p_patch->>'year')::int,
      coalesce(p_patch->>'venue', ''),
      coalesce(p_patch->>'doi_url', ''),
      coalesce(p_patch->>'url', ''))
    returning * into r;
  end if;
  return jsonb_build_object('id', r.id, 'title', r.title,
    'authors', to_jsonb(r.authors), 'year', r.year, 'venue', r.venue,
    'doi_url', r.doi_url, 'url', r.url, 'has_pdf', (r.pdf_path <> ''));
end;
$$;

-- Record (or clear) a paper's stored-PDF path after the upload lands in Storage.
create or replace function public.engelbart_curator_set_paper_pdf(
  p_id uuid, p_pdf_path text)
returns jsonb
language plpgsql
security definer
set search_path = public, berkeley, pg_temp
as $$
declare r berkeley.papers;
begin
  update berkeley.papers pa
    set pdf_path = coalesce(p_pdf_path, ''), updated_at = now()
  where pa.id = p_id
  returning * into r;
  if not found then return null; end if;
  return jsonb_build_object('id', r.id, 'has_pdf', (r.pdf_path <> ''));
end;
$$;

-- Replace a paper's author links -- the levels (PI / students) it attaches to.
create or replace function public.engelbart_curator_set_paper_authors(
  p_id uuid, p_person_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, berkeley, pg_temp
as $$
begin
  delete from berkeley.paper_authors where paper_id = p_id;
  insert into berkeley.paper_authors (paper_id, person_id)
    select p_id, pid from unnest(coalesce(p_person_ids, '{}'::uuid[])) as pid
    on conflict do nothing;
  return jsonb_build_object('id', p_id,
    'author_ids', to_jsonb(coalesce(p_person_ids, '{}'::uuid[])));
end;
$$;

-- =========================================================================
-- B. the participant curation layer
-- =========================================================================
-- One row per participant. `participant_key` is a stable handle that can exist
-- before the person has a login ('ashley'); `auth_user_id` binds it to a real
-- account later, so onboarding can match either way. `bundle` holds references
-- to canonical ids + ordering + optional overrides/notes + an optional
-- snapshot -- never a second copy of the canonical facts, never a PDF, never a
-- signed URL.
create table if not exists public.engelbart_curated_landscapes (
  id uuid primary key default gen_random_uuid(),
  participant_key text not null unique,
  auth_user_id uuid references auth.users(id) on delete set null,
  label text not null default '',
  bundle jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists engelbart_curated_landscapes_user_idx
  on public.engelbart_curated_landscapes(auth_user_id);

-- Read and written only by the service role (which bypasses RLS), through the
-- admin-gated curator API. RLS on with no anon/authenticated policy denies the
-- browser keys entirely -- the same posture as engelbart_admin_config.
alter table public.engelbart_curated_landscapes enable row level security;

-- =========================================================================
-- grants: service_role only, everywhere
-- =========================================================================
grant execute on function public.engelbart_curator_members() to service_role;
grant execute on function public.engelbart_research_person_works(uuid) to service_role;
grant execute on function public.engelbart_paper_source(uuid) to service_role;
grant execute on function public.engelbart_curator_update_person(uuid, jsonb) to service_role;
grant execute on function public.engelbart_curator_upsert_project(uuid, uuid, jsonb) to service_role;
grant execute on function public.engelbart_curator_upsert_paper(uuid, jsonb) to service_role;
grant execute on function public.engelbart_curator_set_paper_pdf(uuid, text) to service_role;
grant execute on function public.engelbart_curator_set_paper_authors(uuid, uuid[]) to service_role;
