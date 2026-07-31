import type { SpawnSubagentResult } from "./SubagentContext.js";

export interface AgentWorkspace {
    id: string;
    name: string;
    path: string;
    status: "initializing" | "ready" | "failed" | "archiving" | "archived";
}

export interface WorkspaceAgentRequest {
    description: string;
    prompt: string;
    workspaceId: string;
    background?: boolean;
    parentToolCallId?: string;
}

export interface WorkspaceContext {
    archive(workspaceId: string): Promise<AgentWorkspace>;
    create(input: { baseRef: string; name: string }): Promise<AgentWorkspace>;
    spawn(request: WorkspaceAgentRequest, signal?: AbortSignal): Promise<SpawnSubagentResult>;
}
