import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { readValidatedBody } from "./body.js";
import { AgentHttpError, sendJson } from "./errors.js";
import {
    createRouteGroup,
    type AgentHttpRouteContext,
    type AgentHttpRouteGroup,
} from "./router.js";

const exact = { additionalProperties: false } as const;
const emptyArray = Type.Array(Type.Never(), { maxItems: 0 });
const sessionTerminalHeartbeatSchema = Type.Object(
    {
        connectionId: Type.String({ minLength: 1, maxLength: 128 }),
        focused: Type.Boolean(),
        targetPid: Type.Integer({ minimum: 0 }),
    },
    exact,
);

export const emptyFoldersResponseSchema = Type.Object(
    {
        folders: emptyArray,
        items: emptyArray,
        revision: Type.Literal(0),
    },
    exact,
);

export const emptyPluginsResponseSchema = Type.Object(
    {
        cursor: Type.String({ minLength: 1 }),
        failures: emptyArray,
        plugins: emptyArray,
        version: Type.Literal("empty"),
    },
    exact,
);

export const emptyWorkletsResponseSchema = Type.Object(
    {
        version: Type.Literal("empty"),
        worklets: emptyArray,
    },
    exact,
);

export const unavailableP2pStatusSchema = Type.Object(
    {
        name: Type.String({ minLength: 1, maxLength: 128 }),
        transports: emptyArray,
    },
    exact,
);

export const completedOnboardingResponseSchema = Type.Object(
    {
        onboardingVersion: Type.Literal(2),
        state: Type.Literal("complete"),
    },
    exact,
);

const unavailableCloudCapabilitySchema = Type.Object(
    {
        changedAt: Type.Literal(0),
        consent: Type.Literal("denied"),
    },
    exact,
);

export const unavailableHappyCloudResponseSchema = Type.Object(
    {
        authority: Type.Literal("local_record_only"),
        capabilities: Type.Object(
            {
                group_chats: unavailableCloudCapabilitySchema,
                happy_profile: unavailableCloudCapabilitySchema,
                remote_control: unavailableCloudCapabilitySchema,
                session_blob_persistence: unavailableCloudCapabilitySchema,
            },
            exact,
        ),
        contractVersion: Type.Literal(1),
        enrollment: Type.Object(
            {
                changedAt: Type.Literal(0),
                state: Type.Literal("not_enrolled"),
            },
            exact,
        ),
        profile: Type.Object(
            {
                changedAt: Type.Literal(0),
                state: Type.Literal("not_created"),
            },
            exact,
        ),
        updatedAt: Type.Literal(0),
        version: Type.Literal(0),
    },
    exact,
);

export const emptyExternalToolCallsResponseSchema = Type.Object({ calls: emptyArray }, exact);

const providerUsageTokensSchema = Type.Object(
    {
        inferences: Type.Integer({ minimum: 0 }),
        input: Type.Integer({ minimum: 0 }),
        output: Type.Integer({ minimum: 0 }),
        total: Type.Integer({ minimum: 0 }),
        turns: Type.Integer({ minimum: 0 }),
    },
    exact,
);

/**
 * One provider's usage, as this installation is able to answer it.
 *
 * `usage` carries a vendor's own plan and rate-limit reading, which Happy Agent never asks for,
 * so it stays null and nothing failed to produce it. `tokens` is what the installation measured
 * itself: every inference and turn recorded against that provider, across every chat.
 */
const providerUsageEntrySchema = Type.Object(
    {
        checkedAt: Type.Integer({ minimum: 0 }),
        error: Type.Null(),
        providerId: Type.String({ minLength: 1, maxLength: 256 }),
        tokens: providerUsageTokensSchema,
        usage: Type.Null(),
    },
    exact,
);

export const providerUsageResponseSchema = Type.Object(
    { providers: Type.Array(providerUsageEntrySchema, { maxItems: 512 }) },
    exact,
);

type ProviderUsageTokens = Static<typeof providerUsageTokensSchema>;

/** Protocol-valid read snapshots for Rig features Happy Agent does not host yet. */
export function createCompatibilitySnapshots(
    cursor: string,
    options: {
        readonly p2pName?: string;
    } = {},
) {
    const denied = { changedAt: 0, consent: "denied" } as const;
    return {
        externalToolCalls: validateSnapshot(emptyExternalToolCallsResponseSchema, { calls: [] }),
        folders: validateSnapshot(emptyFoldersResponseSchema, {
            folders: [],
            items: [],
            revision: 0,
        }),
        happyCloud: validateSnapshot(unavailableHappyCloudResponseSchema, {
            authority: "local_record_only",
            capabilities: {
                group_chats: denied,
                happy_profile: denied,
                remote_control: denied,
                session_blob_persistence: denied,
            },
            contractVersion: 1,
            enrollment: { changedAt: 0, state: "not_enrolled" },
            profile: { changedAt: 0, state: "not_created" },
            updatedAt: 0,
            version: 0,
        }),
        onboarding: validateSnapshot(completedOnboardingResponseSchema, {
            onboardingVersion: 2,
            state: "complete",
        }),
        p2p: validateSnapshot(unavailableP2pStatusSchema, {
            name: options.p2pName ?? "Happy Agent",
            transports: [],
        }),
        plugins: validateSnapshot(emptyPluginsResponseSchema, {
            cursor,
            failures: [],
            plugins: [],
            version: "empty",
        }),
        worklets: validateSnapshot(emptyWorkletsResponseSchema, {
            version: "empty",
            worklets: [],
        }),
    };
}

export type CompatibilitySnapshots = ReturnType<typeof createCompatibilitySnapshots>;

export function createCompatibilityRoutes(): AgentHttpRouteGroup {
    return createRouteGroup("rig-compatibility", [
        readRoute("/v0/folders", "folders"),
        readRoute("/v0/plugins", "plugins"),
        readRoute("/v0/worklets", "worklets"),
        readRoute("/v0/p2p/status", "p2p"),
        readRoute("/v0/onboarding", "onboarding"),
        readRoute("/v0/happy-cloud/status", "happyCloud"),
        {
            method: "GET",
            path: "/v0/provider-usage",
            handle: async (context) => {
                sendJson(context.response, 200, await readProviderUsage(context));
            },
        },
        readRoute("/v0/external-tool-calls", "externalToolCalls"),
        readRoute("/v0/sessions/:sessionId/external-tool-calls", "externalToolCalls"),
        {
            method: "PUT",
            path: "/v0/sessions/:sessionId/terminal-connections/:connectionId",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const route = sessionTerminalRoute(url);
                const body = await readValidatedBody(request, sessionTerminalHeartbeatSchema);
                if (body.connectionId !== route.connectionId) {
                    throw new AgentHttpError(
                        400,
                        "Terminal connection settings do not match the route.",
                    );
                }
                if (
                    (await dependencies.agent.modules.conversations.get(ctx, route.sessionId)) ===
                    undefined
                ) {
                    throw new AgentHttpError(404, "Session not found.");
                }
                sendJson(response, 200, { connected: true });
            },
        },
        {
            method: "DELETE",
            path: "/v0/sessions/:sessionId/terminal-connections/:connectionId",
            handle: async ({ ctx, dependencies, response, url }) => {
                const route = sessionTerminalRoute(url);
                if (
                    (await dependencies.agent.modules.conversations.get(ctx, route.sessionId)) ===
                    undefined
                ) {
                    throw new AgentHttpError(404, "Session not found.");
                }
                sendJson(response, 200, { disconnected: true });
            },
        },
    ]);
}

function readRoute(
    path: string,
    snapshot: keyof CompatibilitySnapshots,
): AgentHttpRouteGroup["routes"][number] {
    return {
        method: "GET",
        path,
        handle: async ({ dependencies, response }) => {
            const snapshots = createCompatibilitySnapshots(
                dependencies.agent.modules.events.cursor(),
                {
                    p2pName:
                        dependencies.configuration?.p2pName ??
                        dependencies.agent.configuration.values.p2p.name,
                },
            );
            sendJson(response, 200, snapshots[snapshot]);
        },
    };
}

/**
 * Every provider this installation can run on, with the tokens it has spent so far.
 *
 * The usage module records one row per inference and per turn, attributed to the provider that
 * served it, for every agent in the installation. Summing those rows by provider is the whole
 * answer; a configured provider that has never run reports zeroes rather than being left out.
 */
async function readProviderUsage(
    context: Pick<AgentHttpRouteContext, "ctx" | "dependencies">,
): Promise<Static<typeof providerUsageResponseSchema>> {
    const { ctx, dependencies } = context;
    const summary = await dependencies.agent.modules.usage.aggregate(ctx);
    const totals = new Map<string, ProviderUsageTokens>();
    for (const providerId of dependencies.agent.providers.ids) totals.set(providerId, noTokens());
    for (const group of summary.groups) {
        const spent = totals.get(group.provider) ?? noTokens();
        totals.set(group.provider, {
            inferences: spent.inferences + group.inferenceCount,
            input: spent.input + group.inputTokens,
            output: spent.output + group.outputTokens,
            total: spent.total + group.totalTokens,
            turns: spent.turns + group.turnCount,
        });
    }
    const checkedAt = Date.now();
    return validateSnapshot(providerUsageResponseSchema, {
        providers: [...totals]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([providerId, tokens]) => ({
                checkedAt,
                error: null,
                providerId,
                tokens,
                usage: null,
            })),
    });
}

function noTokens(): ProviderUsageTokens {
    return { inferences: 0, input: 0, output: 0, total: 0, turns: 0 };
}

function validateSnapshot<Schema extends TSchema>(
    schema: Schema,
    value: Static<Schema>,
): Static<Schema> {
    if (!Value.Check(schema, value)) {
        throw new Error("Happy Agent created an invalid Rig compatibility snapshot.");
    }
    return value;
}

function sessionTerminalRoute(url: URL): {
    readonly connectionId: string;
    readonly sessionId: string;
} {
    const parts = url.pathname.split("/").filter(Boolean);
    const sessionId = parts[2];
    const connectionId = parts[4];
    if (
        parts.length !== 5 ||
        parts[0] !== "v0" ||
        parts[1] !== "sessions" ||
        parts[3] !== "terminal-connections" ||
        sessionId === undefined ||
        connectionId === undefined
    ) {
        throw new AgentHttpError(404, "Terminal connection route not found.");
    }
    return {
        connectionId: decodeURIComponent(connectionId),
        sessionId: decodeURIComponent(sessionId),
    };
}
