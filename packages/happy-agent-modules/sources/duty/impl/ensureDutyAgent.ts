import { createHash } from "node:crypto";

import {
    currentAgentEnvironment,
    type AgentConfig,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { ProjectsModule } from "../../projects/index.js";
import type { DutyDeclaration } from "../Duty.js";

/** One stable, tenure-scoped holder for a Duty in one project. */
export function dutyAgentId(dutyId: string, tenureId: string, project: string): string {
    return `a${createHash("sha256")
        .update(JSON.stringify(["duty", dutyId, tenureId, project]), "utf8")
        .digest("hex")
        .slice(0, 31)}`;
}

/** Ensure the declared Duty has a durable root agent attached to its project. */
export async function ensureDutyAgent(
    ctx: Context,
    projects: ProjectsModule,
    agents: AgentSystemRef,
    declaration: DutyDeclaration,
): Promise<string> {
    const project = await projects.register(ctx, { path: declaration.project });
    const agentId = dutyAgentId(declaration.dutyId, declaration.tenureId, project.repositoryRef);
    const existing = await agents.config(ctx, agentId);
    if (existing !== undefined) {
        if (existing.environment?.workingDirectory !== project.repositoryRef) {
            throw new Error("The Duty holder has an incompatible project configuration.");
        }
        await projects.attachAgent(ctx, project.id, agentId);
        return agentId;
    }

    const now = Date.now();
    const config: AgentConfig = {
        environment: {
            ...currentAgentEnvironment(),
            workingDirectory: project.repositoryRef,
        },
        metadata: {
            title: `Duty: ${declaration.dutyId} (${declaration.tenureId})`,
            updatedAt: now,
            version: 1,
        },
        modules: { compute: { cwd: project.repositoryRef } },
        provenance: { createdAt: now },
    };
    await agents.create(ctx, config, { id: agentId, parent: null });
    await projects.attachAgent(ctx, project.id, agentId);
    return agentId;
}
