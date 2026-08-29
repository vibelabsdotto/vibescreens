import { NextResponse } from "next/server";

import { rejectCrossSiteWrite } from "../../../lib/request-guard";
import {
  apiErrorResponse,
  projectIdFromRequest,
  readJsonBody,
  requireJsonObject,
} from "../../../lib/server-http";
import {
  createWorkspaceProjectService,
  type WorkspaceProjectService,
} from "../../../lib/server-service";

export const dynamic = "force-dynamic";

export function createProjectRouteHandlers(service: WorkspaceProjectService) {
  return {
    async GET(request: Request) {
      try {
        const projectId = projectIdFromRequest(request);
        const project = await service.getProject(projectId);
        return NextResponse.json({ ok: true, project });
      } catch (error) {
        return apiErrorResponse(error);
      }
    },

    async PUT(request: Request) {
      const blocked = rejectCrossSiteWrite(request);
      if (blocked !== null) {
        return NextResponse.json(
          { ok: false, code: "write_rejected", error: blocked.error },
          { status: blocked.status },
        );
      }

      try {
        const projectId = projectIdFromRequest(request);
        const body = requireJsonObject(await readJsonBody(request));
        const project = await service.saveProject({
          projectId,
          baseRevision: body.baseRevision as number,
          document: body.document as never,
        });
        return NextResponse.json({ ok: true, project });
      } catch (error) {
        return apiErrorResponse(error);
      }
    },
  };
}

const handlers = createProjectRouteHandlers(createWorkspaceProjectService());

export const GET = handlers.GET;
export const PUT = handlers.PUT;
