-- Create a brand-new person (a lab = a professor with a lab_name) in the shared
-- graph. Mirrors engelbart_curator_update_person's whitelist, but inserts. Used
-- by the curator when a lab of interest isn't in Berkeley's graph yet: the admin
-- creates the PI record and attaches it to the participant. `search` is a
-- GENERATED column, so the new lab becomes interest-searchable on its own.
--
-- service_role only, and -- unlike the RPCs 20260831130000 had to retro-fix --
-- the default PUBLIC/anon/authenticated grant is revoked here at creation time.
create or replace function public.engelbart_curator_create_person(p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, berkeley, pg_temp
as $$
declare r berkeley.people;
begin
  if coalesce(nullif(btrim(p_patch->>'name'), ''), '') = '' then
    raise exception 'a name is required to create a person';
  end if;
  insert into berkeley.people (
    kind, name, title, bio, url, image_url,
    lab_name, lab_url, lab_description, lab_image_url, interests)
  values (
    coalesce(nullif(p_patch->>'kind', ''), 'professor'),
    btrim(p_patch->>'name'),
    coalesce(p_patch->>'title', ''),
    coalesce(p_patch->>'bio', ''),
    coalesce(p_patch->>'url', ''),
    coalesce(p_patch->>'image_url', ''),
    coalesce(p_patch->>'lab_name', ''),
    coalesce(p_patch->>'lab_url', ''),
    coalesce(p_patch->>'lab_description', ''),
    coalesce(p_patch->>'lab_image_url', ''),
    case when jsonb_typeof(p_patch->'interests') = 'array'
         then array(select btrim(v)
                      from jsonb_array_elements_text(p_patch->'interests') as t(v)
                     where btrim(v) <> '')
         else '{}'::text[] end)
  returning * into r;
  return jsonb_build_object(
    'id', r.id, 'kind', r.kind, 'name', r.name, 'title', r.title, 'bio', r.bio,
    'url', r.url, 'image_url', r.image_url, 'lab_name', r.lab_name,
    'lab_url', r.lab_url, 'lab_description', r.lab_description,
    'lab_image_url', r.lab_image_url);
end;
$$;

revoke execute on function public.engelbart_curator_create_person(jsonb)
  from public, anon, authenticated;
grant execute on function public.engelbart_curator_create_person(jsonb)
  to service_role;
