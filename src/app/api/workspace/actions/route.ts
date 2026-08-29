import { NextResponse } from "next/server";

import { rejectCrossSiteWrite } from "../../../../lib/request-guard";
import {
  apiErrorResponse,
  readJsonBody,
  requireJsonObject,
} from "../../../../lib/server-http";
import {
  createWorkspaceProjectService,
  type WorkspaceCommand,
  type WorkspaceProjectService,
} from "../../../../lib/server-service";

export const dynamic = "force-dynamic";

export function createWorkspaceActionRouteHandlers(service: WorkspaceProjectService) {
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
        const body = requireJsonObject(await readJsonBody(request));
        const result = await service.executeWorkspaceCommand(
          body as unknown as WorkspaceCommand,
        );
        return NextResponse.json({ ok: true, ...result });
      } catch (error) {
        return apiErrorResponse(error);
      }
    },
  };
}

const handlers = createWorkspaceActionRouteHandlers(createWorkspaceProjectService());

export const POST = handlers.POST;
