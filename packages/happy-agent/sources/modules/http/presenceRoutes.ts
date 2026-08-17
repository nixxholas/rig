import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import type { StartedHappyAgent } from "../../start/startHappyAgent.js";
import { readValidatedBody } from "./body.js";
import { AgentHttpError, sendJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";

const exact = { additionalProperties: false } as const;
const presenceIdSchema = Type.String({ minLength: 1, maxLength: 128 });
const presenceTimestampSchema = Type.Integer({
    minimum: 0,
    maximum: 8_640_000_000_000_000,
});
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
const setPresenceRequestSchema = Type.Object(
    {
        fallbackPresenceId: Type.Optional(presenceIdSchema),
        presenceId: presenceIdSchema,
        until: Type.Optional(presenceTimestampSchema),
    },
    exact,
);
const presenceResponseSchema = Type.Object(
    {
        presence: Type.Object(
            {
                changesAt: Type.Optional(presenceTimestampSchema),
                fallbackPresenceId: Type.Optional(presenceIdSchema),
                presence: presenceSummarySchema,
                presences: Type.Array(presenceSummarySchema, { minItems: 1 }),
                since: presenceTimestampSchema,
            },
            exact,
        ),
    },
    exact,
);

type SetPresenceRequest = Static<typeof setPresenceRequestSchema>;
type PresenceResponse = Static<typeof presenceResponseSchema>;

export function createPresenceRoutes(): AgentHttpRouteGroup {
    return createRouteGroup("presence", [
        {
            method: "GET",
            path: "/v0/presence",
            handle: async ({ ctx, dependencies, response }) => {
                sendJson(response, 200, await readLiveRigPresence(ctx, dependencies.agent));
            },
        },
        {
            method: "PUT",
            path: "/v0/presence",
            handle: async ({ ctx, dependencies, request, response }) => {
                const body = await readValidatedBody(request, setPresenceRequestSchema);
                await setPresence(ctx, dependencies.agent, body);
                sendJson(response, 200, await readLiveRigPresence(ctx, dependencies.agent));
            },
        },
    ]);
}

export async function readLiveRigPresence(
    ctx: Context,
    agent: StartedHappyAgent,
): Promise<PresenceResponse> {
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
    return {
        presence: {
            ...(current?.expiresAt === undefined ? {} : { changesAt: current.expiresAt }),
            ...(current?.fallbackPresenceId === undefined
                ? {}
                : { fallbackPresenceId: current.fallbackPresenceId }),
            presence: currentPresence,
            presences: presences.length === 0 ? [fallback] : presences,
            since: Math.max(
                0,
                Math.trunc(current?.effectiveFrom ?? current?.changesAt ?? Date.now()),
            ),
        },
    };
}

async function setPresence(
    ctx: Context,
    agent: StartedHappyAgent,
    body: SetPresenceRequest,
): Promise<void> {
    try {
        await agent.modules.presence.setPresence(ctx, {
            presenceId: body.presenceId,
            ...(body.until === undefined ? {} : { expiresAt: body.until }),
            ...(body.fallbackPresenceId === undefined
                ? {}
                : { fallbackPresenceId: body.fallbackPresenceId }),
        });
    } catch (error) {
        throw new AgentHttpError(
            400,
            error instanceof Error ? error.message : "The presence could not be changed.",
        );
    }
}
