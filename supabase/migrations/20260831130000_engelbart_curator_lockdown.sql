-- Close an unintended exposure on the curator + research RPCs.
--
-- These functions are SECURITY DEFINER: they bypass RLS on the berkeley.* base
-- tables and are meant to be reachable ONLY through the admin-gated curator API
-- with the service role -- "never a browser key", as 20260831120000 puts it.
-- But 20260830120000 / 20260831120000 only GRANTed EXECUTE to service_role and
-- never REVOKEd the EXECUTE that Postgres (to PUBLIC) and Supabase (to anon /
-- authenticated) grant on a new function by default. The net effect: the public
-- anon key -- shipped to every browser -- could call them straight through
-- PostgREST (/rest/v1/rpc/...), bypassing requireAdmin, to read the whole
-- research graph or rewrite people / projects / papers / PDF paths.
--
-- Revoke those default grants. service_role keeps its own explicit grant, so the
-- server API is unaffected. Idempotent: re-running these revokes is a no-op.
--
-- NOT in scope here: several engelbart auth/session/signup RPCs are also
-- anon-executable, but some are legitimately browser- or auth-hook-facing, so
-- each needs its caller checked before its grants are narrowed.

revoke execute on function public.engelbart_curator_members()
  from public, anon, authenticated;
revoke execute on function public.engelbart_curator_update_person(uuid, jsonb)
  from public, anon, authenticated;
revoke execute on function public.engelbart_curator_upsert_project(uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke execute on function public.engelbart_curator_upsert_paper(uuid, jsonb)
  from public, anon, authenticated;
revoke execute on function public.engelbart_curator_set_paper_pdf(uuid, text)
  from public, anon, authenticated;
revoke execute on function public.engelbart_curator_set_paper_authors(uuid, uuid[])
  from public, anon, authenticated;
revoke execute on function public.engelbart_paper_source(uuid)
  from public, anon, authenticated;
revoke execute on function public.engelbart_research_lab(uuid)
  from public, anon, authenticated;
revoke execute on function public.engelbart_research_lab_matches(text, integer)
  from public, anon, authenticated;
revoke execute on function public.engelbart_research_person_works(uuid)
  from public, anon, authenticated;
