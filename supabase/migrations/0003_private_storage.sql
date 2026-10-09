-- Original files are uploaded in phase 8. Phase 7 provisions a private owner-bound bucket.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('zamer-originals','zamer-originals',false,52428800,array['image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict(id) do update set public=false;
create policy zamer_originals_read on storage.objects for select to authenticated
using(bucket_id='zamer-originals' and exists(select 1 from public.cloud_projects p where p.id::text=split_part(name,'/',1) and p.owner_id=auth.uid()));
create policy zamer_originals_insert on storage.objects for insert to authenticated
with check(bucket_id='zamer-originals' and exists(select 1 from public.cloud_projects p where p.id::text=split_part(name,'/',1) and p.owner_id=auth.uid()));
-- No update/delete policy: originals are immutable; deletion lifecycle is added with photos.
