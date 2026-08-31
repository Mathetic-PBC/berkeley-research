-- Engelbart onboarding: read access to the Berkeley research graph.
--
-- The redesigned web onboarding lets a student explore from their own interest
-- outward -- research areas, then labs, then a lab's people and work -- before
-- an idea is ever named. That exploration is grounded in the real `berkeley`
-- schema (departments, people, projects) that already lives in this project,
-- not in fixtures. The API reaches it only through the read-only functions
-- below.
--
-- Departments are NOT the user-facing "research areas". The visible areas are
-- semantic clusters (e.g. "Neural interfaces", "Sensorimotor systems") named by
-- the model over the labs actually retrieved for an interest. So the database's
-- job here is retrieval and detail, not grouping: `engelbart_research_lab_matches`
-- returns the real labs an interest connects to (matched by the lab's own text
-- OR its projects, across every department), and the model clusters those in
-- api/_lib/research-model.js. Department stays available as a field for context,
-- used internally, never shown as the area.
--
-- Why functions and not the existing public.berkeley_* wrapper views: the lab
-- hierarchy is carried by columns those views do not expose -- a professor's
-- `lab_name` and a student's `advisor_id`. These SECURITY DEFINER functions read
-- the base tables, return exactly the shape onboarding needs, and are granted
-- only to service_role -- reachable through the server (which gates every call
-- on Engelbart membership), never through the anon or authenticated keys.
--
-- Both are STABLE and read-only. They create nothing and write nothing.

-- Turn a free-text interest into a forgiving OR tsquery: every content word is
-- optional, so a phrase like "brain computer interfaces" ranks labs by how much
-- of the interest they touch instead of demanding all of it. Short words and a
-- few stopwords are dropped; an interest that reduces to nothing falls back to
-- the single term "research" so the query is never empty.
create or replace function public.engelbart_interest_tsquery(p_interest text)
returns tsquery
language sql
immutable
as $$
  select to_tsquery(
    'english',
    coalesce(
      nullif(
        array_to_string(
          (select array_agg(w)
             from unnest(regexp_split_to_array(
               lower(regexp_replace(coalesce(p_interest, ''), '[^a-z0-9 ]', ' ', 'g')),
               '\s+')) as w
            where length(w) > 2
              and w not in ('for','the','and','with','how','into','from','that',
                            'this','are','you','your','who','what','use','using')),
          ' | '),
        ''),
      'research'));
$$;

-- The real labs an interest connects to, across every department, ranked by the
-- best of the lab's own text match and its projects' match. One row per lab =
-- one professor with a named lab, carrying enough (bio, interests, department,
-- counts) for the model to cluster them into a few plain-English areas and for
-- the UI to show each lab. This is retrieval; the grouping into areas happens
-- in the model layer, not here.
create or replace function public.engelbart_research_lab_matches(
  p_interest text,
  p_limit int default 15)
returns table (
  pi_id uuid,
  pi_name text,
  title text,
  lab_name text,
  lab_url text,
  bio text,
  interests text[],
  department text,
  n_members int,
  n_projects int,
  rank real)
language sql
stable
security definer
set search_path = public, berkeley, pg_temp
as $$
  with q as (select public.engelbart_interest_tsquery(p_interest) as tsq)
  select p.id, p.name, p.title, p.lab_name, p.lab_url, p.bio, p.interests,
         (select d.name from berkeley.departments d where d.id = p.department_id) as department,
         (select count(*)::int from berkeley.people s where s.advisor_id = p.id) as n_members,
         (select count(*)::int from berkeley.projects pr where pr.person_id = p.id) as n_projects,
         greatest(
           ts_rank(p.search, q.tsq),
           coalesce((select max(ts_rank(pr.search, q.tsq))
                       from berkeley.projects pr where pr.person_id = p.id), 0)
         ) as rank
  from berkeley.people p
  join q on true
  where p.kind = 'professor'
    and coalesce(p.lab_name, '') <> ''
    and (p.search @@ q.tsq
         or exists (select 1 from berkeley.projects pr
                     where pr.person_id = p.id and pr.search @@ q.tsq))
  order by rank desc, p.name
  limit greatest(coalesce(p_limit, 15), 1);
$$;

-- One lab, in full: the principal investigator, the students they advise, and
-- the lab's real projects. `projects` stands in for a publication list -- the
-- berkeley.papers table is not populated, and a lab's projects are its actual,
-- described work.
--
-- Students are returned as VERIFIED FIELDS ONLY -- name and scraped title. Their
-- `interests` are deliberately omitted: in the source they are inherited from
-- the PI, not student-specific, so surfacing them would present a fabricated
-- personal research focus. Generated project ideas attach to the lab/PI instead.
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
        'department', (select d.name from berkeley.departments d where d.id = p.department_id))
      from berkeley.people p
      where p.id = p_pi_id and p.kind = 'professor'),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'name', s.name, 'title', s.title) order by s.name)
      from berkeley.people s where s.advisor_id = p_pi_id), '[]'::jsonb),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pr.id, 'title', pr.title, 'description', pr.description,
               'status', pr.status, 'url', pr.url) order by pr.status, pr.title)
      from berkeley.projects pr where pr.person_id = p_pi_id), '[]'::jsonb));
$$;

-- Reachable through the server only. The service role bypasses RLS on the
-- berkeley base tables; the anon and authenticated keys are deliberately not
-- granted, so research browsing stays behind the membership gate the API
-- enforces before it ever calls these.
grant execute on function public.engelbart_interest_tsquery(text) to service_role;
grant execute on function public.engelbart_research_lab_matches(text, int) to service_role;
grant execute on function public.engelbart_research_lab(uuid) to service_role;
