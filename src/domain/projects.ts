import { floorSchema, projectSchema, type Project, type Floor } from "./model";
export function createProject(
  name: string,
  floorName: string,
  now = new Date().toISOString(),
): { project: Project; floor: Floor } {
  const project = projectSchema.parse({
    id: crypto.randomUUID(),
    name,
    ownerId: null,
    status: "active",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    revision: 0,
  });
  const floor = floorSchema.parse({
    id: crypto.randomUUID(),
    projectId: project.id,
    name: floorName,
    elevation: 0,
    defaultHeight: 2.7,
    order: 0,
  });
  return { project, floor };
}
export function changeStatus(
  project: Project,
  status: Project["status"],
  now = new Date().toISOString(),
): Project {
  return {
    ...project,
    status,
    updatedAt: now,
    deletedAt: status === "trashed" ? now : null,
    revision: project.revision + 1,
  };
}
