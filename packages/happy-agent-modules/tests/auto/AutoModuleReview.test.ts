import type {
    AgentBaseInferenceStart,
    AgentModel,
    AgentModuleScope,
    AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { SessionEvent } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { AutoModule } from "../../sources/auto/index.js";
import type { PermissionReviewRequest } from "../../sources/permissions/PermissionReviewer.js";
import { agentWorld } from "../support/agentWorld.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { providersOf } from "../support/fixtures.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

/**
 * End-to-end proof that a reviewable Auto action reaches the real `AutoModule` reviewer and that a
 * reviewer verdict allows or denies exactly as Rig v1 would.
 *
 * The reviewer is not mocked here: `AutoModule` builds its own private `AgentSystemLocal`, creates a
 * reviewer agent, runs one real review inference through a scripted provider that answers with the
 * guardian's JSON verdict, parses that verdict, and re-derives the allow policy. Only model
 * inference is scripted; the archive, private system, reviewer lifecycle, prompt, and verdict
 * parsing are the production code paths a daemon uses in Auto mode.
 */

/** The one main-agent route the reviewer resolves its model from; a `gym`-typed scripted provider. */
const MODELS: AgentModel[] = [
    {
        providerId: "scripted",
        id: "scripted/model",
        name: "Scripted",
        effortLevels: ["low"],
        defaultEffort: "low",
    },
];

const MAIN_AGENT_ID = "mainagentunderreview";

/** A scripted review turn: the reviewer says one text message — its JSON verdict — and settles. */
function verdictTurn(json: string): SessionEvent[] {
    return [
        { type: "text_start" },
        { type: "text_delta", delta: json },
        { type: "text_end" },
        { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
    ];
}

interface ReviewWorld {
    readonly auto: AutoModule;
    close(): Promise<void>;
}

/**
 * Stand up a real `AutoModule` over a separate main-evidence database and a separate private review
 * store, start its private review system on a scripted provider, and teach it the reviewed agent's
 * live model route the way the base inference hook would.
 */
async function reviewWorld(script: SessionEvent[][]): Promise<{
    world: ReviewWorld;
    review(): Promise<Awaited<ReturnType<AutoModule["reviewer"]["review"]>>>;
}> {
    const lifetime = createRootContext().named("auto-review-system-test");
    const privateStore = await agentWorld();
    const provider = new ScriptedProvider(script);

    const auto = new AutoModule({
        storage: privateStore.storage,
        providers: providersOf(provider),
        provider: "scripted",
        models: MODELS,
        workingDirectory: "/tmp/auto-review-test",
        lifetimeContext: lifetime,
        reviewerTools: () => [],
        readGlobalSecurity: async () => undefined,
        readProjectSecurity: async () => undefined,
    });

    // The evidence archive lives in the main database; the review reads it through the review
    // context, so that context must carry the main database exactly as a permission hook's does.
    const mainDatabase = moduleDatabase(auto.migrations, "auto-main-evidence");
    await mainDatabase.ready;

    const hooks = await resolveModuleHooks(lifetime, auto, {} as unknown as AgentSystemRef);

    // A review is only ever requested mid-turn, so the reviewed agent's live model route has already
    // been observed by the base inference hook. Reproduce that one observation here.
    hooks.beforeInference!(
        mainDatabase.context,
        {
            agent: {
                id: MAIN_AGENT_ID,
                provider: "scripted",
                model: "scripted/model",
                effort: "low",
            },
        } as unknown as AgentModuleScope,
        {} as unknown as AgentBaseInferenceStart,
    );

    const request: PermissionReviewRequest = {
        agentId: MAIN_AGENT_ID,
        callId: "call-under-review",
        // The reviewer only reads the tool's name and namespace to serialize the proposed action,
        // exactly as v1 did; a full tool definition is not needed to prove the review path.
        tool: { name: "publish" } as unknown as PermissionReviewRequest["tool"],
        arguments: { target: "/etc/hosts" },
        action: "Publish to /etc/hosts, outside the workspace.",
        mode: "auto",
        elevates: true,
        signal: new AbortController().signal,
    };

    return {
        world: {
            auto,
            close: async () => {
                await auto.close(lifetime);
                mainDatabase.close();
            },
        },
        review: () => auto.reviewer.review(mainDatabase.context, request),
    };
}

const worlds: ReviewWorld[] = [];

afterEach(async () => {
    while (worlds.length > 0) {
        await worlds.pop()?.close();
    }
});

describe("AutoModule reviewer", () => {
    it("allows an action when the reviewer's verdict allows it", async () => {
        const { world, review } = await reviewWorld([
            verdictTurn(
                JSON.stringify({
                    risk_level: "low",
                    user_authorization: "high",
                    outcome: "allow",
                    rationale: "Reading a well-known file is safe.",
                }),
            ),
        ]);
        worlds.push(world);

        const decision = await review();

        expect(decision.outcome).toBe("allowed");
        expect(decision.risk).toBe("low");
    });

    it("denies an action when the reviewer's verdict denies it", async () => {
        const { world, review } = await reviewWorld([
            verdictTurn(
                JSON.stringify({
                    risk_level: "high",
                    user_authorization: "unknown",
                    outcome: "deny",
                    rationale: "Writing outside the workspace is not authorized.",
                }),
            ),
        ]);
        worlds.push(world);

        const decision = await review();

        expect(decision.outcome).toBe("denied");
        expect(decision.reason).toContain("Writing outside the workspace");
    });

    it("denies a high-risk allow the independent policy rejects", async () => {
        // v1 parity: the reviewer may say "allow", but a high-risk action without at least medium
        // user authorization is re-derived to a denial by the allow policy, defense in depth.
        const { world, review } = await reviewWorld([
            verdictTurn(
                JSON.stringify({
                    risk_level: "high",
                    user_authorization: "unknown",
                    outcome: "allow",
                    rationale: "The model thought this was fine.",
                }),
            ),
        ]);
        worlds.push(world);

        const decision = await review();

        expect(decision.outcome).toBe("denied");
    });
});
