-- Add structured defect/photo metadata. Original bytes remain in private Storage.
create table public.cloud_defects (
 project_id uuid not null references public.cloud_projects(id) on delete cascade,
 id uuid not null, floor_id uuid, data jsonb not null, primary key(project_id,id),
 foreign key(project_id,floor_id) references public.cloud_floors(project_id,id) on delete cascade
);
create table public.cloud_photos (
 project_id uuid not null references public.cloud_projects(id) on delete cascade,
 id uuid not null, floor_id uuid, defect_id uuid, storage_key text not null, checksum text not null,
 data jsonb not null, primary key(project_id,id),
 foreign key(project_id,floor_id) references public.cloud_floors(project_id,id) on delete cascade,
 foreign key(project_id,defect_id) references public.cloud_defects(project_id,id)
);
alter table public.cloud_defects enable row level security;
alter table public.cloud_photos enable row level security;
create policy cloud_defects_read on public.cloud_defects for select to authenticated using(exists(select 1 from public.cloud_projects p where p.id=project_id and p.owner_id=auth.uid()));
create policy cloud_photos_read on public.cloud_photos for select to authenticated using(exists(select 1 from public.cloud_projects p where p.id=project_id and p.owner_id=auth.uid()));
revoke all on public.cloud_defects,public.cloud_photos from anon,authenticated;
grant select on public.cloud_defects,public.cloud_photos to authenticated;

alter function public.zamer_validate_snapshot(jsonb,uuid,uuid) rename to zamer_validate_geometry;
create function public.zamer_validate_snapshot(s jsonb,pid uuid,uid uuid) returns void language plpgsql set search_path='' as $$
declare d jsonb; k text; field text; ids text[]; g jsonb;
begin
 if s->>'schemaVersion'='4' then perform public.zamer_validate_geometry(s,pid,uid);return;end if;
 if s->>'schemaVersion' is distinct from '5' or s->>'exportSchemaVersion' is distinct from '5' then raise exception 'Unsupported snapshot version';end if;
 g:=(s-'defects'-'photos')||jsonb_build_object('schemaVersion',4,'exportSchemaVersion',4);
 perform public.zamer_validate_geometry(g,pid,uid);
 select array_agg(value->>'id') into ids from jsonb_array_elements((s->'floors')||(s->'walls')||(s->'elements')||(s->'rooms')||(s->'dimensions')||(s->'junctions'));
 ids:=array_append(ids,pid::text);
 foreach k in array array['defects','photos'] loop
  if jsonb_typeof(s->k) is distinct from 'array' or jsonb_array_length(s->k)>10000 or (k='photos' and jsonb_array_length(s->k)>2000) then raise exception 'Invalid media collection';end if;
  for d in select value from jsonb_array_elements(s->k) loop
   if (d->>'projectId')::uuid is distinct from pid or d->>'id' is null or (d->>'id')::uuid::text=any(ids) then raise exception 'Invalid media identity';end if;
   ids:=array_append(ids,(d->>'id')::uuid::text);
   if d->>'floorId' is not null and not exists(select 1 from jsonb_array_elements(s->'floors') f where f->>'id'=d->>'floorId') then raise exception 'Invalid media floor';end if;
   -- A missing room/element can be a historical binding after a geometry deletion.
   if exists(select 1 from jsonb_array_elements(s->'rooms') r where r->>'id'=d->>'roomId' and r->>'floorId' is distinct from d->>'floorId') then raise exception 'Invalid media room';end if;
   perform (d->>'createdAt')::timestamptz,(d->>'deletedAt')::timestamptz;
   if k='defects' then
    if not coalesce(length(trim(d->>'type')) between 1 and 80 and length(trim(d->>'description')) between 1 and 4000 and d->>'status' in ('open','resolved'),false) then raise exception 'Invalid defect';end if;
    if d->'position'<>'null'::jsonb and not public.zamer_valid_point(d->'position') then raise exception 'Invalid defect position';end if;
    foreach field in array array['length','width','depth'] loop
     if d->field<>'null'::jsonb and not coalesce(jsonb_typeof(d->field)='number' and (d->>field)::numeric>0 and (d->>field)::numeric<1e100,false) then raise exception 'Invalid defect size';end if;
    end loop;
   else
    if not coalesce(d->>'checksum' ~ '^[a-f0-9]{64}$' and d->>'storageKey'=(pid::text||'/'||(d->>'id')||'/'||(d->>'checksum')) and (d->>'size')::bigint between 1 and 52428800 and d->>'mimeType' in ('image/jpeg','image/png','image/webp','image/heic','image/heif'),false) then raise exception 'Invalid original metadata';end if;
    if d->>'defectId' is not null and not exists(select 1 from jsonb_array_elements(s->'defects') x where x->>'id'=d->>'defectId' and x->>'floorId' is not distinct from d->>'floorId' and x->>'roomId' is not distinct from d->>'roomId' and x->>'elementId' is not distinct from d->>'elementId') then raise exception 'Invalid photo defect binding';end if;
   end if;
  end loop;
 end loop;
end $$;
revoke all on function public.zamer_validate_snapshot(jsonb,uuid,uuid) from public,anon,authenticated;

create or replace function public.zamer_push(project_id uuid,command_id uuid,base_revision bigint,snapshot jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); head public.cloud_projects; prior public.cloud_commands; digest text; response jsonb; next_revision bigint; k text; e jsonb;
begin
 if uid is null then raise exception 'Authentication required' using errcode='42501';end if;
 if base_revision<0 or base_revision is null then raise exception 'Invalid base revision';end if;
 perform pg_advisory_xact_lock(hashtextextended(uid::text||command_id::text,0));
 digest:=encode(sha256(convert_to(project_id::text||':'||base_revision::text||':'||snapshot::text,'UTF8')),'hex');
 select * into prior from public.cloud_commands c where c.owner_id=uid and c.command_id=zamer_push.command_id;
 if found then
  if prior.request_hash<>digest or prior.project_id<>project_id then raise exception 'Command identity reused with a different payload';end if;
  return prior.response;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(project_id::text,0));
 select * into head from public.cloud_projects p where p.id=project_id for update;
 if found and head.owner_id<>uid then raise exception 'Project unavailable' using errcode='42501';end if;
 perform public.zamer_validate_snapshot(snapshot,project_id,uid);
 if (head.id is null and base_revision<>0) or (head.id is not null and head.revision<>base_revision) then
  if head.id is null then raise exception 'Project unavailable';end if;
  select jsonb_build_object('type','conflict','revision',head.revision,'snapshot',v.snapshot) into response from public.cloud_versions v where v.project_id=zamer_push.project_id and v.revision=head.revision;
 else
  next_revision:=coalesce(head.revision,0)+1;
  insert into public.cloud_projects(id,owner_id,revision,project_data) values(project_id,uid,next_revision,snapshot->'project')
   on conflict(id) do update set revision=excluded.revision,project_data=excluded.project_data,updated_at=now();
  delete from public.cloud_photos p where p.project_id=zamer_push.project_id;
  delete from public.cloud_defects d where d.project_id=zamer_push.project_id;
  delete from public.cloud_floors f where f.project_id=zamer_push.project_id;
  insert into public.cloud_floors(project_id,id,ordinal,data) select project_id,(f->>'id')::uuid,(f->>'order')::integer,f from jsonb_array_elements(snapshot->'floors') f;
  foreach k in array array['walls','elements','rooms','dimensions','junctions'] loop
   for e in select value from jsonb_array_elements(snapshot->k) loop
    insert into public.cloud_entities(project_id,id,floor_id,entity_type,data) values(project_id,(e->>'id')::uuid,(e->>'floorId')::uuid,case k when 'walls' then 'wall' when 'rooms' then 'room' when 'dimensions' then 'dimension' when 'junctions' then 'junction' else e->>'kind' end,e);
   end loop;
  end loop;
  insert into public.cloud_defects(project_id,id,floor_id,data) select project_id,(d->>'id')::uuid,(d->>'floorId')::uuid,d from jsonb_array_elements(coalesce(snapshot->'defects','[]'::jsonb)) d;
  insert into public.cloud_photos(project_id,id,floor_id,defect_id,storage_key,checksum,data) select project_id,(p->>'id')::uuid,(p->>'floorId')::uuid,(p->>'defectId')::uuid,p->>'storageKey',p->>'checksum',p from jsonb_array_elements(coalesce(snapshot->'photos','[]'::jsonb)) p;
  insert into public.cloud_versions(project_id,revision,snapshot) values(project_id,next_revision,snapshot);
  response:=jsonb_build_object('type','ack','revision',next_revision);
 end if;
 insert into public.cloud_commands(owner_id,command_id,project_id,request_hash,response) values(uid,command_id,project_id,digest,response);
 return response;
end $$;
revoke all on function public.zamer_push(uuid,uuid,bigint,jsonb) from public,anon;
grant execute on function public.zamer_push(uuid,uuid,bigint,jsonb) to authenticated;
