import { z } from "zod";
export const SCHEMA_VERSION = 5 as const;
export const idSchema = z.uuid();
export const pointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type Point = z.infer<typeof pointSchema>;
export const projectSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(160),
  ownerId: idSchema.nullable(),
  status: z.enum(["active", "archived", "trashed"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
  revision: z.number().int().nonnegative(),
});
export const floorSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  name: z.string().trim().min(1).max(80),
  elevation: z.number().finite(),
  defaultHeight: z.number().positive(),
  order: z.number().int().nonnegative(),
});
export type Project = z.infer<typeof projectSchema>;
export type Floor = z.infer<typeof floorSchema>;
const base = {
  id: idSchema,
  floorId: idSchema,
  roomIds: z.array(idSchema),
  metadata: z.record(z.string(), z.string()),
};
export const wallSchema = z.object({
  ...base,
  kind: z.literal("wall"),
  start: pointSchema,
  end: pointSchema,
  measuredLength: z.number().positive().nullable(),
  thickness: z.number().positive(),
  height: z.number().positive(),
});
export type Wall = z.infer<typeof wallSchema>;
export type ColumnSection =
  | { kind: "circle"; diameter: number }
  | { kind: "ellipse"; width: number; depth: number }
  | { kind: "rectangle"; width: number; depth: number }
  | {
      kind: "profile";
      profile: "L" | "T" | "cross" | "H" | "U" | "box";
      width: number;
      depth: number;
      web: number;
      flange: number;
    }
  | { kind: "polygon"; vertices: Point[] }
  | {
      kind: "composite";
      parts: { section: ColumnSection; position: Point; rotation: number }[];
    };
export interface ElementBase {
  id: string;
  floorId: string;
  roomIds: string[];
  metadata: Record<string, string>;
}
const positive = z.number().finite().positive();
export const sectionSchema: z.ZodType<ColumnSection> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("circle"), diameter: positive }),
    z.object({ kind: z.literal("ellipse"), width: positive, depth: positive }),
    z.object({
      kind: z.literal("rectangle"),
      width: positive,
      depth: positive,
    }),
    z.object({
      kind: z.literal("profile"),
      profile: z.enum(["L", "T", "cross", "H", "U", "box"]),
      width: positive,
      depth: positive,
      web: positive,
      flange: positive,
    }),
    z.object({
      kind: z.literal("polygon"),
      vertices: z.array(pointSchema).min(3).max(200),
    }),
    z.object({
      kind: z.literal("composite"),
      parts: z
        .array(
          z.object({
            section: sectionSchema,
            position: pointSchema,
            rotation: z.number().finite(),
          }),
        )
        .min(1)
        .max(20),
    }),
  ]),
);
export const openingSchema = z.object({
  ...base,
  kind: z.literal("opening"),
  type: z.enum(["window", "door", "void"]),
  wallId: idSchema,
  offset: z.number().finite().nonnegative(),
  width: positive,
  height: positive,
  sill: z.number().finite().nonnegative(),
  side: z.enum(["left", "right"]),
  revealDepth: z.number().finite().nonnegative().optional(),
});
export const columnSchema = z.object({
  ...base,
  kind: z.literal("column"),
  position: pointSchema,
  rotation: z.number().finite(),
  section: sectionSchema,
  height: positive,
  material: z.string().trim().min(1).max(80),
});
export const beamSchema = z.object({
  ...base,
  kind: z.literal("beam"),
  start: pointSchema,
  end: pointSchema,
  width: positive,
  height: positive,
  elevation: z.number().finite(),
  material: z.string().trim().min(1).max(80),
});
export const stairSchema = z.object({
  ...base,
  kind: z.literal("stair"),
  position: pointSchema,
  rotation: z.number().finite(),
  width: positive,
  length: positive,
  rise: positive,
  steps: z.number().int().min(1).max(500),
});
export const rampSchema = z.object({
  ...base,
  kind: z.literal("ramp"),
  position: pointSchema,
  rotation: z.number().finite(),
  width: positive,
  length: positive,
  rise: z.number().finite(),
});
export const levelChangeSchema = z.object({
  ...base,
  kind: z.literal("levelChange"),
  boundary: z.array(pointSchema).min(2).max(200),
  fromElevation: z.number().finite(),
  toElevation: z.number().finite(),
});
export const constructionElementSchema = z.discriminatedUnion("kind", [
  openingSchema,
  columnSchema,
  beamSchema,
  stairSchema,
  rampSchema,
  levelChangeSchema,
]);
export type Opening = z.infer<typeof openingSchema>;
export type Column = z.infer<typeof columnSchema>;
export type Beam = z.infer<typeof beamSchema>;
export type Stair = z.infer<typeof stairSchema>;
export type Ramp = z.infer<typeof rampSchema>;
export type LevelChange = z.infer<typeof levelChangeSchema>;
export type ConstructionElement = z.infer<typeof constructionElementSchema>;
export type GeometryElement =
  Wall | Opening | Column | Beam | Stair | Ramp | LevelChange;
export const pointReferenceSchema = z.object({
  elementId: idSchema,
  anchor: z.enum(["start", "end", "center"]),
});
export type PointReference = z.infer<typeof pointReferenceSchema>;
export const endpointReferenceSchema = pointReferenceSchema.extend({
  anchor: z.enum(["start", "end"]),
});
export type EndpointReference = z.infer<typeof endpointReferenceSchema>;
// Junctions contain only explicit endpoint relationships; wall endpoints own coordinates.
export const junctionSchema = z.object({
  id: idSchema,
  floorId: idSchema,
  endpoints: z.array(endpointReferenceSchema).min(2),
});
export type Junction = z.infer<typeof junctionSchema>;
export const dimensionSchema = z.object({
  ...base,
  kind: z.literal("dimension"),
  mode: z.enum(["driving", "reference"]),
  from: pointReferenceSchema,
  to: pointReferenceSchema,
  offset: z.number().finite(),
  inputValue: z.number().positive().nullable(),
});
export type Dimension = z.infer<typeof dimensionSchema>;
export const roomEdgeSchema = z.object({
  wallId: idSchema,
  from: z.number().finite().min(0).max(1),
  to: z.number().finite().min(0).max(1),
});
export type RoomEdge = z.infer<typeof roomEdgeSchema>;
export const roomSchema = z.object({
  id: idSchema,
  floorId: idSchema,
  name: z.string().trim().max(80),
  sourceKey: z.string().min(1),
  wallIds: z.array(idSchema),
  boundary: z.array(pointSchema),
  holes: z.array(z.array(pointSchema)),
  edges: z.array(z.array(roomEdgeSchema)),
  height: z.number().finite().positive().nullable(),
  geometricallyClosed: z.boolean(),
  status: z.enum([
    "notStarted",
    "inProgress",
    "issues",
    "completed",
    "completedWithNotes",
  ]),
});
export type Room = z.infer<typeof roomSchema>;
export interface Binding {
  projectId: string;
  floorId: string | null;
  roomId: string | null;
  elementId: string | null;
}
const bindingSchema = z.object({
  projectId: idSchema,
  floorId: idSchema.nullable(),
  roomId: idSchema.nullable(),
  elementId: idSchema.nullable(),
});
export const defectSchema = bindingSchema.extend({
  id: idSchema,
  type: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(4000),
  position: pointSchema.nullable(),
  boundary: z.array(pointSchema).max(200),
  surface: z.string().trim().max(80),
  length: positive.nullable(),
  width: positive.nullable(),
  depth: positive.nullable(),
  comment: z.string().max(4000),
  recommendedWork: z.string().trim().max(500),
  status: z.enum(["open", "resolved"]),
  revision: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});
export type Defect = z.infer<typeof defectSchema>;
export const photoSchema = bindingSchema.extend({
  id: idSchema,
  defectId: idSchema.nullable(),
  storageKey: z.string().min(1).max(500),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  originalName: z.string().min(1).max(255),
  mimeType: z.enum([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
  ]),
  size: z.number().int().positive().max(52428800),
  caption: z.string().max(1000),
  createdAt: z.iso.datetime(),
  sourceModifiedAt: z.number().int().nonnegative(),
  deletedAt: z.iso.datetime().nullable(),
});
export type Photo = z.infer<typeof photoSchema>;
export interface WorkItem {
  id: string;
  projectId: string;
  sourceIds: string[];
  quantityKey: string;
  unit: "m" | "m2" | "m3" | "pcs";
  name: string;
}
export interface EstimateItem {
  id: string;
  projectId: string;
  workItemId: string;
  unitPriceKopecks: number | null;
}
export interface Document {
  id: string;
  projectId: string;
  type: "report" | "defects" | "estimate";
  sourceRevision: number;
  storageKey: string | null;
}
export interface Issue extends Binding {
  id: string;
  ruleId: string;
  severity: "info" | "warning" | "error";
  description: string;
  suggestedCommandId: string | null;
}
export interface User {
  id: string;
  role: "user" | "admin";
}
export interface UserSettings {
  id: string;
  userId: string | null;
  units: "metric";
  shortcuts: Record<string, string>;
  defaults: { height: number; thickness: number };
}
export interface SyncMetadata {
  id: string;
  projectId: string;
  baseRevision: number;
  localRevision: number;
  state: "local" | "pending" | "synced" | "conflict";
  updatedAt: string;
}
export interface ProjectVersion {
  id: string;
  projectId: string;
  revision: number;
  createdAt: string;
  snapshotKey: string;
}
const snapshotBase = {
  project: projectSchema,
  floors: z.array(floorSchema),
  walls: z.array(wallSchema),
};
export const snapshotV1Schema = z
  .object({
    ...snapshotBase,
    schemaVersion: z.literal(1),
    geometrySchemaVersion: z.literal(1),
    exportSchemaVersion: z.literal(1),
  })
  .strict();
export const snapshotV2Schema = z
  .object({
    ...snapshotBase,
    schemaVersion: z.literal(2),
    geometrySchemaVersion: z.literal(2),
    exportSchemaVersion: z.literal(2),
    junctions: z.array(junctionSchema),
    dimensions: z.array(dimensionSchema),
  })
  .strict();
export const snapshotV3Schema = snapshotV2Schema
  .extend({
    schemaVersion: z.literal(3),
    geometrySchemaVersion: z.literal(3),
    exportSchemaVersion: z.literal(3),
    elements: z.array(constructionElementSchema),
  })
  .strict();
export const snapshotV4Schema = snapshotV3Schema
  .extend({
    schemaVersion: z.literal(4),
    geometrySchemaVersion: z.literal(4),
    exportSchemaVersion: z.literal(4),
    rooms: z.array(roomSchema),
  })
  .strict();
export const snapshotSchema = snapshotV4Schema
  .extend({
    schemaVersion: z.literal(SCHEMA_VERSION),
    exportSchemaVersion: z.literal(5),
    defects: z.array(defectSchema),
    photos: z.array(photoSchema),
  })
  .strict();
export type ProjectSnapshot = z.infer<typeof snapshotSchema>;
