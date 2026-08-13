import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AgentKV,
    AgentProviders,
    AgentStorage,
    AgentSystemLocal,
    type AgentFeature,
} from "../../sources/index.js";
import { askedIn, transcriptOf } from "../gym/chaosWorld.js";
import { InMemoryPersistence } from "../gym/InMemoryPersistence.js";
import { ScriptedProvider } from "../gym/ScriptedProvider.js";
import { providersOf, queued, textTurn, user } from "../gym/fixtures.js";

const ctx = createRootContext().named("happy-agent-base-manager-recovery-races");

interface Deferred {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
}

function deferred(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

function managerKV(persistence: InMemoryPersistence): AgentKV {
    return new AgentKV(persistence, "agents.");
}

async function collection(
    managerPersistence: InMemoryPersistence,
    agentPersistence: InMemoryPersistence,
    provider: ScriptedProvider,
    features: readonly AgentFeature[] = [],
): Promise<AgentSystemLocal> {
    return await AgentSystemLocal.create(
        ctx,
        new AgentStorage({
            kv: managerKV(managerPersistence),
            persistence: () => agentPersistence,
        }),
        { features, providers: providersOf(provider), provider: "scripted", models: [] },
    );
}

/**
 * These scenarios cross the boundary between a live Agent, its collection's discovery index,
 * and another collection over the same durable identity. A per-instance lock cannot make those
 * stores or owners agree; each test therefore fixes the exact shared snapshot both owners see.
 */
describe("manager recovery and live-owner consistency", () => {
    it("consumes one durable queue entry exactly once across two collections", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        managerDisk.values.set("agents.config.shared", {});
        // The message was accepted and never answered, so the agent is durably owing an answer.
        agentDisk.values.set("send.0001", queued(user("consume once")));
        agentDisk.values.set("owed", { stage: "inference" });

        const bothQueueSnapshotsTaken = deferred();
        const originalReadValues = agentDisk.readValues.bind(agentDisk);
        let queueReads = 0;
        agentDisk.readValues = async (readCtx, prefix) => {
            if (prefix === "send." && queueReads < 2) {
                const snapshot = await originalReadValues(readCtx, prefix);
                queueReads += 1;
                if (queueReads === 2) bothQueueSnapshotsTaken.resolve();
                await bothQueueSnapshotsTaken.promise;
                return snapshot;
            }
            return await originalReadValues(readCtx, prefix);
        };

        const firstProvider = new ScriptedProvider([textTurn("first owner")]);
        const secondProvider = new ScriptedProvider([textTurn("second owner")]);
        const starting = Promise.all([
            collection(managerDisk, agentDisk, firstProvider),
            collection(managerDisk, agentDisk, secondProvider),
        ]);
        await bothQueueSnapshotsTaken.promise;
        const [first, second] = await starting;

        const [firstAgent, secondAgent] = await Promise.all([
            first.resolve(ctx, "shared"),
            second.resolve(ctx, "shared"),
        ]);
        await Promise.all([firstAgent.waitForIdle(), secondAgent.waitForIdle()]);
        const totalRequests = [firstProvider, secondProvider].flatMap((provider) =>
            provider.sessions.flatMap((session) => session.requests),
        );
        const durableQuestions = askedIn(transcriptOf(agentDisk));
        await Promise.all([firstAgent.close(), secondAgent.close()]);

        expect({
            totalRequests: totalRequests.length,
            durableQuestions,
        }).toEqual({
            totalRequests: 1,
            durableQuestions: ["consume once"],
        });
    });

    it("refreshes durable settings and history before a stale live owner continues", async () => {
        const managerDisk = new InMemoryPersistence();
        const agentDisk = new InMemoryPersistence();
        managerDisk.values.set("agents.config.shared", {});

        const oldProvider = new ScriptedProvider([textTurn("stale answer")]);
        const newProvider = new ScriptedProvider([
            textTurn("answer after switch"),
            textTurn("answer after follow-up"),
        ]);
        const providers = new AgentProviders();
        providers.add("old", oldProvider, "codex");
        providers.add("new", newProvider, "claude");
        const owner = async () =>
            await AgentSystemLocal.create(
                ctx,
                new AgentStorage({
                    kv: managerKV(managerDisk),
                    persistence: () => agentDisk,
                }),
                { features: [], providers, provider: "old", models: [] },
            );
        const staleOwner = await owner();
        const writingOwner = await owner();
        const [staleAgent, writingAgent] = await Promise.all([
            staleOwner.resolve(ctx, "shared"),
            writingOwner.resolve(ctx, "shared"),
        ]);
        await Promise.all([staleAgent.waitForIdle(), writingAgent.waitForIdle()]);

        await writingOwner.send(ctx, "shared", user("switch and append"), {
            await: true,
            provider: "new",
            model: "new-model",
        });
        await writingAgent.waitForIdle();
        await staleOwner.send(ctx, "shared", user("continue from durable state"), { await: true });
        await staleAgent.waitForIdle();

        const requests = [
            ...oldProvider.sessions.flatMap((session) =>
                session.requests.map((request) => ({ provider: "old", request })),
            ),
            ...newProvider.sessions.flatMap((session) =>
                session.requests.map((request) => ({ provider: "new", request })),
            ),
        ];
        const continued = requests.find(({ request }) =>
            askedIn(request.context.messages).includes("continue from durable state"),
        );
        await Promise.all([staleAgent.close(), writingAgent.close()]);

        expect({
            provider: continued?.provider,
            model: continued?.request.model,
            questions: continued === undefined ? [] : askedIn(continued.request.context.messages),
        }).toEqual({
            provider: "new",
            model: "new-model",
            questions: ["switch and append", "continue from durable state"],
        });
    });
});
