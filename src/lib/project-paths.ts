import { isAbsolute, relative, resolve, sep } from "node:path";

import { assertProjectId, type ProjectId } from "./workspace";

function assertSafePathSegment(segment: string, label: string): void {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    isAbsolute(segment) ||
    segment.includes("/") ||
    segment.includes("\\")
  ) {
    throw new TypeError(`Invalid ${label}: ${segment}`);
  }
}

function resolveUnder(root: string, ...segments: string[]): string {
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, ...segments);
  const relativePath = relative(absoluteRoot, candidate);

  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Resolved path escapes its root: ${candidate}`);
  }

  return candidate;
}

export function workspaceRoot(cwd: string): string {
  return resolveUnder(resolve(cwd), ".vibescreens");
}

export function projectRoot(cwd: string, projectId: ProjectId): string {
  assertProjectId(projectId);
  const projectsRoot = resolveUnder(workspaceRoot(cwd), "projects");
  return resolveUnder(projectsRoot, projectId);
}

export function projectDocumentPath(cwd: string, projectId: ProjectId): string {
  return resolveUnder(projectRoot(cwd, projectId), "vibescreens.json");
}

export function projectTrashPath(
  cwd: string,
  projectId: ProjectId,
  timestamp: string,
): string {
  assertProjectId(projectId);
  assertSafePathSegment(timestamp, "trash timestamp");
  const trashRoot = resolveUnder(workspaceRoot(cwd), "trash");
  return resolveUnder(trashRoot, `${projectId}-${timestamp}`);
}
