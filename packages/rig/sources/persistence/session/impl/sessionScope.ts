import { Value } from "@sinclair/typebox/value";

import { sessionScopeSchema, type SessionScope } from "../../../protocol/index.js";
import { readOptionalString, readString } from "./sqliteRow.js";

export function sessionScopeFromRow(row: Record<string, unknown>): SessionScope {
    const kind = readString(row, "scope_kind");
    const projectId = readOptionalString(row, "project_id");
    const workspaceId = readOptionalString(row, "workspace_id");
    const folderId = readOptionalString(row, "folder_id");
    const candidate: unknown =
        kind === "project"
            ? { kind, projectId }
            : kind === "workspace"
              ? { kind, projectId, workspaceId }
              : kind === "folder"
                ? { folderId, kind }
                : { kind };
    return Value.Decode(sessionScopeSchema, candidate);
}

export function sessionScopeValues(scope: SessionScope): {
    folderId: string | null;
    projectId: string | null;
    scopeKind: SessionScope["kind"];
    workspaceId: string | null;
} {
    return {
        folderId: scope.kind === "folder" ? scope.folderId : null,
        projectId: scope.kind === "project" || scope.kind === "workspace" ? scope.projectId : null,
        scopeKind: scope.kind,
        workspaceId: scope.kind === "workspace" ? scope.workspaceId : null,
    };
}
