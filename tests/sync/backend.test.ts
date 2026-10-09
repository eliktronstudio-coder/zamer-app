import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createProject } from "../../src/domain/projects";
import { uuid, wall } from "../geometry/fixtures";
let pg: PGlite;
const userA = uuid(900),
  userB = uuid(901);
async function account(id: string) {
  await pg.exec(
    `set role authenticated; select set_config('request.jwt.claim.sub','${id}',false);`,
  );
}
async function rpc(
  snapshot: unknown,
  id: string,
  base: number,
  command = crypto.randomUUID(),
) {
  return (
    await pg.query<{
      result: { type: string; revision: number; snapshot: unknown };
    }>("select public.zamer_push($1,$2,$3,$4::jsonb) result", [
      id,
      command,
      base,
      JSON.stringify(snapshot),
    ])
  ).rows[0].result;
}
function payload(ownerId = userA) {
  const { project, floor } = createProject("Замер", "Первый");
  return {
    schemaVersion: 4,
    geometrySchemaVersion: 4,
    exportSchemaVersion: 4,
    project: { ...project, ownerId },
    floors: [floor],
    walls: [wall(1, undefined, undefined, { floorId: floor.id })],
    rooms: [],
    elements: [],
    junctions: [],
    dimensions: [],
  };
}
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(
    `create schema auth; create table auth.users(id uuid primary key);create role authenticated;create role anon;grant usage on schema public,auth to authenticated,anon;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant execute on function auth.uid() to authenticated,anon;insert into auth.users values('${userA}'),('${userB}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);alter table storage.objects enable row level security;grant usage on schema storage to authenticated,anon;grant select,insert,update,delete on storage.objects to authenticated,anon;`,
  );
  for (const name of [
    "0001_initial.sql",
    "0002_cloud_sync.sql",
    "0003_private_storage.sql",
    "0004_defects_photos.sql",
  ])
    await pg.exec(
      await readFile(
        new URL(`../../supabase/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
}, 60000);
afterAll(async () => {
  await pg?.close();
});
describe("PostgreSQL CAS, RLS and private originals", () => {
  it("writes typed entity rows and returns the original ACK for a duplicate command", async () => {
    await account(userA);
    const s = payload(),
      id = crypto.randomUUID();
    expect(await rpc(s, s.project.id, 0, id)).toEqual({
      type: "ack",
      revision: 1,
    });
    expect(await rpc(s, s.project.id, 0, id)).toEqual({
      type: "ack",
      revision: 1,
    });
    const rows = await pg.query<{ entity_type: string }>(
      "select entity_type from public.cloud_entities where project_id=$1",
      [s.project.id],
    );
    expect(rows.rows.map((r) => r.entity_type)).toEqual(["wall"]);
    await expect(
      rpc(
        { ...s, project: { ...s.project, name: "Changed" } },
        s.project.id,
        0,
        id,
      ),
    ).rejects.toThrow("identity reused");
  });
  it("rejects stale revisions without overwriting the current snapshot", async () => {
    await account(userA);
    const s = payload();
    await rpc(s, s.project.id, 0);
    const changed = { ...s, project: { ...s.project, name: "Новая версия" } };
    await rpc(changed, s.project.id, 1);
    const conflict = await rpc(s, s.project.id, 1);
    expect(conflict).toMatchObject({
      type: "conflict",
      revision: 2,
      snapshot: changed,
    });
  });
  it("isolates accounts for both RPC and direct reads and forbids direct writes", async () => {
    await account(userA);
    const s = payload();
    await rpc(s, s.project.id, 0);
    await account(userB);
    expect(
      (
        await pg.query("select * from public.cloud_projects where id=$1", [
          s.project.id,
        ])
      ).rows,
    ).toEqual([]);
    await expect(
      rpc({ ...s, project: { ...s.project, ownerId: userB } }, s.project.id, 1),
    ).rejects.toThrow("unavailable");
    await expect(
      pg.query("update public.cloud_projects set revision=99"),
    ).rejects.toThrow("permission denied");
  });
  it("rejects spoofed owners, cross-floor references and unsupported versions atomically", async () => {
    await account(userA);
    const s = payload();
    await expect(
      rpc({ ...s, project: { ...s.project, ownerId: userB } }, s.project.id, 0),
    ).rejects.toThrow("identity");
    await expect(
      rpc({ ...s, schemaVersion: 99 }, s.project.id, 0),
    ).rejects.toThrow("version");
    await expect(
      rpc(
        { ...s, walls: [{ ...s.walls[0], floorId: uuid(44) }] },
        s.project.id,
        0,
      ),
    ).rejects.toThrow("floor");
    expect(
      (
        await pg.query("select * from public.cloud_projects where id=$1", [
          s.project.id,
        ])
      ).rows,
    ).toEqual([]);
  });
  it("rejects malformed points and numeric strings before writing a project", async () => {
    await account(userA);
    const s = payload();
    for (const wall of [
      { ...s.walls[0], start: {} },
      { ...s.walls[0], height: "2.7" },
    ])
      await expect(
        rpc({ ...s, walls: [wall] }, s.project.id, 0),
      ).rejects.toThrow(/Invalid/);
    expect(
      (
        await pg.query("select id from public.cloud_projects where id=$1", [
          s.project.id,
        ])
      ).rows,
    ).toEqual([]);
  });
  it("persists v5 defect/photo metadata with RLS and rejects another project's file path", async () => {
    await account(userA);
    const s = payload(),
      now = new Date().toISOString(),
      hash = "a".repeat(64),
      photoId = crypto.randomUUID(),
      defectId = crypto.randomUUID();
    const d = {
      id: defectId,
      projectId: s.project.id,
      floorId: s.floors[0].id,
      roomId: null,
      elementId: null,
      type: "Трещина",
      description: "Ремонт",
      status: "open",
      position: { x: 1, y: 2 },
      length: 1,
      width: 0.2,
      depth: null,
      createdAt: now,
      deletedAt: null,
    };
    const p = {
      id: photoId,
      projectId: s.project.id,
      floorId: s.floors[0].id,
      roomId: null,
      elementId: null,
      defectId,
      checksum: hash,
      storageKey: `${s.project.id}/${photoId}/${hash}`,
      size: 100,
      mimeType: "image/png",
      createdAt: now,
      deletedAt: null,
    };
    const v5 = {
      ...s,
      schemaVersion: 5,
      exportSchemaVersion: 5,
      defects: [d],
      photos: [p],
    };
    expect(await rpc(v5, s.project.id, 0)).toEqual({
      type: "ack",
      revision: 1,
    });
    expect(
      (
        await pg.query(
          "select storage_key from public.cloud_photos where project_id=$1",
          [s.project.id],
        )
      ).rows,
    ).toEqual([{ storage_key: p.storageKey }]);
    await expect(
      rpc(
        {
          ...v5,
          photos: [{ ...p, storageKey: `${uuid(22)}/${photoId}/${hash}` }],
        },
        s.project.id,
        1,
      ),
    ).rejects.toThrow("metadata");
    await account(userB);
    expect(
      (
        await pg.query(
          "select * from public.cloud_photos where project_id=$1",
          [s.project.id],
        )
      ).rows,
    ).toEqual([]);
  });
  it("guest role cannot use cloud RPCs", async () => {
    await pg.exec("reset role;set role anon;");
    const s = payload();
    await expect(rpc(s, s.project.id, 0)).rejects.toThrow("permission denied");
  });
  it("allows private original uploads only beneath an owned cloud project and forbids deletion", async () => {
    await account(userA);
    const s = payload();
    await rpc(s, s.project.id, 0);
    await pg.query(
      "insert into storage.objects(bucket_id,name) values($1,$2)",
      ["zamer-originals", `${s.project.id}/original.jpg`],
    );
    await account(userB);
    expect(
      (
        await pg.query("select * from storage.objects where name=$1", [
          `${s.project.id}/original.jpg`,
        ])
      ).rows,
    ).toEqual([]);
    await expect(
      pg.query("insert into storage.objects(bucket_id,name) values($1,$2)", [
        "zamer-originals",
        `${s.project.id}/other.jpg`,
      ]),
    ).rejects.toThrow("row-level security");
    await account(userA);
    expect(
      (
        await pg.query(
          "delete from storage.objects where name=$1 returning *",
          [`${s.project.id}/original.jpg`],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await pg.query("select * from storage.objects where name=$1", [
          `${s.project.id}/original.jpg`,
        ])
      ).rows,
    ).toHaveLength(1);
  });
});
