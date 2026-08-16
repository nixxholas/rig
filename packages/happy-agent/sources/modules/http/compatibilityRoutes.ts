import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import type { LoadedHappyAgent } from "../agent/loadHappyAgent.js";

import { readValidatedBody } from "./body.js";
import { AgentHttpError, sendJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";
import { defaultRigPresence, type RigPresenceConfiguration } from "./rigProtocol.js";

const exact = { additionalProperties: false } as const;
const emptyArray = Type.Array(Type.Never(), { maxItems: 0 });
const presenceSummarySchema = Type.Object(
    {
        answerWaitMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
        emoji: Type.String({ minLength: 1 }),
        id: Type.String({ minLength: 1 }),
        prompt: Type.String({ minLength: 1 }),
        title: Type.String({ minLength: 1 }),
    },
    exact,
);
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

export const emptyProfilesResponseSchema = Type.Object({ profiles: emptyArray }, exact);

export const unavailableSharingResponseSchema = Type.Object(
    {
        connection: Type.Literal("disconnected"),
        contacts: emptyArray,
        folderShares: emptyArray,
        identity: Type.String({
            minLength: 43,
            maxLength: 43,
            pattern: "^[A-Za-z0-9_-]+$",
        }),
        incomingRequests: emptyArray,
        outgoingRequests: emptyArray,
        profileId: Type.Null(),
        version: Type.Literal("empty"),
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

export const emptyProviderUsageResponseSchema = Type.Object({ providers: emptyArray }, exact);
export const emptySecretsResponseSchema = Type.Object({ secrets: emptyArray }, exact);
export const emptyExternalToolCallsResponseSchema = Type.Object({ calls: emptyArray }, exact);
export const defaultPresenceResponseSchema = Type.Object(
    {
        presence: Type.Object(
            {
                presence: presenceSummarySchema,
                presences: Type.Array(presenceSummarySchema, { minItems: 1 }),
                since: Type.Integer({ minimum: 0 }),
            },
            exact,
        ),
    },
    exact,
);

const SHARING_IDENTITY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** Protocol-valid read snapshots for Rig features Happy Agent does not host yet. */
export function createCompatibilitySnapshots(
    cursor: string,
    options: {
        readonly p2pName?: string;
        readonly presence?: RigPresenceConfiguration;
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
        presence: validateSnapshot(defaultPresenceResponseSchema, {
            presence: defaultRigPresence(Date.now(), options.presence),
        }),
        profiles: validateSnapshot(emptyProfilesResponseSchema, { profiles: [] }),
        providerUsage: validateSnapshot(emptyProviderUsageResponseSchema, { providers: [] }),
        secrets: validateSnapshot(emptySecretsResponseSchema, { secrets: [] }),
        sharing: validateSnapshot(unavailableSharingResponseSchema, {
            connection: "disconnected",
            contacts: [],
            folderShares: [],
            identity: SHARING_IDENTITY,
            incomingRequests: [],
            outgoingRequests: [],
            profileId: null,
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
        readRoute("/v0/profiles", "profiles"),
        readRoute("/v0/sharing", "sharing"),
        readRoute("/v0/onboarding", "onboarding"),
        readRoute("/v0/happy-cloud/status", "happyCloud"),
        readRoute("/v0/provider-usage", "providerUsage"),
        readRoute("/v0/presence", "presence"),
        readRoute("/v0/secrets", "secrets"),
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

export async function readLiveRigPresence(
    ctx: Context,
    agent: LoadedHappyAgent,
): Promise<Static<typeof defaultPresenceResponseSchema>> {
    const [current, definitions] = await Promise.all([
        agent.modules.presence.read(ctx),
        agent.modules.presence.listPresences(ctx),
    ]);
    const presences = definitions.map((definition) => ({
        answerWaitMs: definition.answerWaitMs,
        emoji: definition.emoji,
        id: definition.id,
        prompt: definition.prompt || "The user is at the keyboard.",
        title: definition.title,
    }));
    const fallback = presences.find((presence) => presence.id === "online") ??
        presences[0] ?? {
            answerWaitMs: null,
            emoji: "🟢",
            id: "online",
            prompt: "The user is at the keyboard.",
            title: "Online",
        };
    const currentPresence =
        current === undefined
            ? fallback
            : {
                  answerWaitMs: current.answerWaitMs,
                  emoji: current.emoji,
                  id: current.presenceId,
                  prompt: current.prompt || "The user is at the keyboard.",
                  title: current.title,
              };
    return validateSnapshot(defaultPresenceResponseSchema, {
        presence: {
            presence: currentPresence,
            presences: presences.length === 0 ? [fallback] : presences,
            since: Math.max(
                0,
                Math.trunc(current?.effectiveFrom ?? current?.changesAt ?? Date.now()),
            ),
        },
    });
}

function readRoute(
    path: string,
    snapshot: keyof CompatibilitySnapshots,
): AgentHttpRouteGroup["routes"][number] {
    return {
        method: "GET",
        path,
        handle: async ({ ctx, dependencies, response }) => {
            if (snapshot === "presence") {
                sendJson(response, 200, await readLiveRigPresence(ctx, dependencies.agent));
                return;
            }
            const snapshots = createCompatibilitySnapshots(
                dependencies.agent.modules.events.cursor(),
                {
                    p2pName:
                        dependencies.configuration?.p2pName ??
                        dependencies.agent.configuration.values.p2p.name,
                    presence: dependencies.agent.configuration.values.presence,
                },
            );
            sendJson(response, 200, snapshots[snapshot]);
        },
    };
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
