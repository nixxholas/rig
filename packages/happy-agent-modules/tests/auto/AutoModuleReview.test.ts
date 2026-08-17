import type {
    AgentBaseInferenceStart,
    AgentModel,
    AgentModuleScope,
    AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { SessionEvent } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { AutoModule, type AutoModuleOptions } from "../../sources/auto/index.js";
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

function errorTurn(): SessionEvent[] {
    return [
        {
            type: "done",
            state: "error",
            kind: "unknown",
            message: "review inference failed",
        } as never,
    ];
}

interface ReviewWorld {
    readonly auto: AutoModule;
    readonly provider: ScriptedProvider;
    close(): Promise<void>;
}

/**
 * Stand up a real `AutoModule` over a separate main-evidence database and a separate private review
 * store, start its private review system on a scripted provider, and teach it the reviewed agent's
 * live model route the way the base inference hook would.
 */
async function reviewWorld(
    script: SessionEvent[][],
    options: {
        readonly rememberRoute?: boolean;
        readonly recreateIdentity?: boolean;
        readonly readGlobalSecurity?: () => Promise<string | undefined>;
        readonly readProjectSecurity?: () => Promise<string | undefined>;
        readonly readAgentsMd?: (
            ctx: ReturnType<typeof createRootContext>,
            agentId: string,
        ) => Promise<string | undefined>;
        readonly signal?: AbortSignal;
        readonly signals?: readonly AbortSignal[];
    } = {},
): Promise<{
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
        readGlobalSecurity: options.readGlobalSecurity ?? (async () => undefined),
        readProjectSecurity: options.readProjectSecurity ?? (async () => undefined),
        ...(options.readAgentsMd === undefined ? {} : { readAgentsMd: options.readAgentsMd }),
    } as unknown as AutoModuleOptions);

    // The evidence archive lives in the main database; the review reads it through the review
    // context, so that context must carry the main database exactly as a permission hook's does.
    const mainDatabase = moduleDatabase(auto.migrations, "auto-main-evidence");
    await mainDatabase.ready;

    const hooks = await resolveModuleHooks(lifetime, auto, {} as unknown as AgentSystemRef);

    // A review is only ever requested mid-turn, so the reviewed agent's live model route has already
    // been observed by the base inference hook. Reproduce that one observation here.
    if (options.rememberRoute !== false) {
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
        if (options.recreateIdentity === true) {
            await hooks.agentCreatedTransact?.(mainDatabase.context, {} as never, {
                id: MAIN_AGENT_ID,
                metadata: undefined,
            });
        }
    }

    const request: Omit<PermissionReviewRequest, "signal"> & { readonly signal: AbortSignal } = {
        agentId: MAIN_AGENT_ID,
        callId: "call-under-review",
        // The reviewer only reads the tool's name and namespace to serialize the proposed action,
        // exactly as v1 did; a full tool definition is not needed to prove the review path.
        tool: { name: "publish" } as unknown as PermissionReviewRequest["tool"],
        arguments: { target: "/etc/hosts" },
        action: "Publish to /etc/hosts, outside the workspace.",
        mode: "auto",
        elevates: true,
        signal: options.signal ?? new AbortController().signal,
    };
    let reviewCount = 0;

    return {
        world: {
            auto,
            provider,
            close: async () => {
                await auto.close(lifetime);
                mainDatabase.close();
            },
        },
        review: () => {
            const signal =
                options.signals?.[reviewCount] ??
                (reviewCount === 0 ? request.signal : new AbortController().signal);
            reviewCount += 1;
            return auto.reviewer.review(mainDatabase.context, { ...request, signal });
        },
    };
}

const worlds: ReviewWorld[] = [];

afterEach(async () => {
    while (worlds.length > 0) {
        await worlds.pop()?.close();
    }
});

describe("AutoModule reviewer", () => {
    it("rejects a review requested before the private system starts", async () => {
        const context = createRootContext().named("auto-review-not-started");
        const privateStore = await agentWorld();
        const auto = new AutoModule({
            storage: privateStore.storage,
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            models: MODELS,
            workingDirectory: "/tmp/auto-review-not-started",
            lifetimeContext: context,
            reviewerTools: () => [],
            readGlobalSecurity: async () => undefined,
            readProjectSecurity: async () => undefined,
        });

        await expect(
            auto.reviewer.review(context, {
                agentId: MAIN_AGENT_ID,
                callId: "call",
                tool: { name: "read_file" } as PermissionReviewRequest["tool"],
                arguments: {},
                action: "Read a file.",
                mode: "auto",
                elevates: false,
                signal: new AbortController().signal,
            }),
        ).rejects.toThrow("The automatic permission review system is not running.");
        await auto.close(context);
    });

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

    it("maps a completed non-normal reviewer run to a rejected unreadable verdict", async () => {
        const { world, review } = await reviewWorld([errorTurn()]);
        worlds.push(world);

        const decision = await review();

        expect(decision).toMatchObject({
            outcome: "denied",
            reason: "The automatic permission review returned an unreadable decision.",
            risk: "medium",
            userAuthorization: "low",
        });
    });

    it("fails closed when no active main-agent route has been observed", async () => {
        const { world, review } = await reviewWorld(
            [
                verdictTurn(
                    JSON.stringify({
                        outcome: "allow",
                        risk_level: "low",
                        user_authorization: "high",
                    }),
                ),
            ],
            { rememberRoute: false },
        );
        worlds.push(world);

        await expect(review()).rejects.toThrow(
            'No active model route is known for agent "mainagentunderreview"',
        );
    });

    it("does not reuse a stale route after the main agent identity is recreated", async () => {
        const { world, review } = await reviewWorld(
            [
                verdictTurn(
                    JSON.stringify({
                        outcome: "allow",
                        risk_level: "low",
                        user_authorization: "high",
                    }),
                ),
            ],
            { recreateIdentity: true },
        );
        worlds.push(world);

        await expect(review()).rejects.toThrow(
            'No active model route is known for agent "mainagentunderreview"',
        );
    });

    it("does not start a review when its signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const { world, review } = await reviewWorld([], {
            signal: controller.signal,
        });
        worlds.push(world);

        await expect(review()).rejects.toThrow("Permission review was stopped.");
        expect(world.provider.sessions.every((session) => session.requests.length === 0)).toBe(
            true,
        );
    });

    it("reuses a normal reviewer session and sends a continued empty delta", async () => {
        const verdict = JSON.stringify({
            outcome: "allow",
            risk_level: "low",
            user_authorization: "high",
            rationale: "Routine.",
        });
        const { world, review } = await reviewWorld([verdictTurn(verdict), verdictTurn(verdict)]);
        worlds.push(world);

        await expect(review()).resolves.toMatchObject({ outcome: "allowed" });
        await expect(review()).resolves.toMatchObject({ outcome: "allowed" });

        const requests = world.provider.sessions.flatMap((session) => session.requests);
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(requests[0]?.context)).toContain("<conversation>");
        expect(JSON.stringify(requests[1]?.context)).toContain('<conversation continued="true">');
        expect(JSON.stringify(requests[1]?.context)).toContain(
            "No new conversation since your last review.",
        );
    });

    it("serializes concurrent reviews for one agent in FIFO order", async () => {
        const verdict = JSON.stringify({
            outcome: "deny",
            risk_level: "high",
            user_authorization: "unknown",
            rationale: "Not authorized.",
        });
        const { world, review } = await reviewWorld([verdictTurn(verdict), verdictTurn(verdict)]);
        worlds.push(world);

        const results = await Promise.all([review(), review()]);

        expect(results.map((result) => result.outcome)).toEqual(["denied", "denied"]);
        expect(world.provider.sessions.flatMap((session) => session.requests)).toHaveLength(2);
    });

    it("does not start a review whose signal aborts while waiting in the FIFO queue", async () => {
        let release!: () => void;
        let resolveFirstReview!: () => void;
        let reads = 0;
        const firstReviewEntered = new Promise<void>((resolve) => {
            resolveFirstReview = resolve;
        });
        const securityReader = async (): Promise<string | undefined> => {
            reads += 1;
            if (reads === 1) {
                resolveFirstReview();
                await new Promise<void>((resume) => {
                    release = resume;
                });
            }
            return undefined;
        };

        const firstSignal = new AbortController();
        const secondController = new AbortController();
        const verdict = JSON.stringify({
            outcome: "allow",
            risk_level: "low",
            user_authorization: "high",
        });
        const { world, review } = await reviewWorld([verdictTurn(verdict), verdictTurn(verdict)], {
            readGlobalSecurity: securityReader,
            signals: [firstSignal.signal, secondController.signal],
        });
        worlds.push(world);

        const first = review();
        await firstReviewEntered;
        const second = review();
        secondController.abort();
        release();
        await expect(first).resolves.toMatchObject({ outcome: "allowed" });
        await expect(second).rejects.toThrow("Permission review was stopped.");
        expect(world.provider.sessions.flatMap((session) => session.requests)).toHaveLength(1);
    });

    it("rebuilds the reviewer and resends the whole transcript after an abnormal run", async () => {
        const verdict = JSON.stringify({
            outcome: "allow",
            risk_level: "low",
            user_authorization: "high",
            rationale: "Routine.",
        });
        const { world, review } = await reviewWorld([errorTurn(), verdictTurn(verdict)]);
        worlds.push(world);

        await expect(review()).resolves.toMatchObject({ outcome: "denied" });
        await expect(review()).resolves.toMatchObject({ outcome: "allowed" });

        const requests = world.provider.sessions.flatMap((session) => session.requests);
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(requests[1]?.context)).not.toContain(
            '<conversation continued="true">',
        );
    });

    it("rereads security files and appends project instructions before every review", async () => {
        const verdict = JSON.stringify({
            outcome: "allow",
            risk_level: "low",
            user_authorization: "high",
            rationale: "Routine.",
        });
        const { world, review } = await reviewWorld([verdictTurn(verdict)], {
            readGlobalSecurity: async () => "GLOBAL_SECURITY_RULE",
            readProjectSecurity: async () => "PROJECT_SECURITY_RULE",
            readAgentsMd: async () => "FORMATTED_PROJECT_AGENT_RULES",
        });
        worlds.push(world);

        await review();

        const request = world.provider.sessions.flatMap((session) => session.requests)[0];
        expect(request?.context.instructions).toContain("GLOBAL_SECURITY_RULE");
        expect(request?.context.instructions).toContain("PROJECT_SECURITY_RULE");
        expect(request?.context.instructions).toContain("FORMATTED_PROJECT_AGENT_RULES");
    });

    it("propagates security-policy reader failures instead of reviewing partial policy", async () => {
        const { world, review } = await reviewWorld([], {
            readGlobalSecurity: async () => {
                throw new Error("security policy unreadable");
            },
        });
        worlds.push(world);

        await expect(review()).rejects.toThrow("security policy unreadable");
        expect(world.provider.sessions.every((session) => session.requests.length === 0)).toBe(
            true,
        );
    });
});
