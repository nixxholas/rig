import type {
    AgentConfig,
    AgentMessageMetadata,
    AgentModuleScope,
    AgentSystemRef,
} from "@slopus/happy-agent-base";
import { agentDatabaseRun, withAgentContext } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DutyModule } from "../../sources/duty/DutyModule.js";
import type { DutyDeclaration, IssueDutyInput } from "../../sources/duty/Duty.js";
import { dutyAgentId } from "../../sources/duty/index.js";
import type { ConfigModule } from "../../sources/config/index.js";
import type { ProjectsModule } from "../../sources/projects/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { temporaryTestConfig } from "../support/configModule.js";

const issued: IssueDutyInput = {
    allowedTools: ["read_file", "edit_file"],
    charter: "Maintain the release branch.",
    dutyId: "duty-release",
    permissionCeiling: "workspace_write",
    tenureId: "tenure-one",
    trigger: "Inspect the latest build failure.",
};

interface Wake {
    readonly agentId: string;
    readonly effort?: string;
    readonly id?: string;
    readonly metadata?: AgentMessageMetadata;
    readonly model?: string;
    readonly permissionMode?: string;
    readonly provider?: string;
    readonly text: string;
}

function recordingAgents(failSend = false): {
    readonly aborts: string[];
    readonly configs: Map<string, AgentConfig>;
    readonly ref: AgentSystemRef;
    readonly wakes: Wake[];
} {
    const aborts: string[] = [];
    const configs = new Map<string, AgentConfig>();
    const wakes: Wake[] = [];
    const ref = {
        abort: async (_ctx: Context, agentId: string) => {
            aborts.push(agentId);
        },
        config: async (_ctx: Context, agentId: string) => configs.get(agentId),
        create: async (_ctx: Context, config: AgentConfig, options?: { readonly id?: string }) => {
            if (options?.id === undefined) throw new Error("The test agent needs an identity.");
            configs.set(options.id, structuredClone(config));
            return {};
        },
        parentOf: async () => null,
        send: async (
            _ctx: Context,
            agentId: string,
            message: { readonly content: readonly { readonly text?: string }[] },
            options?: {
                readonly id?: string;
                readonly effort?: string;
                readonly metadata?: AgentMessageMetadata;
                readonly model?: string;
                readonly permissionMode?: string;
                readonly provider?: string;
            },
        ) => {
            if (failSend) throw new Error("send failed");
            wakes.push({
                agentId,
                ...(options?.id === undefined ? {} : { id: options.id }),
                ...(options?.effort === undefined ? {} : { effort: options.effort }),
                ...(options?.metadata === undefined ? {} : { metadata: options.metadata }),
                ...(options?.model === undefined ? {} : { model: options.model }),
                ...(options?.permissionMode === undefined
                    ? {}
                    : { permissionMode: options.permissionMode }),
                ...(options?.provider === undefined ? {} : { provider: options.provider }),
                text: message.content.map((block) => block.text ?? "").join(""),
            });
        },
    } as unknown as AgentSystemRef;
    return { aborts, configs, ref, wakes };
}

function projectsFor(options: { readonly failingPath?: string } = {}): ProjectsModule {
    return {
        attachAgent: async () => undefined,
        register: async (_ctx: Context, request: { readonly path: string }) => {
            if (request.path === options.failingPath) throw new Error("that folder is gone");
            return { id: "project-one", repositoryRef: request.path };
        },
    } as unknown as ProjectsModule;
}

function memoryKV() {
    const values = new Map<string, unknown>();
    return {
        values,
        read: async (_ctx: Context, key: string) => values.get(key),
        write: async (_ctx: Context, key: string, value: unknown) => {
            values.set(key, structuredClone(value));
        },
    };
}

function scope(agentId: string, permissionMode = "workspace_write") {
    return {
        agent: { id: agentId, permissionMode },
        runKV: memoryKV(),
    } as unknown as AgentModuleScope;
}

describe("DutyModule", () => {
    it("issues a durable binding and wakes the bound agent with constrained provenance", async () => {
        const module = new DutyModule();
        const database = moduleDatabase(module.migrations, "duty-issue-test");
        const agents = recordingAgents();
        await database.ready;
        module.beforeStart(database.context, agents.ref);
        try {
            const result = await module.issueDuty(database.context, "agent-a", issued);

            expect(result.duty).toMatchObject({
                agentId: "agent-a",
                allowedTools: issued.allowedTools,
                charter: issued.charter,
                dutyId: issued.dutyId,
                permissionCeiling: issued.permissionCeiling,
                status: "active",
                tenureId: issued.tenureId,
            });
            expect(result.run.status).toBe("queued");
            expect(agents.wakes).toHaveLength(1);
            expect(agents.wakes[0]).toMatchObject({
                agentId: "agent-a",
                id: expect.stringMatching(/^d[a-f0-9]{31}$/),
                metadata: {
                    dutyRunId: result.run.runId,
                    messageOrigin: "agent",
                    senderAgentId: "agent-a",
                },
                permissionMode: "workspace_write",
                text: expect.stringContaining(issued.charter),
            });

            const reloaded = new DutyModule();
            await expect(reloaded.duty(database.context, "agent-a")).resolves.toEqual(result.duty);
            await expect(reloaded.runs(database.context, "agent-a")).resolves.toEqual([result.run]);
        } finally {
            database.close();
        }
    });

    it("makes identical issuance retries converge and rolls back a rejected wake", async () => {
        const module = new DutyModule();
        const database = moduleDatabase(module.migrations, "duty-idempotency-test");
        const agents = recordingAgents();
        await database.ready;
        module.beforeStart(database.context, agents.ref);
        try {
            const first = await module.issueDuty(database.context, "agent-a", issued);
            const retry = await module.issueDuty(database.context, "agent-a", issued);
            expect(retry).toEqual(first);
            expect(agents.wakes).toHaveLength(1);

            await expect(
                module.issueDuty(database.context, "agent-a", {
                    ...issued,
                    dutyId: "different-duty",
                }),
            ).rejects.toThrow("unfinished Duty");
        } finally {
            database.close();
        }

        const failed = new DutyModule();
        const failedDatabase = moduleDatabase(failed.migrations, "duty-wake-rollback-test");
        await failedDatabase.ready;
        failed.beforeStart(failedDatabase.context, recordingAgents(true).ref);
        try {
            await expect(
                failed.issueDuty(failedDatabase.context, "agent-b", issued),
            ).rejects.toThrow("send failed");
            await expect(failed.duty(failedDatabase.context, "agent-b")).resolves.toBeUndefined();
            await expect(failed.runs(failedDatabase.context, "agent-b")).resolves.toEqual([]);
        } finally {
            failedDatabase.close();
        }
    });

    it("correlates an accepted wake with its run and settles it atomically", async () => {
        const module = new DutyModule();
        const database = moduleDatabase(module.migrations, "duty-settlement-test");
        const agents = recordingAgents();
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, module, agents.ref);
        const runScope = scope("agent-a");
        try {
            const issuedDuty = await module.issueDuty(database.context, "agent-a", issued);
            await database.context.inTx(async (ctx) => {
                await hooks.messageAcceptedTransact!(ctx, runScope, {
                    id: "message-one",
                    kind: "send",
                    message: { role: "user", content: [] },
                    metadata: agents.wakes[0]!.metadata!,
                });
            });
            await expect(module.currentRun(database.context, "agent-a")).resolves.toMatchObject({
                runId: issuedDuty.run.runId,
                status: "running",
            });

            await database.context.inTx(async (ctx) => {
                await hooks.afterAgentSettledTransact!(ctx, runScope, {
                    loopId: "loop-one",
                    settlementId: "settlement-one",
                });
            });
            await expect(module.runs(database.context, "agent-a")).resolves.toEqual([
                expect.objectContaining({
                    runId: issuedDuty.run.runId,
                    settledAt: expect.any(Number),
                    status: "completed",
                }),
            ]);
        } finally {
            database.close();
        }
    });

    it("records a failed settlement without leaving the Duty run active", async () => {
        const module = new DutyModule();
        const database = moduleDatabase(module.migrations, "duty-failed-settlement-test");
        const agents = recordingAgents();
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, module, agents.ref);
        const runScope = scope("agent-a");
        try {
            await module.issueDuty(database.context, "agent-a", issued);
            await database.context.inTx(async (ctx) => {
                await hooks.messageAcceptedTransact!(ctx, runScope, {
                    id: "message-one",
                    kind: "send",
                    message: { role: "user", content: [] },
                    metadata: agents.wakes[0]!.metadata!,
                });
                await hooks.afterAgentSettledTransact!(ctx, runScope, {
                    error: "provider failed",
                    loopId: "loop-one",
                    settlementId: "settlement-one",
                });
            });

            await expect(module.currentRun(database.context, "agent-a")).resolves.toBeUndefined();
            await expect(module.runs(database.context, "agent-a")).resolves.toEqual([
                expect.objectContaining({ error: "provider failed", status: "failed" }),
            ]);
        } finally {
            database.close();
        }
    });

    it("exposes inspection while enforcing status, tool, and permission ceilings", async () => {
        const module = new DutyModule();
        const database = moduleDatabase(module.migrations, "duty-enforcement-test");
        const agents = recordingAgents();
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, module, agents.ref);
        try {
            await module.issueDuty(database.context, "agent-a", issued);
            const agentScope = scope("agent-a", "full_access");
            const tools = await hooks.tools!(database.context, agentScope);
            expect(tools.map((tool) => tool.name)).toEqual(["get_duty"]);
            const getDuty = tools[0]!;
            const read = await getDuty.execute(
                withAgentContext(database.context, {
                    id: "agent-a",
                    permissionMode: "workspace_write",
                    provider: "scripted",
                }),
                {},
                {} as never,
            );
            expect(read.duty).toMatchObject({ dutyId: issued.dutyId });

            const clamp = await hooks.beforeToolCall!(database.context, agentScope, {
                arguments: {},
                callId: "call-one",
                tool: { name: "read_file" } as never,
            });
            expect(clamp).toEqual({ type: "run", permissionMode: "workspace_write" });

            const refusal = await hooks.beforeToolCall!(database.context, agentScope, {
                arguments: {},
                callId: "call-two",
                tool: { name: "shell" } as never,
            });
            expect(refusal).toMatchObject({ type: "answer", isError: true });

            await module.changeDutyStatus(database.context, "agent-a", "paused");
            await expect(module.runs(database.context, "agent-a")).resolves.toEqual([
                expect.objectContaining({
                    error: "Duty paused by its issuer.",
                    status: "failed",
                }),
            ]);
            const paused = await hooks.beforeToolCall!(database.context, agentScope, {
                arguments: {},
                callId: "call-three",
                tool: { name: "read_file" } as never,
            });
            expect(paused).toMatchObject({ type: "answer", isError: true });
            expect(agents.aborts).toEqual(["agent-a"]);

            await module.changeDutyStatus(database.context, "agent-a", "active");
            expect(agents.wakes).toHaveLength(2);
            await expect(module.currentRun(database.context, "agent-a")).resolves.toMatchObject({
                status: "queued",
                trigger: "Duty resumed by its issuer.",
            });

            const autoScope = scope("agent-a", "auto");
            const autoClamp = await hooks.beforeToolCall!(database.context, autoScope, {
                arguments: {},
                callId: "call-four",
                tool: { name: "read_file" } as never,
            });
            expect(autoClamp).toEqual({ type: "run", permissionMode: "workspace_write" });
        } finally {
            database.close();
        }
    });

    it("serializes competing issuance and permits a new tenure only after stop", async () => {
        const module = new DutyModule();
        const database = moduleDatabase(module.migrations, "duty-concurrency-test");
        const agents = recordingAgents();
        await database.ready;
        module.beforeStart(database.context, agents.ref);
        try {
            const results = await Promise.all([
                module.issueDuty(database.context, "agent-a", issued),
                module.issueDuty(database.context, "agent-a", issued),
            ]);
            expect(results[0]).toEqual(results[1]);
            expect(agents.wakes).toHaveLength(1);

            await module.changeDutyStatus(database.context, "agent-a", "stopped");
            await expect(
                module.changeDutyStatus(database.context, "agent-a", "active"),
            ).rejects.toThrow("stopped Duty cannot be resumed");

            const replacement = await module.issueDuty(database.context, "agent-a", {
                ...issued,
                dutyId: "duty-replacement",
                tenureId: "tenure-two",
            });
            expect(replacement.duty).toMatchObject({
                dutyId: "duty-replacement",
                status: "active",
                tenureId: "tenure-two",
            });
            expect(agents.wakes).toHaveLength(2);
        } finally {
            database.close();
        }
    });

    it("rejects malformed issuance and corrupt persisted authority", async () => {
        const module = new DutyModule();
        const database = moduleDatabase(module.migrations, "duty-validation-test");
        await database.ready;
        module.beforeStart(database.context, recordingAgents().ref);
        try {
            await expect(
                module.issueDuty(database.context, "agent-a", {
                    ...issued,
                    allowedTools: ["bad tool"],
                }),
            ).rejects.toThrow("issuance is invalid");
            await expect(
                module.issueDuty(database.context, "agent-a", {
                    ...issued,
                    charter: "   ",
                }),
            ).rejects.toThrow("binding is invalid");
            await expect(
                module.issueDuty(database.context, "agent-a", {
                    ...issued,
                    trigger: "   ",
                }),
            ).rejects.toThrow("trigger must not be empty");
            await expect(module.duty(database.context, "")).rejects.toThrow("agent ID is invalid");

            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO happy_agent_duty_state (agent_id, value_json)
                    VALUES (${"agent-corrupt"}, ${JSON.stringify({ status: "unbounded" })})`,
            );
            await expect(module.duty(database.context, "agent-corrupt")).rejects.toThrow(
                "Stored Duty binding is invalid",
            );
        } finally {
            database.close();
        }
    });
});

describe("DutyModule liveness and authority", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("re-drives a run the last process left unaccepted", async () => {
        // The crash window this covers: issuance commits, the wake is queued, and the process dies
        // before the agent takes the message. Without recovery the run stays `queued` forever and
        // `activateDuty` keeps handing back that dead run, so the Duty never runs again.
        const crashed = new DutyModule();
        const database = moduleDatabase(crashed.migrations, "duty-recovery-test");
        await database.ready;
        crashed.beforeStart(database.context, recordingAgents().ref);
        try {
            const before = await crashed.issueDuty(database.context, "agent-a", issued);

            const restarted = new DutyModule();
            const agents = recordingAgents();
            restarted.beforeStart(database.context, agents.ref);
            await restarted.recover(database.context);

            expect(agents.wakes).toHaveLength(1);
            expect(agents.wakes[0]).toMatchObject({
                agentId: "agent-a",
                metadata: { dutyRunId: before.run.runId },
            });
            // The same run, re-offered under the same identity — never a second one.
            await expect(restarted.runs(database.context, "agent-a")).resolves.toHaveLength(1);
        } finally {
            crashed.stop();
            database.close();
        }
    });

    it("leaves a settled Duty alone when it recovers", async () => {
        const module = new DutyModule();
        const database = moduleDatabase(module.migrations, "duty-recovery-settled-test");
        const agents = recordingAgents();
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, module, agents.ref);
        const runScope = scope("agent-a");
        try {
            await module.issueDuty(database.context, "agent-a", issued);
            await database.context.inTx(async (ctx) => {
                await hooks.messageAcceptedTransact!(ctx, runScope, {
                    id: "message-one",
                    kind: "send",
                    message: { role: "user", content: [] },
                    metadata: agents.wakes[0]!.metadata!,
                });
                await hooks.afterAgentSettledTransact!(ctx, runScope, {
                    loopId: "loop-one",
                    settlementId: "settlement-one",
                });
            });

            await module.recover(database.context);
            expect(agents.wakes).toHaveLength(1);
        } finally {
            module.stop();
            database.close();
        }
    });

    it("wakes itself again once its own interval comes due", async () => {
        vi.useFakeTimers();
        const module = new DutyModule();
        const database = moduleDatabase(module.migrations, "duty-interval-test");
        const agents = recordingAgents();
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, module, agents.ref);
        const runScope = scope("agent-a");
        try {
            const first = await module.issueDuty(database.context, "agent-a", {
                ...issued,
                every: 60_000,
            });
            await expect(module.duty(database.context, "agent-a")).resolves.toMatchObject({
                every: 60_000,
                nextWakeAt: expect.any(Number),
            });

            // A Duty still working through its last run is not given a second one.
            await vi.advanceTimersByTimeAsync(60_000);
            expect(agents.wakes).toHaveLength(1);

            await database.context.inTx(async (ctx) => {
                await hooks.messageAcceptedTransact!(ctx, runScope, {
                    id: "message-one",
                    kind: "send",
                    message: { role: "user", content: [] },
                    metadata: agents.wakes[0]!.metadata!,
                });
                await hooks.afterAgentSettledTransact!(ctx, runScope, {
                    loopId: "loop-one",
                    settlementId: "settlement-one",
                });
            });

            await vi.advanceTimersByTimeAsync(60_000);
            expect(agents.wakes).toHaveLength(2);
            const runs = await module.runs(database.context, "agent-a");
            expect(runs).toHaveLength(2);
            expect(runs[0]!.runId).toBe(first.run.runId);
            expect(runs[1]).toMatchObject({
                status: "queued",
                trigger: "This Duty's own interval came due.",
            });
        } finally {
            module.stop();
            database.close();
        }
    });

    it("stops waking a paused Duty and resumes the clock when it is reactivated", async () => {
        vi.useFakeTimers();
        const module = new DutyModule();
        const database = moduleDatabase(module.migrations, "duty-interval-pause-test");
        const agents = recordingAgents();
        await database.ready;
        module.beforeStart(database.context, agents.ref);
        try {
            await module.issueDuty(database.context, "agent-a", { ...issued, every: 60_000 });
            await module.changeDutyStatus(database.context, "agent-a", "paused");

            await vi.advanceTimersByTimeAsync(10 * 60_000);
            expect(agents.wakes).toHaveLength(1);

            await module.changeDutyStatus(database.context, "agent-a", "active");
            // Resuming issues its own run, and the interval is live again from here.
            expect(agents.wakes).toHaveLength(2);
        } finally {
            module.stop();
            database.close();
        }
    });

    it("ignores a message claiming a Duty run the agent does not hold", async () => {
        // This hook runs inside the transaction that accepts the message, so throwing would roll
        // that acceptance back and the message could never be consumed — one forged or orphaned
        // claim would block the agent's queue for good.
        const module = new DutyModule();
        const database = moduleDatabase(module.migrations, "duty-foreign-run-test");
        const agents = recordingAgents();
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, module, agents.ref);
        try {
            await module.issueDuty(database.context, "agent-a", issued);
            await expect(
                database.context.inTx(async (ctx) => {
                    await hooks.messageAcceptedTransact!(ctx, scope("agent-b"), {
                        id: "message-one",
                        kind: "send",
                        message: { role: "user", content: [] },
                        metadata: { dutyRunId: "a-run-nobody-issued" },
                    });
                }),
            ).resolves.toBeUndefined();
            await expect(module.currentRun(database.context, "agent-a")).resolves.toMatchObject({
                status: "queued",
            });
        } finally {
            module.stop();
            database.close();
        }
    });

    it("says nothing about permissions when its ceiling is not the narrower one", async () => {
        // Decisions fold last-wins and this module is ordered after the permission broker, so
        // naming the agent's own mode here would overwrite an elevation a person just approved.
        const module = new DutyModule();
        const database = moduleDatabase(module.migrations, "duty-ceiling-silence-test");
        await database.ready;
        const hooks = await resolveModuleHooks(database.context, module, recordingAgents().ref);
        try {
            await module.issueDuty(database.context, "agent-a", {
                ...issued,
                permissionCeiling: "full_access",
            });
            const call = { arguments: {}, callId: "call-one", tool: { name: "read_file" } };
            await expect(
                hooks.beforeToolCall!(database.context, scope("agent-a", "auto"), call as never),
            ).resolves.toBeUndefined();
            await expect(
                hooks.beforeToolCall!(
                    database.context,
                    scope("agent-a", "read_only"),
                    call as never,
                ),
            ).resolves.toBeUndefined();
        } finally {
            module.stop();
            database.close();
        }
    });
});

describe("DutyModule roster reconciliation", () => {
    const declaration: DutyDeclaration = {
        allowedTools: ["read_file"],
        charter: "Keep the release branch green.",
        dutyId: "release-warden",
        permissionCeiling: "workspace_write",
        project: "/srv/repo",
        tenureId: "tenure-1",
        trigger: "Sweep the branch.",
    };

    it("applies only authoritative roster removals across startup reads", async () => {
        const config = await temporaryTestConfig();
        const rosterPath = join(config.configuration.paths.configHome, "duties.toml");
        await mkdir(dirname(rosterPath), { recursive: true });
        await writeFile(
            rosterPath,
            `[[duty]]
id = "release-warden"
charter = "Keep the release branch green."
trigger = "Sweep the branch."
project = "/srv/repo"
permission_ceiling = "workspace_write"
allowed_tools = ["read_file"]
`,
            "utf8",
        );
        const module = new DutyModule(config, projectsFor());
        const database = moduleDatabase(module.migrations, "duty-open-roster-test");
        const agents = recordingAgents();
        await database.ready;
        module.beforeStart(database.context, agents.ref);
        const agentId = dutyAgentId(declaration.dutyId, declaration.tenureId, declaration.project);
        try {
            await expect(module.open(database.context)).resolves.toMatchObject({
                issued: ["release-warden"],
            });

            await writeFile(rosterPath, "[[duty]\nid = ", "utf8");
            await expect(module.open(database.context)).resolves.toMatchObject({ stopped: [] });
            await expect(module.duty(database.context, agentId)).resolves.toMatchObject({
                status: "active",
            });

            await writeFile(rosterPath, "", "utf8");
            await expect(module.open(database.context)).resolves.toMatchObject({
                stopped: ["release-warden"],
            });
            await expect(module.duty(database.context, agentId)).resolves.toMatchObject({
                status: "stopped",
            });
        } finally {
            module.stop();
            database.close();
        }
    });

    it("issues a declared Duty once, however many times a machine restarts", async () => {
        const module = new DutyModule(undefined, projectsFor());
        const database = moduleDatabase(module.migrations, "duty-reconcile-test");
        const agents = recordingAgents();
        await database.ready;
        module.beforeStart(database.context, agents.ref);
        const agentId = dutyAgentId(declaration.dutyId, declaration.tenureId, declaration.project);
        try {
            const first = await module.reconcile(database.context, [declaration]);
            expect(first).toMatchObject({ issued: ["release-warden"], notices: [], unchanged: [] });
            expect(agents.wakes).toHaveLength(1);

            const second = await module.reconcile(database.context, [declaration]);
            expect(second).toMatchObject({
                issued: [],
                notices: [],
                unchanged: ["release-warden"],
            });
            expect(agents.wakes).toHaveLength(1);
            await expect(module.runs(database.context, agentId)).resolves.toHaveLength(1);
        } finally {
            module.stop();
            database.close();
        }
    });

    it("serializes concurrent reconciliation of the same declaration", async () => {
        const module = new DutyModule(undefined, projectsFor());
        const database = moduleDatabase(module.migrations, "duty-reconcile-concurrency-test");
        const agents = recordingAgents();
        await database.ready;
        module.beforeStart(database.context, agents.ref);
        try {
            const outcomes = await Promise.all([
                module.reconcile(database.context, [declaration]),
                module.reconcile(database.context, [declaration]),
            ]);

            expect(outcomes.flatMap((outcome) => outcome.issued)).toEqual(["release-warden"]);
            expect(outcomes.flatMap((outcome) => outcome.unchanged)).toEqual(["release-warden"]);
            expect(agents.wakes).toHaveLength(1);
        } finally {
            module.stop();
            database.close();
        }
    });

    it("hands the same responsibility to a new tenure", async () => {
        const module = new DutyModule(undefined, projectsFor());
        const database = moduleDatabase(module.migrations, "duty-succession-test");
        const agents = recordingAgents();
        await database.ready;
        module.beforeStart(database.context, agents.ref);
        const firstAgentId = dutyAgentId(
            declaration.dutyId,
            declaration.tenureId,
            declaration.project,
        );
        const secondAgentId = dutyAgentId(declaration.dutyId, "tenure-2", declaration.project);
        try {
            await module.reconcile(database.context, [declaration]);
            await module.reconcile(database.context, [{ ...declaration, tenureId: "tenure-2" }]);

            expect(secondAgentId).not.toBe(firstAgentId);
            await expect(module.duty(database.context, firstAgentId)).resolves.toMatchObject({
                status: "stopped",
                tenureId: "tenure-1",
            });
            await expect(module.duty(database.context, secondAgentId)).resolves.toMatchObject({
                status: "active",
                tenureId: "tenure-2",
            });
            await expect(module.runs(database.context, firstAgentId)).resolves.toEqual([
                expect.objectContaining({
                    error: "Duty stopped by its issuer.",
                    status: "failed",
                }),
            ]);
            await expect(module.runs(database.context, secondAgentId)).resolves.toEqual([
                expect.objectContaining({ status: "queued", tenureId: "tenure-2" }),
            ]);
        } finally {
            module.stop();
            database.close();
        }
    });

    it("replaces an interactively managed Duty without making it roster-owned", async () => {
        const module = new DutyModule(
            {
                models: [
                    {
                        defaultEffort: "medium",
                        id: "openai/gpt-5.6-sol",
                        providerId: "codex",
                    },
                ],
            } as unknown as ConfigModule,
            projectsFor(),
        );
        const database = moduleDatabase(module.migrations, "duty-managed-succession-test");
        const agents = recordingAgents();
        await database.ready;
        module.beforeStart(database.context, agents.ref);
        const firstAgentId = dutyAgentId(
            declaration.dutyId,
            declaration.tenureId,
            declaration.project,
        );
        const secondAgentId = dutyAgentId(declaration.dutyId, "tenure-2", declaration.project);
        try {
            const first = await module.issueManagedDuty(database.context, declaration);
            const repeated = await module.issueManagedDuty(database.context, declaration);
            const replacement = await module.issueManagedDuty(database.context, {
                ...declaration,
                tenureId: "tenure-2",
            });

            expect(repeated.run.runId).toBe(first.run.runId);
            expect(agents.wakes).toHaveLength(2);
            expect(agents.wakes[1]).toMatchObject({
                effort: "medium",
                model: "openai/gpt-5.6-sol",
                provider: "codex",
            });
            expect(replacement.duty).toMatchObject({
                agentId: secondAgentId,
                status: "active",
                tenureId: "tenure-2",
            });
            expect(replacement.duty).not.toHaveProperty("roster");
            await expect(module.duty(database.context, firstAgentId)).resolves.toMatchObject({
                status: "stopped",
            });
            await expect(module.activeDuty(database.context, declaration.dutyId)).resolves.toEqual(
                replacement.duty,
            );

            // An empty machine roster must not prune a Duty issued through ordinary Rig chat.
            await module.reconcile(database.context, []);
            await expect(module.duty(database.context, secondAgentId)).resolves.toMatchObject({
                status: "active",
            });
        } finally {
            module.stop();
            database.close();
        }
    });

    it("stops a roster Duty that is absent from the next authoritative roster", async () => {
        const module = new DutyModule(undefined, projectsFor());
        const database = moduleDatabase(module.migrations, "duty-reconcile-removal-test");
        const agents = recordingAgents();
        await database.ready;
        module.beforeStart(database.context, agents.ref);
        const agentId = dutyAgentId(declaration.dutyId, declaration.tenureId, declaration.project);
        try {
            await module.reconcile(database.context, [declaration]);
            const outcome = await module.reconcile(database.context, []);

            expect(outcome).toMatchObject({ stopped: ["release-warden"] });
            await expect(module.duty(database.context, agentId)).resolves.toMatchObject({
                status: "stopped",
            });
        } finally {
            module.stop();
            database.close();
        }
    });

    it("preserves roster duties when the roster read was not authoritative", async () => {
        const module = new DutyModule(undefined, projectsFor());
        const database = moduleDatabase(module.migrations, "duty-reconcile-invalid-roster-test");
        const agents = recordingAgents();
        await database.ready;
        module.beforeStart(database.context, agents.ref);
        const agentId = dutyAgentId(declaration.dutyId, declaration.tenureId, declaration.project);
        try {
            await module.reconcile(database.context, [declaration]);
            const outcome = await module.reconcile(database.context, [], {
                authoritative: false,
            });

            expect(outcome.stopped).toEqual([]);
            await expect(module.duty(database.context, agentId)).resolves.toMatchObject({
                status: "active",
            });
        } finally {
            module.stop();
            database.close();
        }
    });

    it("never prunes a Duty issued outside the local roster", async () => {
        const module = new DutyModule(undefined, projectsFor());
        const database = moduleDatabase(module.migrations, "duty-reconcile-external-test");
        const agents = recordingAgents();
        await database.ready;
        module.beforeStart(database.context, agents.ref);
        try {
            await module.issueDuty(database.context, "external-agent", issued);
            const outcome = await module.reconcile(database.context, []);

            expect(outcome.stopped).toEqual([]);
            const binding = await module.duty(database.context, "external-agent");
            expect(binding).toMatchObject({ status: "active" });
            expect(binding?.roster).toBeUndefined();
        } finally {
            module.stop();
            database.close();
        }
    });

    it("reissues changed authority instead of silently keeping a stale declaration", async () => {
        const module = new DutyModule(undefined, projectsFor());
        const database = moduleDatabase(module.migrations, "duty-reconcile-drift-test");
        const agents = recordingAgents();
        await database.ready;
        module.beforeStart(database.context, agents.ref);
        const agentId = dutyAgentId(declaration.dutyId, declaration.tenureId, declaration.project);
        try {
            await module.reconcile(database.context, [declaration]);
            const outcome = await module.reconcile(database.context, [
                { ...declaration, allowedTools: [], charter: "Keep releases secure." },
            ]);

            expect(outcome).toMatchObject({ updated: ["release-warden"] });
            await expect(module.duty(database.context, agentId)).resolves.toMatchObject({
                allowedTools: [],
                charter: "Keep releases secure.",
                status: "active",
            });
            expect(agents.wakes).toHaveLength(2);
        } finally {
            module.stop();
            database.close();
        }
    });

    it("reports a Duty it could not bind and still binds the others", async () => {
        const module = new DutyModule(undefined, projectsFor({ failingPath: "/gone" }));
        const database = moduleDatabase(module.migrations, "duty-reconcile-failure-test");
        await database.ready;
        module.beforeStart(database.context, recordingAgents().ref);
        try {
            const outcome = await module.reconcile(database.context, [
                { ...declaration, dutyId: "unbindable", project: "/gone" },
                declaration,
            ]);
            expect(outcome.issued).toEqual(["release-warden"]);
            expect(outcome.notices).toEqual([
                expect.stringContaining('Duty "unbindable" was not bound: that folder is gone'),
            ]);
        } finally {
            module.stop();
            database.close();
        }
    });
});
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
