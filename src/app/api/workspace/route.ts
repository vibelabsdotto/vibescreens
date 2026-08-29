import { NextResponse } from "next/server";

import { apiErrorResponse } from "../../../lib/server-http";
import {
  createWorkspaceProjectService,
  type WorkspaceProjectService,
} from "../../../lib/server-service";

export const dynamic = "force-dynamic";

export function createWorkspaceRouteHandlers(service: WorkspaceProjectService) {
  return {
    async GET() {
      try {
        const snapshot = await service.getWorkspace();
        return NextResponse.json({ ok: true, ...snapshot });
      } catch (error) {
        return apiErrorResponse(error);
      }
    },
  };
}

const handlers = createWorkspaceRouteHandlers(createWorkspaceProjectService());

export const GET = handlers.GET;
