-- Phase 0 blueprint; apply and integration-test against Supabase in phase 7.
-- auth.users is supplied by Supabase. No credentials or admin elevation here.
create table public.projects (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id),
 name text not null check (length(trim(name)) between 1 and 160),
 status text not null default 'active' check (status in ('active','archived','trashed')),
 revision bigint not null default 0 check (revision >= 0), schema_version integer not null default 1,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz
);
create table public.floors (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade,
 name text not null, elevation double precision not null default 0, default_height double precision not null check(default_height>0),
 ordinal integer not null check(ordinal>=0), unique(project_id,id), unique(project_id,ordinal)
);
create table public.rooms (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade,
 floor_id uuid not null, name text not null default '', height double precision check(height>0),
 geometrically_closed boolean not null default false,
 status text not null check(status in ('notStarted','inProgress','issues','completed','completedWithNotes')),
 boundary jsonb not null default '[]', holes jsonb not null default '[]',
 unique(project_id,id), foreign key(project_id,floor_id) references public.floors(project_id,id) on delete cascade
);
create table public.geometry_elements (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade,
 floor_id uuid not null, kind text not null check(kind in ('wall','opening','column','beam','stair','ramp','levelChange','dimension')),
 geometry_schema_version integer not null default 1, metadata jsonb not null default '{}',
 unique(project_id,id), foreign key(project_id,floor_id) references public.floors(project_id,id) on delete cascade
);
create table public.room_elements (
 project_id uuid not null, room_id uuid not null, element_id uuid not null, primary key(room_id,element_id),
 foreign key(project_id,room_id) references public.rooms(project_id,id) on delete cascade,
 foreign key(project_id,element_id) references public.geometry_elements(project_id,id) on delete cascade
);
create table public.walls (
 id uuid primary key, project_id uuid not null, unique(project_id,id),
 foreign key(project_id,id) references public.geometry_elements(project_id,id) on delete cascade,
 start_x double precision not null, start_y double precision not null, end_x double precision not null, end_y double precision not null,
 measured_length double precision check(measured_length>0), thickness double precision not null check(thickness>0), height double precision not null check(height>0)
);
create table public.openings (
 id uuid primary key, project_id uuid not null, unique(project_id,id),
 foreign key(project_id,id) references public.geometry_elements(project_id,id) on delete cascade,
 wall_id uuid not null, opening_type text not null check(opening_type in ('window','door','void')),
 offset_m double precision not null, width double precision not null check(width>0), height double precision not null check(height>0), sill double precision not null,
 side text not null check(side in ('left','right')), foreign key(project_id,wall_id) references public.walls(project_id,id) on delete cascade
);
create table public.columns (
 id uuid primary key, project_id uuid not null, unique(project_id,id),
 foreign key(project_id,id) references public.geometry_elements(project_id,id) on delete cascade,
 x double precision not null, y double precision not null, rotation double precision not null,
 section jsonb not null, height double precision not null check(height>0), material text not null
);
create table public.beams (
 id uuid primary key, project_id uuid not null, unique(project_id,id),
 foreign key(project_id,id) references public.geometry_elements(project_id,id) on delete cascade,
 start_x double precision not null, start_y double precision not null, end_x double precision not null, end_y double precision not null,
 width double precision not null check(width>0), height double precision not null check(height>0), elevation double precision not null, material text not null
);
create table public.stairs (
 id uuid primary key, project_id uuid not null, unique(project_id,id),
 foreign key(project_id,id) references public.geometry_elements(project_id,id) on delete cascade,
 x double precision not null, y double precision not null, rotation double precision not null, width double precision not null check(width>0),
 length double precision not null check(length>0), rise double precision not null, steps integer not null check(steps>0)
);
create table public.ramps (
 id uuid primary key, project_id uuid not null, unique(project_id,id),
 foreign key(project_id,id) references public.geometry_elements(project_id,id) on delete cascade,
 x double precision not null, y double precision not null, rotation double precision not null, width double precision not null check(width>0),
 length double precision not null check(length>0), rise double precision not null
);
create table public.level_changes (
 id uuid primary key, project_id uuid not null, unique(project_id,id),
 foreign key(project_id,id) references public.geometry_elements(project_id,id) on delete cascade,
 boundary jsonb not null, from_elevation double precision not null, to_elevation double precision not null
);
create table public.dimensions (
 id uuid primary key, project_id uuid not null, unique(project_id,id),
 foreign key(project_id,id) references public.geometry_elements(project_id,id) on delete cascade,
 mode text not null check(mode in ('driving','reference')), from_element_id uuid not null, from_anchor text not null check(from_anchor in ('start','end','center')),
 to_element_id uuid not null, to_anchor text not null check(to_anchor in ('start','end','center')), offset_m double precision not null, input_value double precision check(input_value>0),
 foreign key(project_id,from_element_id) references public.geometry_elements(project_id,id), foreign key(project_id,to_element_id) references public.geometry_elements(project_id,id)
);
create table public.defects (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade, unique(project_id,id),
 floor_id uuid, room_id uuid, element_id uuid,
 foreign key(project_id,floor_id) references public.floors(project_id,id),
 foreign key(project_id,room_id) references public.rooms(project_id,id),
 foreign key(project_id,element_id) references public.geometry_elements(project_id,id), type text not null, description text not null, position jsonb, status text not null check(status in ('open','resolved'))
);
create table public.photos (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade, unique(project_id,id),
 floor_id uuid, room_id uuid, element_id uuid,
 foreign key(project_id,floor_id) references public.floors(project_id,id),
 foreign key(project_id,room_id) references public.rooms(project_id,id),
 foreign key(project_id,element_id) references public.geometry_elements(project_id,id), defect_id uuid, storage_key text not null, original_name text not null, mime_type text not null, byte_size bigint not null check(byte_size>0),
 created_at timestamptz not null default now(), foreign key(project_id,defect_id) references public.defects(project_id,id)
);
create table public.work_items (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade, unique(project_id,id),
 name text not null, quantity_key text not null, unit text not null check(unit in ('m','m2','m3','pcs'))
);
create table public.estimate_items (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade, unique(project_id,id),
 work_item_id uuid not null, unit_price_kopecks bigint check(unit_price_kopecks>=0), foreign key(project_id,work_item_id) references public.work_items(project_id,id)
);
create table public.documents (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade, unique(project_id,id),
 type text not null check(type in ('report','defects','estimate')), source_revision bigint not null, storage_key text
);
create table public.issues (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade, unique(project_id,id),
 floor_id uuid, room_id uuid, element_id uuid,
 foreign key(project_id,floor_id) references public.floors(project_id,id),
 foreign key(project_id,room_id) references public.rooms(project_id,id),
 foreign key(project_id,element_id) references public.geometry_elements(project_id,id), rule_id text not null, severity text not null check(severity in ('info','warning','error')), description text not null, suggested_command_id uuid
);
create table public.project_versions (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade, unique(project_id,id),
 revision bigint not null, snapshot_key text not null, created_at timestamptz not null default now(), unique(project_id,revision)
);
create table public.sync_metadata (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade, unique(project_id,id),
 base_revision bigint not null, local_revision bigint not null, state text not null check(state in ('local','pending','synced','conflict')), updated_at timestamptz not null default now()
);
create table public.work_sources (
 id uuid primary key default gen_random_uuid(), project_id uuid not null, work_item_id uuid not null,
 element_id uuid, defect_id uuid, check ((element_id is null) <> (defect_id is null)),
 foreign key(project_id,work_item_id) references public.work_items(project_id,id) on delete cascade,
 foreign key(project_id,element_id) references public.geometry_elements(project_id,id),
 foreign key(project_id,defect_id) references public.defects(project_id,id)
);
create table public.user_settings (
 id uuid primary key default gen_random_uuid(), user_id uuid not null unique references auth.users(id) on delete cascade,
 units text not null default 'metric' check(units='metric'), shortcuts jsonb not null default '{}', defaults jsonb not null default '{}'
);
alter table public.projects enable row level security;
create policy project_owner on public.projects for all to authenticated using(owner_id=auth.uid()) with check(owner_id=auth.uid());
alter table public.user_settings enable row level security;
create policy settings_owner on public.user_settings for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
create index floors_project_idx on public.floors(project_id);
alter table public.floors enable row level security;
create policy floors_owner on public.floors for all to authenticated
 using (exists (select 1 from public.projects p where p.id = floors.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = floors.project_id and p.owner_id = auth.uid()));
create index rooms_project_idx on public.rooms(project_id);
alter table public.rooms enable row level security;
create policy rooms_owner on public.rooms for all to authenticated
 using (exists (select 1 from public.projects p where p.id = rooms.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = rooms.project_id and p.owner_id = auth.uid()));
create index geometry_elements_project_idx on public.geometry_elements(project_id);
alter table public.geometry_elements enable row level security;
create policy geometry_elements_owner on public.geometry_elements for all to authenticated
 using (exists (select 1 from public.projects p where p.id = geometry_elements.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = geometry_elements.project_id and p.owner_id = auth.uid()));
create index room_elements_project_idx on public.room_elements(project_id);
alter table public.room_elements enable row level security;
create policy room_elements_owner on public.room_elements for all to authenticated
 using (exists (select 1 from public.projects p where p.id = room_elements.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = room_elements.project_id and p.owner_id = auth.uid()));
create index walls_project_idx on public.walls(project_id);
alter table public.walls enable row level security;
create policy walls_owner on public.walls for all to authenticated
 using (exists (select 1 from public.projects p where p.id = walls.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = walls.project_id and p.owner_id = auth.uid()));
create index openings_project_idx on public.openings(project_id);
alter table public.openings enable row level security;
create policy openings_owner on public.openings for all to authenticated
 using (exists (select 1 from public.projects p where p.id = openings.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = openings.project_id and p.owner_id = auth.uid()));
create index columns_project_idx on public.columns(project_id);
alter table public.columns enable row level security;
create policy columns_owner on public.columns for all to authenticated
 using (exists (select 1 from public.projects p where p.id = columns.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = columns.project_id and p.owner_id = auth.uid()));
create index beams_project_idx on public.beams(project_id);
alter table public.beams enable row level security;
create policy beams_owner on public.beams for all to authenticated
 using (exists (select 1 from public.projects p where p.id = beams.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = beams.project_id and p.owner_id = auth.uid()));
create index stairs_project_idx on public.stairs(project_id);
alter table public.stairs enable row level security;
create policy stairs_owner on public.stairs for all to authenticated
 using (exists (select 1 from public.projects p where p.id = stairs.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = stairs.project_id and p.owner_id = auth.uid()));
create index ramps_project_idx on public.ramps(project_id);
alter table public.ramps enable row level security;
create policy ramps_owner on public.ramps for all to authenticated
 using (exists (select 1 from public.projects p where p.id = ramps.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = ramps.project_id and p.owner_id = auth.uid()));
create index level_changes_project_idx on public.level_changes(project_id);
alter table public.level_changes enable row level security;
create policy level_changes_owner on public.level_changes for all to authenticated
 using (exists (select 1 from public.projects p where p.id = level_changes.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = level_changes.project_id and p.owner_id = auth.uid()));
create index dimensions_project_idx on public.dimensions(project_id);
alter table public.dimensions enable row level security;
create policy dimensions_owner on public.dimensions for all to authenticated
 using (exists (select 1 from public.projects p where p.id = dimensions.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = dimensions.project_id and p.owner_id = auth.uid()));
create index defects_project_idx on public.defects(project_id);
alter table public.defects enable row level security;
create policy defects_owner on public.defects for all to authenticated
 using (exists (select 1 from public.projects p where p.id = defects.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = defects.project_id and p.owner_id = auth.uid()));
create index photos_project_idx on public.photos(project_id);
alter table public.photos enable row level security;
create policy photos_owner on public.photos for all to authenticated
 using (exists (select 1 from public.projects p where p.id = photos.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = photos.project_id and p.owner_id = auth.uid()));
create index work_items_project_idx on public.work_items(project_id);
alter table public.work_items enable row level security;
create policy work_items_owner on public.work_items for all to authenticated
 using (exists (select 1 from public.projects p where p.id = work_items.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = work_items.project_id and p.owner_id = auth.uid()));
create index estimate_items_project_idx on public.estimate_items(project_id);
alter table public.estimate_items enable row level security;
create policy estimate_items_owner on public.estimate_items for all to authenticated
 using (exists (select 1 from public.projects p where p.id = estimate_items.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = estimate_items.project_id and p.owner_id = auth.uid()));
create index documents_project_idx on public.documents(project_id);
alter table public.documents enable row level security;
create policy documents_owner on public.documents for all to authenticated
 using (exists (select 1 from public.projects p where p.id = documents.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = documents.project_id and p.owner_id = auth.uid()));
create index issues_project_idx on public.issues(project_id);
alter table public.issues enable row level security;
create policy issues_owner on public.issues for all to authenticated
 using (exists (select 1 from public.projects p where p.id = issues.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = issues.project_id and p.owner_id = auth.uid()));
create index project_versions_project_idx on public.project_versions(project_id);
alter table public.project_versions enable row level security;
create policy project_versions_owner on public.project_versions for all to authenticated
 using (exists (select 1 from public.projects p where p.id = project_versions.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = project_versions.project_id and p.owner_id = auth.uid()));
create index sync_metadata_project_idx on public.sync_metadata(project_id);
alter table public.sync_metadata enable row level security;
create policy sync_metadata_owner on public.sync_metadata for all to authenticated
 using (exists (select 1 from public.projects p where p.id = sync_metadata.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = sync_metadata.project_id and p.owner_id = auth.uid()));
create index work_sources_project_idx on public.work_sources(project_id);
alter table public.work_sources enable row level security;
create policy work_sources_owner on public.work_sources for all to authenticated
 using (exists (select 1 from public.projects p where p.id = work_sources.project_id and p.owner_id = auth.uid()))
 with check (exists (select 1 from public.projects p where p.id = work_sources.project_id and p.owner_id = auth.uid()));
-- Before phase 7 deployment: subtype-kind and same-floor constraints/triggers,
-- finite geometry validation, revision CAS RPC with idempotency, grants, auth rate limits,
-- private Storage policies, tombstone lifecycle, admin audit and integration/RLS tests.
-- JSON fields are typed section/contour payloads, never a sole opaque project source.
