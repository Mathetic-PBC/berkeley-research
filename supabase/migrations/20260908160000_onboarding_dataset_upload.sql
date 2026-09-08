-- Dataset attachments are independent of Analysis and the selected discovered asset.
alter table public.engelbart_onboardings
  add column if not exists dataset_resource jsonb,
  add column if not exists dataset_upload jsonb;

-- Private, immutable per-import objects. Only service-role signed URLs grant access.
-- The project's global Storage upload limit must also allow the chosen file size.
insert into storage.buckets (id, name, public, file_size_limit)
values ('engelbart-datasets', 'engelbart-datasets', false, 1073741824)
on conflict (id) do update set public = false;
