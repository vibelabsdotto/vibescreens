import { NextResponse } from "next/server";

import { rejectCrossSiteWrite } from "../../../../lib/request-guard";
import {
  apiErrorResponse,
  projectIdFromRequest,
  readJsonBody,
  requireJsonObject,
} from "../../../../lib/server-http";
import {
  createWorkspaceProjectService,
  type ProjectCommand,
  type WorkspaceProjectService,
} from "../../../../lib/server-service";

export const dynamic = "force-dynamic";

export function createProjectActionRouteHandlers(service: WorkspaceProjectService) {
  return {
    async POST(request: Request) {
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
        const result = await service.executeProjectCommand(
          projectId,
          body as unknown as ProjectCommand,
        );
        return NextResponse.json({ ok: true, ...result });
      } catch (error) {
        return apiErrorResponse(error);
      }
    },
  };
}

const handlers = createProjectActionRouteHandlers(createWorkspaceProjectService());

export const POST = handlers.POST;
