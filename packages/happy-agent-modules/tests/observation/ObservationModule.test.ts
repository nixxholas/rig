import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext, withLogContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { loadHappyAgentConfiguration } from "../../sources/config/index.js";
import type { HistoryMessage } from "../../sources/history/HistoryMessage.js";
import { ObservationModule } from "../../sources/observation/ObservationModule.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

async function configurationIn(root: string) {
    return await loadHappyAgentConfiguration(join(root, ".happy"));
}

async function temporaryRoot(name: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), name));
    temporaryDirectories.push(root);
    return root;
}

function message(recordId: string, text: string): HistoryMessage {
    return { blocks: [{ type: "text", text }], recordId, role: "assistant" };
}

describe("ObservationModule", () => {
    it("logs to a file through the context it installs", async () => {
        const root = await temporaryRoot("happy-observation-module-");
        const configuration = await configurationIn(root);
        const observation = await ObservationModule.start({ configuration, environment: {} });

        const ctx = withLogContext(observation.install(createRootContext()), {
            agentId: "agent1",
        });
        ctx.log.info("The agent said something.");
        ctx.log.debug("Quieter than the configured level.");
        await observation.flush();

        const written = await readFile(configuration.paths.logPath, "utf8");
        const records = written
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            agentId: "agent1",
            msg: "The agent said something.",
            name: "happy-agent",
        });

        await observation.close();
    });

    it("writes no history dump until it is asked for one", async () => {
        const root = await temporaryRoot("happy-observation-module-off-");
        const configuration = await configurationIn(root);
        const observation = await ObservationModule.start({ configuration, environment: {} });

        await observation.recordHistory(createRootContext(), "agent1", [message("r1", "hello")]);
        await observation.flush();

        expect(observation.settings.historyDump).toBe(false);
        await expect(readdir(configuration.paths.historyDumpHome)).rejects.toThrow();

        await observation.close();
    });

    it("dumps committed history when the environment turns it on", async () => {
        const root = await temporaryRoot("happy-observation-module-dump-");
        const configuration = await configurationIn(root);
        const observation = await ObservationModule.start({
            configuration,
            environment: { HAPPY_OBSERVATION_HISTORY_DUMP: "true" },
        });

        await observation.recordHistory(createRootContext(), "agent1", [message("r1", "hello")]);
        await observation.flush();

        const dumped = await readFile(
            join(configuration.paths.historyDumpHome, "agent1.jsonl"),
            "utf8",
        );
        expect(JSON.parse(dumped.trimEnd())).toMatchObject({ agentId: "agent1", recordId: "r1" });

        await observation.close();
    });

    it("installs nothing when logging and tracing are both off", async () => {
        const root = await temporaryRoot("happy-observation-module-silent-");
        const configuration = await configurationIn(root);
        const observation = await ObservationModule.start({
            configuration,
            environment: { HAPPY_OBSERVATION_LOGS: "false" },
        });

        const rootCtx = createRootContext();
        expect(observation.install(rootCtx)).toBe(rootCtx);
        // A span with no tracer installed simply runs its work, so nothing costs anything.
        expect(await rootCtx.span("agent.turn", async () => "done")).toBe("done");
        await expect(readdir(configuration.paths.observationHome)).rejects.toThrow();

        await observation.close();
    });

    it("closes once, and stays closed", async () => {
        const root = await temporaryRoot("happy-observation-module-close-");
        const configuration = await configurationIn(root);
        const observation = await ObservationModule.start({ configuration, environment: {} });

        await observation.close();
        await expect(observation.close()).resolves.toBeUndefined();
    });
});
