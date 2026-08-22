import {
    AgentSystemLocal,
    defineAgentTool,
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { DutyModule } from "../../sources/duty/DutyModule.js";
import type { IssueDutyInput } from "../../sources/duty/Duty.js";
import { dutyAgentId } from "../../sources/duty/index.js";
import type { ProjectsModule } from "../../sources/projects/index.js";
import { agentWorld } from "../support/agentWorld.js";
import { providersOf, textTurn, toolCallTurn, user } from "../support/fixtures.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

const root = createRootContext().named("happy-agent-modules-duty-runtime");

const issued: IssueDutyInput = {
    allowedTools: ["allowed_probe"],
    charter: "Maintain the release branch.",
    dutyId: "duty-release",
    permissionCeiling: "workspace_write",
    tenureId: "tenure-one",
    trigger: "Inspect the latest build failure.",
};

function projects(): ProjectsModule {
    return {
        attachAgent: async () => undefined,
        register: async (_ctx: Context, request: { readonly path: string }) => ({
            id: "project-one",
            repositoryRef: request.path,
        }),
    } as unknown as ProjectsModule;
}

/** A module contributing two probe tools so a scripted turn can reach the Duty tool ceiling. */
function probeModule(ran: string[]): AgentModule {
    const probe = (name: string): AnyAgentTool =>
        defineAgentTool({
            name,
            returnType: Type.Object({}, { additionalProperties: false }),
            shouldReviewInAutoMode: () => false,
            execute: async () => {
                ran.push(name);
                return {};
            },
            toLLM: () => [{ type: "text", text: "ok" }],
        });
    return {
        name: "duty-runtime-probe",
        beforeStart: (): AgentModuleHooks => ({
            tools: () => [probe("allowed_probe"), probe("denied_probe")],
        }),
    };
}

describe("Duty inside a live agent collection", () => {
    it("wakes the bound agent, runs the Duty, and settles the run", async () => {
        const world = await agentWorld();
        const ctx = withAgentDatabase(root, world.storage.database);
        const provider = new ScriptedProvider([textTurn("Release branch inspected.")]);
        const duty = new DutyModule();
        const system = await AgentSystemLocal.create(ctx, world.storage, {
            models: [],
            modules: [duty],
            provider: "scripted",
            providers: providersOf(provider),
        });
        try {
            const agent = await system.create(ctx, {});

            const result = await duty.issueDuty(ctx, agent.id, issued);
            expect(result.run.status).toBe("queued");

            await agent.waitForIdle();

            await expect(duty.runs(ctx, agent.id)).resolves.toEqual([
                expect.objectContaining({
                    runId: result.run.runId,
                    settledAt: expect.any(Number),
                    startedAt: expect.any(Number),
                    status: "completed",
                }),
            ]);
            await expect(duty.currentRun(ctx, agent.id)).resolves.toBeUndefined();

            // The charter has to reach the model, otherwise the wake carried no authority.
            const request = provider.sessions[0]?.requests[0];
            expect(JSON.stringify(request)).toContain(issued.charter);
        } finally {
            await system.close(ctx);
        }
    });

    it("refuses a tool outside the ceiling at the real dispatch path", async () => {
        const world = await agentWorld();
        const ctx = withAgentDatabase(root, world.storage.database);
        const ran: string[] = [];
        const provider = new ScriptedProvider([
            toolCallTurn("call-denied", "denied_probe", "{}"),
            toolCallTurn("call-allowed", "allowed_probe", "{}"),
            textTurn("Done."),
        ]);
        const duty = new DutyModule();
        const system = await AgentSystemLocal.create(ctx, world.storage, {
            models: [],
            modules: [duty, probeModule(ran)],
            provider: "scripted",
            providers: providersOf(provider),
        });
        try {
            const agent = await system.create(ctx, {});
            await duty.issueDuty(ctx, agent.id, issued);
            await agent.waitForIdle();

            expect(ran).toEqual(["allowed_probe"]);
            await expect(duty.runs(ctx, agent.id)).resolves.toEqual([
                expect.objectContaining({ status: "completed" }),
            ]);
        } finally {
            await system.close(ctx);
        }
    });

    it("runs a Duty a roster declared, through the path a daemon takes", async () => {
        // This is the whole point of the roster: nothing but a declared charter goes in, and a real
        // agent does real work and settles the run. No route, no app change, no server involved.
        const world = await agentWorld();
        const ctx = withAgentDatabase(root, world.storage.database);
        const provider = new ScriptedProvider([textTurn("Swept the branch.")]);
        const duty = new DutyModule(undefined, projects());
        const system = await AgentSystemLocal.create(ctx, world.storage, {
            models: [],
            modules: [duty],
            provider: "scripted",
            providers: providersOf(provider),
        });
        try {
            const declaration = {
                allowedTools: ["allowed_probe"],
                charter: issued.charter,
                dutyId: "release-warden",
                permissionCeiling: "workspace_write" as const,
                project: "/srv/repo",
                tenureId: "tenure-1",
                trigger: issued.trigger,
            };
            const outcome = await duty.reconcile(ctx, [declaration]);
            expect(outcome).toMatchObject({ issued: ["release-warden"], notices: [] });

            const boundAgentId = dutyAgentId(
                declaration.dutyId,
                declaration.tenureId,
                declaration.project,
            );
            await (await system.resolve(ctx, boundAgentId)).waitForIdle();

            await expect(duty.duty(ctx, boundAgentId)).resolves.toMatchObject({
                charter: issued.charter,
                dutyId: "release-warden",
                status: "active",
            });
            await expect(duty.runs(ctx, boundAgentId)).resolves.toEqual([
                expect.objectContaining({ settledAt: expect.any(Number), status: "completed" }),
            ]);
        } finally {
            duty.stop();
            await system.close(ctx);
        }
    });

    it("issues a Duty through an ordinary root-session tool call", async () => {
        const world = await agentWorld();
        const ctx = withAgentDatabase(root, world.storage.database);
        const declaration = {
            allowedTools: ["get_duty"],
            charter: "Watch the production release.",
            dutyId: "production-watch",
            permissionCeiling: "read_only" as const,
            project: "/srv/repo",
            tenureId: "tenure-1",
            trigger: "Inspect production now.",
        };
        const provider = new ScriptedProvider([
            toolCallTurn("issue-call", "issue_duty", JSON.stringify(declaration)),
            textTurn("Duty issued."),
            textTurn("Production inspected."),
        ]);
        const duty = new DutyModule(undefined, projects());
        const system = await AgentSystemLocal.create(ctx, world.storage, {
            models: [],
            modules: [duty],
            provider: "scripted",
            providers: providersOf(provider),
        });
        try {
            const issuer = await system.create(ctx, {});
            await issuer.send(ctx, user("Issue the production watch Duty."));
            await issuer.waitForIdle();

            const holderId = dutyAgentId(
                declaration.dutyId,
                declaration.tenureId,
                declaration.project,
            );
            await (await system.resolve(ctx, holderId)).waitForIdle();

            const binding = await duty.duty(ctx, holderId);
            expect(binding).toMatchObject({
                dutyId: declaration.dutyId,
                status: "active",
            });
            expect(binding).not.toHaveProperty("roster");
            await expect(duty.runs(ctx, holderId)).resolves.toEqual([
                expect.objectContaining({ status: "completed" }),
            ]);
            expect(JSON.stringify(provider.sessions[0]?.options)).toContain("issue_duty");
        } finally {
            duty.stop();
            await system.close(ctx);
        }
    });

    it("keeps the Duty runnable across a process restart", async () => {
        const world = await agentWorld();
        const ctx = withAgentDatabase(root, world.storage.database);
        const first = new ScriptedProvider([textTurn("First run.")]);
        const firstDuty = new DutyModule();
        const firstSystem = await AgentSystemLocal.create(ctx, world.storage, {
            models: [],
            modules: [firstDuty],
            provider: "scripted",
            providers: providersOf(first),
        });
        let agentId: string;
        try {
            const agent = await firstSystem.create(ctx, {});
            agentId = agent.id;
            await firstDuty.issueDuty(ctx, agentId, issued);
            await agent.waitForIdle();
        } finally {
            await firstSystem.close(ctx);
        }

        const second = new ScriptedProvider([textTurn("Second run.")]);
        const secondDuty = new DutyModule();
        const secondSystem = await AgentSystemLocal.create(ctx, world.storage, {
            models: [],
            modules: [secondDuty],
            provider: "scripted",
            providers: providersOf(second),
        });
        try {
            // The binding outlived the process that issued it.
            await expect(secondDuty.duty(ctx, agentId)).resolves.toMatchObject({
                dutyId: issued.dutyId,
                status: "active",
            });

            const run = await secondDuty.activateDuty(ctx, agentId, "Woken after a restart.");
            const agent = await secondSystem.resolve(ctx, agentId);
            await agent.waitForIdle();

            await expect(secondDuty.runs(ctx, agentId)).resolves.toEqual([
                expect.objectContaining({ status: "completed" }),
                expect.objectContaining({ runId: run.runId, status: "completed" }),
            ]);
        } finally {
            await secondSystem.close(ctx);
        }
    });
});
