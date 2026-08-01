import type { SpawnSubagentResult } from "./SubagentContext.js";

export interface AgentWorkspace {
    id: string;
    name: string;
    path: string;
    status: "initializing" | "ready" | "failed" | "archiving" | "archived";
    projectId: string;
    /** True only for workspaces this session created and may archive itself. */
    owned?: boolean;
}

export interface AgentProject {
    id: string;
    name: string;
    path: string;
    /** True for the project this session itself runs in. */
    current: boolean;
}

export interface AgentWorkspaceSession {
    id: string;
    agentId: string;
    projectId: string;
    workspaceId?: string;
    title: string;
    status: string;
    updatedAt: number;
    /** The session that started this one, when an agent delegated the work. */
    delegatedBy?: string;
}

export interface WorkspaceAgentRequest {
    description: string;
    prompt: string;
    workspaceId: string;
    background?: boolean;
    parentToolCallId?: string;
}

export interface DelegatedSessionRequest {
    projectId?: string;
    prompt: string;
    title?: string;
    workspaceId: string;
}

export interface DelegatedSession {
    agentId: string;
    projectId: string;
    sessionId: string;
    title: string;
    workspaceId: string;
    workspacePath: string;
}

export interface WorkspaceContext {
    /** Whether this session may inspect, and start work in, other projects and workspaces. */
    crossWorkspace: boolean;
    archive(workspaceId: string): Promise<AgentWorkspace>;
    create(input: { baseRef?: string; name: string }): Promise<AgentWorkspace>;
    delegate(request: DelegatedSessionRequest): Promise<DelegatedSession>;
    listProjects(): readonly AgentProject[];
    listSessions(target: {
        projectId?: string;
        workspaceId?: string;
    }): readonly AgentWorkspaceSession[];
    listWorkspaces(projectId?: string): readonly AgentWorkspace[];
    spawn(request: WorkspaceAgentRequest, signal?: AbortSignal): Promise<SpawnSubagentResult>;
}
