-- Phase 7 transport. Current data is stored as project metadata, floor rows,
-- and individually keyed typed entity rows. Full snapshots are immutable backups.
create table public.cloud_projects (
 id uuid primary key, owner_id uuid not null references auth.users(id), revision bigint not null check(revision>0),
 project_data jsonb not null, updated_at timestamptz not null default now()
);
create table public.cloud_floors (
 project_id uuid not null references public.cloud_projects(id) on delete cascade,
 id uuid not null, ordinal integer not null check(ordinal>=0), data jsonb not null,
 primary key(project_id,id),unique(project_id,ordinal)
);
create table public.cloud_entities (
 project_id uuid not null, id uuid not null, floor_id uuid not null,
 entity_type text not null check(entity_type in ('wall','room','junction','dimension','column','opening','beam','stair','ramp','levelChange')),
 data jsonb not null, primary key(project_id,id),
 foreign key(project_id,floor_id) references public.cloud_floors(project_id,id) on delete cascade
);
create table public.cloud_versions (
 project_id uuid not null references public.cloud_projects(id) on delete cascade,
 revision bigint not null, snapshot jsonb not null, created_at timestamptz not null default now(),primary key(project_id,revision)
);
create table public.cloud_commands (
 owner_id uuid not null references auth.users(id), command_id uuid not null, project_id uuid not null,
 request_hash text not null, response jsonb not null,primary key(owner_id,command_id)
);
alter table public.cloud_projects enable row level security;
alter table public.cloud_floors enable row level security;
alter table public.cloud_entities enable row level security;
alter table public.cloud_versions enable row level security;
alter table public.cloud_commands enable row level security;
create policy cloud_projects_read on public.cloud_projects for select to authenticated using(owner_id=auth.uid());
create policy cloud_commands_read on public.cloud_commands for select to authenticated using(owner_id=auth.uid());
create policy cloud_floors_read on public.cloud_floors for select to authenticated using(exists(select 1 from public.cloud_projects p where p.id=project_id and p.owner_id=auth.uid()));
create policy cloud_entities_read on public.cloud_entities for select to authenticated using(exists(select 1 from public.cloud_projects p where p.id=project_id and p.owner_id=auth.uid()));
create policy cloud_versions_read on public.cloud_versions for select to authenticated using(exists(select 1 from public.cloud_projects p where p.id=project_id and p.owner_id=auth.uid()));
revoke all on public.cloud_projects,public.cloud_floors,public.cloud_entities,public.cloud_versions,public.cloud_commands from anon,authenticated;
grant select on public.cloud_projects,public.cloud_floors,public.cloud_entities,public.cloud_versions,public.cloud_commands to authenticated;

-- Structural point validation also rejects numeric strings and missing coordinates.
create function public.zamer_valid_point(p jsonb) returns boolean language sql immutable set search_path='' as $$
 select coalesce(jsonb_typeof(p)='object' and jsonb_typeof(p->'x')='number' and jsonb_typeof(p->'y')='number',false);
$$;
revoke all on function public.zamer_valid_point(jsonb) from public,anon,authenticated;

create function public.zamer_validate_snapshot(s jsonb, pid uuid, uid uuid) returns void language plpgsql set search_path='' as $$
declare k text; row_data jsonb; entity jsonb; ids text[]; v jsonb; kind text; field text;
begin
 if s->>'schemaVersion' is distinct from '4' or s->>'geometrySchemaVersion' is distinct from '4' or s->>'exportSchemaVersion' is distinct from '4' then raise exception 'Unsupported snapshot version'; end if;
 if (s->'project'->>'id')::uuid is distinct from pid or (s->'project'->>'ownerId')::uuid is distinct from uid then raise exception 'Invalid project identity';end if;
 if not coalesce(length(trim(s->'project'->>'name')) between 1 and 160,false) or not coalesce(s->'project'->>'status' in ('active','archived','trashed'),false) then raise exception 'Invalid project metadata';end if;
 if not coalesce((s->'project'->>'revision')::bigint>=0,false) then raise exception 'Invalid local revision';end if;
 perform (s->'project'->>'createdAt')::timestamptz,(s->'project'->>'updatedAt')::timestamptz;
 if jsonb_typeof(s->'floors') is distinct from 'array' or jsonb_array_length(s->'floors')=0 then raise exception 'Project needs a floor';end if;
 ids:=array[pid::text];
 foreach k in array array['floors','walls','elements','rooms','dimensions','junctions'] loop
  if jsonb_typeof(s->k) is distinct from 'array' or jsonb_array_length(s->k)>10000 then raise exception 'Invalid entity collection';end if;
  for row_data in select value from jsonb_array_elements(s->k) loop
   if row_data->>'id' is null or (row_data->>'id')::uuid::text=any(ids) then raise exception 'Duplicate or missing identity';end if;
   ids:=array_append(ids,(row_data->>'id')::uuid::text);
   -- JSON numbers cannot carry NaN; bound numeric magnitudes before double conversion.
   for v in select jsonb_path_query(row_data,'$.** ? (@.type() == "number")') loop
    if abs(v::text::numeric)>1e100 then raise exception 'Numeric magnitude out of range';end if;
   end loop;
   -- Require JSON numeric fields rather than accepting castable strings.
   foreach field in array array['revision','elevation','defaultHeight','order','height','thickness','width','length','rise','steps','offset','sill','rotation','fromElevation','toElevation','revealDepth'] loop
    if row_data ? field and row_data->field<>'null'::jsonb and jsonb_typeof(row_data->field)<>'number' then raise exception 'Invalid numeric field';end if;
   end loop;
   foreach field in array array['start','end','position'] loop
    if row_data ? field and not public.zamer_valid_point(row_data->field) then raise exception 'Invalid point';end if;
   end loop;
   if k='floors' then
    if (row_data->>'projectId')::uuid is distinct from pid or not coalesce(length(trim(row_data->>'name')) between 1 and 80,false) or not coalesce((row_data->>'defaultHeight')::numeric>0,false) or not coalesce((row_data->>'order')::integer>=0,false) then raise exception 'Invalid floor';end if;
   else
    if not exists(select 1 from jsonb_array_elements(s->'floors') f where f->>'id'=row_data->>'floorId') then raise exception 'Missing floor';end if;
    if k='walls' and (row_data->>'kind' is distinct from 'wall' or not coalesce((row_data->>'height')::numeric>0 and (row_data->>'thickness')::numeric>0,false) or row_data->'start' is null or row_data->'end' is null) then raise exception 'Invalid wall';end if;
    if k='elements' then
     kind:=row_data->>'kind';
     if not coalesce(kind in ('opening','column','beam','stair','ramp','levelChange'),false) then raise exception 'Invalid element kind';end if;
     if kind='opening' then
      if not coalesce((row_data->>'width')::numeric>0 and (row_data->>'height')::numeric>0 and (row_data->>'offset')::numeric>=0 and (row_data->>'sill')::numeric>=0 and row_data->>'type' in ('window','door','void') and row_data->>'side' in ('left','right'),false) then raise exception 'Invalid opening';end if;
      if not exists(select 1 from jsonb_array_elements(s->'walls') w where w->>'id'=row_data->>'wallId' and w->>'floorId'=row_data->>'floorId') then raise exception 'Missing opening wall';end if;
     end if;
     if kind in ('column','beam') and not coalesce((row_data->>'height')::numeric>0,false) then raise exception 'Invalid height';end if;
     if kind in ('beam','stair','ramp') and not coalesce((row_data->>'width')::numeric>0,false) then raise exception 'Invalid width';end if;
     if kind in ('stair','ramp') and not coalesce((row_data->>'length')::numeric>0,false) then raise exception 'Invalid length';end if;
     if kind='stair' and not coalesce((row_data->>'rise')::numeric>0 and (row_data->>'steps')::integer between 1 and 500,false) then raise exception 'Invalid stair';end if;
    end if;
    if k in ('walls','elements','dimensions') and (jsonb_typeof(row_data->'roomIds') is distinct from 'array' or jsonb_typeof(row_data->'metadata') is distinct from 'object') then raise exception 'Invalid entity metadata';end if;
    if k='dimensions' then
     if row_data->>'kind' is distinct from 'dimension' or not coalesce(row_data->>'mode' in ('driving','reference'),false) then raise exception 'Invalid dimension';end if;
     foreach kind in array array['from','to'] loop
      if not coalesce(row_data->kind->>'anchor' in ('start','end','center'),false) then raise exception 'Invalid dimension anchor';end if;
      if not exists(select 1 from jsonb_array_elements(s->'walls') w where w->>'id'=row_data->kind->>'elementId' and w->>'floorId'=row_data->>'floorId') then raise exception 'Missing dimension reference';end if;
     end loop;
    end if;
    if k='junctions' then
     if jsonb_typeof(row_data->'endpoints') is distinct from 'array' or jsonb_array_length(row_data->'endpoints')<2 then raise exception 'Invalid junction';end if;
     for entity in select value from jsonb_array_elements(row_data->'endpoints') loop
      if not coalesce(entity->>'anchor' in ('start','end'),false) then raise exception 'Invalid junction anchor';end if;
      if not exists(select 1 from jsonb_array_elements(s->'walls') w where w->>'id'=entity->>'elementId' and w->>'floorId'=row_data->>'floorId') then raise exception 'Missing junction reference';end if;
     end loop;
    end if;
    if k='rooms' and (row_data->>'geometricallyClosed')::boolean then
     for entity in select value from jsonb_array_elements(row_data->'wallIds') loop
      if not exists(select 1 from jsonb_array_elements(s->'walls') w where w->>'id'=entity#>>'{}' and w->>'floorId'=row_data->>'floorId') then raise exception 'Missing room wall';end if;
     end loop;
    end if;
    if k in ('walls','elements','dimensions') then
     for entity in select value from jsonb_array_elements(row_data->'roomIds') loop
      if not exists(select 1 from jsonb_array_elements(s->'rooms') r where r->>'id'=entity#>>'{}' and r->>'floorId'=row_data->>'floorId') then raise exception 'Missing room binding';end if;
     end loop;
    end if;
   end if;
  end loop;
 end loop;
end $$;
revoke all on function public.zamer_validate_snapshot(jsonb,uuid,uuid) from public,anon,authenticated;

create function public.zamer_push(project_id uuid,command_id uuid,base_revision bigint,snapshot jsonb) returns jsonb
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
  delete from public.cloud_floors f where f.project_id=zamer_push.project_id;
  insert into public.cloud_floors(project_id,id,ordinal,data) select project_id,(f->>'id')::uuid,(f->>'order')::integer,f from jsonb_array_elements(snapshot->'floors') f;
  foreach k in array array['walls','elements','rooms','dimensions','junctions'] loop
   for e in select value from jsonb_array_elements(snapshot->k) loop
    insert into public.cloud_entities(project_id,id,floor_id,entity_type,data) values(project_id,(e->>'id')::uuid,(e->>'floorId')::uuid,case k when 'walls' then 'wall' when 'rooms' then 'room' when 'dimensions' then 'dimension' when 'junctions' then 'junction' else e->>'kind' end,e);
   end loop;
  end loop;
  insert into public.cloud_versions(project_id,revision,snapshot) values(project_id,next_revision,snapshot);
  response:=jsonb_build_object('type','ack','revision',next_revision);
 end if;
 insert into public.cloud_commands(owner_id,command_id,project_id,request_hash,response) values(uid,command_id,project_id,digest,response);
 return response;
end $$;
revoke all on function public.zamer_push(uuid,uuid,bigint,jsonb) from public,anon;
grant execute on function public.zamer_push(uuid,uuid,bigint,jsonb) to authenticated;
create function public.zamer_list() returns jsonb language sql security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('revision',p.revision,'snapshot',v.snapshot)),'[]'::jsonb)
 from public.cloud_projects p join public.cloud_versions v on v.project_id=p.id and v.revision=p.revision where p.owner_id=auth.uid();
$$;
revoke all on function public.zamer_list() from public,anon;
grant execute on function public.zamer_list() to authenticated;
