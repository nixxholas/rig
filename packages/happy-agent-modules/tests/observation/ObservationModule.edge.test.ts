import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext, withLogContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";
import type { HistoryMessage } from "../../sources/history/index.js";
import { ObservationModule } from "../../sources/observation/ObservationModule.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

async function temporaryRoot(name: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), name));
    temporaryDirectories.push(root);
    return root;
}

function message(recordId: string, text: string): HistoryMessage {
    return { blocks: [{ type: "text", text }], recordId, role: "assistant" };
}

async function configIn(root: string): Promise<ConfigModule> {
    return await ConfigModule.load(join(root, ".happy"));
}

function logRecords(raw: string): Array<Record<string, unknown>> {
    return raw
        .trimEnd()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("ObservationModule edge cases", () => {
    it("uses the installed root only, leaving contexts derived from the old root silent", async () => {
        const root = await temporaryRoot("happy-observation-install-");
        const config = await configIn(root);
        const observation = await ObservationModule.start(config);
        const original = createRootContext();
        const installed = observation.install(original);

        withLogContext(original, { source: "old-root" }).log.info("must not be written");
        withLogContext(installed, { source: "installed-root" }).log.info("must be written");
        await observation.close();

        const records = logRecords(await readFile(config.configuration.paths.logPath, "utf8"));
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            source: "installed-root",
            msg: "must be written",
        });
    });

    it("keeps the history dump independent from logging", async () => {
        vi.stubEnv("HAPPY_OBSERVATION_LOGS", "false");
        vi.stubEnv("HAPPY_OBSERVATION_HISTORY_DUMP", "true");
        const root = await temporaryRoot("happy-observation-independent-");
        const config = await configIn(root);
        const observation = await ObservationModule.start(config);

        await observation.recordHistory(createRootContext(), "agent1", [message("r1", "hello")]);
        await observation.flush();
        await observation.close();

        expect(
            await readFile(
                join(config.configuration.paths.historyDumpHome, "agent1.jsonl"),
                "utf8",
            ),
        ).toContain('"recordId":"r1"');
        await expect(readFile(config.configuration.paths.logPath, "utf8")).rejects.toThrow();
    });

    it("creates no observation files when every sink is disabled", async () => {
        vi.stubEnv("HAPPY_OBSERVATION_LOGS", "false");
        vi.stubEnv("HAPPY_OBSERVATION_HISTORY_DUMP", "false");
        vi.stubEnv("HAPPY_OBSERVATION_TRACES", "false");
        const root = await temporaryRoot("happy-observation-disabled-");
        const config = await configIn(root);
        const observation = await ObservationModule.start(config);

        const installed = observation.install(createRootContext());
        await installed.span("silent", async (ctx) => {
            ctx.log.info("silent");
            return "complete";
        });
        await observation.close();

        await expect(readdir(config.configuration.paths.observationHome)).rejects.toThrow();
    });

    it("installs an optional tracer without making tracing part of the caller's work", async () => {
        vi.stubEnv("HAPPY_OBSERVATION_LOGS", "false");
        vi.stubEnv("HAPPY_OBSERVATION_TRACES", "true");
        vi.stubEnv("HAPPY_OBSERVATION_TRACES_ENDPOINT", "http://127.0.0.1:1/v1/traces");
        const root = await temporaryRoot("happy-observation-tracing-");
        const config = await configIn(root);
        const observation = await ObservationModule.start(config);

        const installed = observation.install(createRootContext());
        await expect(
            installed.span("agent.turn", async (ctx) => {
                return await ctx.span("agent.inference", async () => "done");
            }),
        ).resolves.toBe("done");
        await expect(observation.close()).resolves.toBeUndefined();
    });

    it("labels traces with the deployment it was started for", async () => {
        vi.stubEnv("HAPPY_OBSERVATION_LOGS", "false");
        vi.stubEnv("HAPPY_OBSERVATION_TRACES", "true");
        vi.stubEnv("HAPPY_OBSERVATION_TRACES_ENDPOINT", "http://127.0.0.1:1/v1/traces");
        const root = await temporaryRoot("happy-observation-deployment-");
        const config = await configIn(root);
        const observation = await ObservationModule.start(config, "local-development");

        const installed = observation.install(createRootContext());
        await expect(installed.span("agent.turn", async () => "done")).resolves.toBe("done");
        await expect(observation.close()).resolves.toBeUndefined();
    });

    it("logs every lifecycle hook with its stable identifiers and outcome", async () => {
        vi.stubEnv("HAPPY_OBSERVATION_LOG_LEVEL", "trace");
        const root = await temporaryRoot("happy-observation-hooks-");
        const config = await configIn(root);
        const observation = await ObservationModule.start(config);
        const ctx = observation.install(createRootContext());
        const hooks = observation.beforeStart();
        const scope = {
            agent: { id: "agent1" },
            kv: {},
            sharedKV: {},
            runKV: {},
            historyKV: {},
        };

        hooks.beforeAgentLoop?.(ctx, scope as never, { loopId: "loop1" });
        hooks.beforeTurn?.(ctx, scope as never, {
            loopId: "loop1",
            turnId: "turn1",
            contextTokens: 42,
        });
        hooks.afterTurn?.(ctx, scope as never, {
            loopId: "loop1",
            turnId: "turn1",
            contextTokens: 42,
            aborted: true,
        });
        hooks.afterInference?.(
            ctx,
            scope as never,
            {
                loopId: "loop1",
                turnId: "turn1",
                contextTokens: 42,
                inferenceId: "inference1",
                state: "completed",
                tokens: { input: 3, output: 4 },
            } as never,
        );
        hooks.afterInference?.(
            ctx,
            scope as never,
            {
                loopId: "loop1",
                turnId: "turn1",
                contextTokens: undefined,
                inferenceId: "inference2",
                state: undefined,
                tokens: undefined,
                errorMessage: "provider failed",
            } as never,
        );
        hooks.afterToolCall?.(
            ctx,
            scope as never,
            {
                callId: "call1",
                tool: { name: "read_file" },
                arguments: {},
                content: [],
                isError: false,
            } as never,
        );
        hooks.afterToolCall?.(
            ctx,
            scope as never,
            {
                callId: "call2",
                tool: { name: "write_file" },
                arguments: {},
                content: [],
                isError: true,
            } as never,
        );
        for (const status of ["cancelled", "completed", "failed"] as const) {
            hooks.afterCompaction?.(
                ctx,
                scope as never,
                {
                    loopId: "loop1",
                    turnId: "turn1",
                    contextTokens: undefined,
                    compactionId: `compact-${status}`,
                    result: { status },
                } as never,
            );
        }
        hooks.afterAgentSettled?.(ctx, scope as never, {
            loopId: "loop1",
            settlementId: "settlement1",
        });

        await observation.flush();
        await observation.close();

        const records = logRecords(await readFile(config.configuration.paths.logPath, "utf8"));
        expect(records).toHaveLength(11);
        expect(records.map((record) => record.msg)).toEqual([
            "The agent started a run.",
            "The agent started a turn.",
            "The agent's turn was cancelled.",
            "The model answered.",
            "The model did not answer: provider failed",
            "The read_file tool finished.",
            "The write_file tool reported a failure.",
            "Compacting the conversation was cancelled.",
            "The conversation was compacted.",
            "Compacting the conversation failed.",
            "The agent has nothing left to do.",
        ]);
        expect(records[0]).toMatchObject({ agentId: "agent1", loopId: "loop1" });
        expect(records[3]).toMatchObject({
            inferenceId: "inference1",
            inputTokens: 3,
            outputTokens: 4,
            state: "completed",
        });
        expect(records[4]).toMatchObject({ inferenceId: "inference2" });
    });

    it("does not emit history after the module is closed", async () => {
        vi.stubEnv("HAPPY_OBSERVATION_HISTORY_DUMP", "true");
        const root = await temporaryRoot("happy-observation-closed-history-");
        const config = await configIn(root);
        const observation = await ObservationModule.start(config);

        await observation.close();
        await observation.recordHistory(createRootContext(), "agent1", [message("r1", "ignored")]);
        await observation.flush();

        await expect(
            readFile(join(config.configuration.paths.historyDumpHome, "agent1.jsonl"), "utf8"),
        ).rejects.toThrow();
    });
});
