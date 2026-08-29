import { NextResponse } from "next/server";

import { DomainOperationError } from "./project-operations";
import {
  ProjectAlreadyExistsError,
  ProjectIdentityMismatchError,
  ProjectNotFoundError,
  ProjectRevisionConflictError,
  PublishedVersionMutationError,
} from "./project-repository";
import { ProjectSchemaError } from "./project-schema";
import { assertProjectId, WorkspaceRevisionConflictError, type ProjectId } from "./workspace";
import {
  OrphanedProjectError,
  PartialWorkspaceCommitError,
  ProjectNotRegisteredError,
  WorkspaceProjectLimitError,
  WorkspaceSchemaError,
} from "./workspace-repository";

export const MAX_JSON_BODY_BYTES = 1024 * 1024;

export class HttpRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}

export async function readJsonBody(
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new HttpRequestError(400, "Invalid Content-Length", "invalid_content_length");
    }
    if (bytes > maxBytes) {
      throw new HttpRequestError(413, "JSON body is too large", "body_too_large");
    }
  }

  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new HttpRequestError(413, "JSON body is too large", "body_too_large");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpRequestError(400, "Invalid JSON", "invalid_json");
  }
}

export function requireJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpRequestError(400, "JSON body must be an object", "invalid_body");
  }
  return value as Record<string, unknown>;
}

export function projectIdFromRequest(request: Request): ProjectId {
  const projectId = new URL(request.url).searchParams.get("projectId");
  try {
    assertProjectId(projectId);
  } catch {
    throw new HttpRequestError(400, "A valid projectId query parameter is required", "invalid_project_id");
  }
  return projectId;
}

export function apiErrorResponse(error: unknown): NextResponse {
  if (error instanceof WorkspaceRevisionConflictError) {
    return NextResponse.json(
      {
        ok: false,
        code: "workspace_revision_conflict",
        error: error.message,
        current: { revision: error.currentRevision },
      },
      { status: 409 },
    );
  }
  if (error instanceof ProjectRevisionConflictError) {
    return NextResponse.json(
      {
        ok: false,
        code: "project_revision_conflict",
        error: error.message,
        current: error.current,
      },
      { status: 409 },
    );
  }
  if (error instanceof DomainOperationError) {
    return NextResponse.json(
      {
        ok: false,
        code: error.code,
        error: error.message,
      },
      { status: error.code === "not_found" ? 404 : 409 },
    );
  }
  if (
    error instanceof ProjectNotRegisteredError ||
    error instanceof ProjectNotFoundError
  ) {
    return NextResponse.json(
      { ok: false, code: "project_not_found", error: error.message },
      { status: 404 },
    );
  }
  if (error instanceof OrphanedProjectError) {
    return NextResponse.json(
      { ok: false, code: "orphaned_project", error: error.message },
      { status: 409 },
    );
  }
  if (
    error instanceof ProjectAlreadyExistsError ||
    error instanceof PublishedVersionMutationError
  ) {
    return NextResponse.json(
      { ok: false, code: "conflict", error: error.message },
      { status: 409 },
    );
  }
  if (error instanceof WorkspaceProjectLimitError) {
    return NextResponse.json(
      { ok: false, code: "project_limit", error: error.message },
      { status: 409 },
    );
  }
  if (error instanceof HttpRequestError) {
    return NextResponse.json(
      { ok: false, code: error.code, error: error.message },
      { status: error.status },
    );
  }
  if (
    error instanceof TypeError ||
    error instanceof ProjectIdentityMismatchError ||
    error instanceof ProjectSchemaError ||
    error instanceof WorkspaceSchemaError
  ) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", error: error.message },
      { status: 400 },
    );
  }
  if (error instanceof PartialWorkspaceCommitError) {
    return NextResponse.json(
      { ok: false, code: "partial_commit", error: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      ok: false,
      code: "internal_error",
      error: error instanceof Error ? error.message : "Internal server error",
    },
    { status: 500 },
  );
}
