-- Extend engelbart_curator_create_person to optionally set advisor_id, so the
-- curator can create a PhD STUDENT under a PI (kind 'phd_student' + advisor_id =
-- the PI), not only a lab/professor. advisor_id is taken from the patch only when
-- it is a well-formed uuid; anything else leaves it null (a top-level person).
-- Same signature (jsonb) and same service_role-only lockdown as before -- create
-- or replace preserves the existing grants; the revoke/grant here is idempotent.
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
    lab_name, lab_url, lab_description, lab_image_url, interests, advisor_id)
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
         else '{}'::text[] end,
    case when (p_patch->>'advisor_id') ~*
              '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         then (p_patch->>'advisor_id')::uuid else null end)
  returning * into r;
  return jsonb_build_object(
    'id', r.id, 'kind', r.kind, 'name', r.name, 'title', r.title, 'bio', r.bio,
    'url', r.url, 'image_url', r.image_url, 'lab_name', r.lab_name,
    'lab_url', r.lab_url, 'lab_description', r.lab_description,
    'lab_image_url', r.lab_image_url, 'advisor_id', r.advisor_id);
end;
$$;

revoke execute on function public.engelbart_curator_create_person(jsonb)
  from public, anon, authenticated;
grant execute on function public.engelbart_curator_create_person(jsonb)
  to service_role;
