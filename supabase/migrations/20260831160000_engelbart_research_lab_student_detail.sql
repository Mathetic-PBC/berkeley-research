-- Curator per-student detail. The curator UI now edits a student's bio and
-- website and creates projects owned by a student, so the lab read must carry
-- them back:
--   - members gain `bio` and `url`;
--   - projects cover the PI *and* their students (with `person_id`, so the UI
--     can show the owner);
--   - papers cover works attached to the PI or to any of their students —
--     previously a paper attached only at the student level disappeared from
--     the lab view.
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
               'bio', s.bio, 'url', s.url,
               'image_url', s.image_url) order by s.name)
      from berkeley.people s where s.advisor_id = p_pi_id), '[]'::jsonb),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pr.id, 'title', pr.title, 'description', pr.description,
               'status', pr.status, 'url', pr.url,
               'person_id', pr.person_id) order by pr.status, pr.title)
      from berkeley.projects pr
      join berkeley.people pp on pp.id = pr.person_id
      where pr.person_id = p_pi_id or pp.advisor_id = p_pi_id), '[]'::jsonb),
    'papers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pa.id, 'title', pa.title, 'authors', to_jsonb(pa.authors),
               'year', pa.year, 'venue', pa.venue, 'doi_url', pa.doi_url,
               'url', pa.url, 'has_pdf', (pa.pdf_path <> ''),
               'author_ids', (select coalesce(jsonb_agg(a2.person_id), '[]'::jsonb)
                              from berkeley.paper_authors a2 where a2.paper_id = pa.id))
               order by pa.year desc nulls last, pa.title)
      from berkeley.papers pa
      where exists (
        select 1
        from berkeley.paper_authors au
        join berkeley.people ap on ap.id = au.person_id
        where au.paper_id = pa.id
          and (au.person_id = p_pi_id or ap.advisor_id = p_pi_id))), '[]'::jsonb));
$$;

-- create or replace preserves the ACL, but re-assert the lockdown so this file
-- stands alone (same posture as 20260831130000/140000).
revoke execute on function public.engelbart_research_lab(uuid)
  from public, anon, authenticated;
grant execute on function public.engelbart_research_lab(uuid)
  to service_role;
