import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    secretDescriptionSchema,
    secretEnvironmentVariableNameSchema,
    secretEnvironmentVariableValueSchema,
    secretIdSchema,
    type SecretReference,
} from "@slopus/happy-agent-modules";
import type { Context } from "@steve.kite/stdlib";

import type { StartedHappyAgent } from "../../start/startHappyAgent.js";
import { readValidatedBody } from "./body.js";
import { AgentHttpError, sendJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";

const exact = { additionalProperties: false } as const;
const secretEnvironmentSchema = Type.Record(
    secretEnvironmentVariableNameSchema,
    secretEnvironmentVariableValueSchema,
    {
        additionalProperties: false,
        maxProperties: 256,
        minProperties: 1,
    },
);
const secretEnvironmentPatchSchema = Type.Record(
    secretEnvironmentVariableNameSchema,
    Type.Union([secretEnvironmentVariableValueSchema, Type.Null()]),
    {
        additionalProperties: false,
        maxProperties: 256,
        minProperties: 1,
    },
);
const registerSecretRequestSchema = Type.Object(
    {
        description: secretDescriptionSchema,
        environment: secretEnvironmentSchema,
        id: secretIdSchema,
    },
    exact,
);
const updateSecretRequestSchema = Type.Object(
    {
        description: Type.Optional(secretDescriptionSchema),
        environment: Type.Optional(secretEnvironmentPatchSchema),
    },
    { additionalProperties: false, minProperties: 1 },
);
const rigSecretSummarySchema = Type.Object(
    {
        availableToModel: Type.Optional(Type.Boolean()),
        description: secretDescriptionSchema,
        environmentVariables: Type.Array(secretEnvironmentVariableNameSchema, {
            maxItems: 256,
            uniqueItems: true,
        }),
        id: secretIdSchema,
        kind: Type.Optional(Type.Literal("github")),
    },
    exact,
);

type RegisterSecretRequest = Static<typeof registerSecretRequestSchema>;
type UpdateSecretRequest = Static<typeof updateSecretRequestSchema>;
type RigSecretSummary = Static<typeof rigSecretSummarySchema>;

const MAX_RIG_SECRET_SUMMARIES = 256;

export function createSecretRoutes(): AgentHttpRouteGroup {
    return createRouteGroup("secrets", [
        {
            method: "GET",
            path: "/v0/secrets",
            handle: async ({ ctx, dependencies, response }) => {
                sendJson(response, 200, {
                    secrets: await listRigSecrets(ctx, dependencies.agent),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/secrets",
            handle: async ({ ctx, dependencies, request, response }) => {
                const body = await readValidatedBody(request, registerSecretRequestSchema);
                const secret = await registerSecret(ctx, dependencies.agent, body);
                sendJson(response, 200, { secret: projectRigSecret(secret) });
            },
        },
        {
            method: "PATCH",
            path: "/v0/secrets/:secretId",
            handle: async ({ ctx, dependencies, params, request, response }) => {
                const secretId = validatedSecretId(params.secretId);
                const body = await readValidatedBody(request, updateSecretRequestSchema);
                const secret = await updateSecret(ctx, dependencies.agent, secretId, body);
                if (secret === undefined) throw new AgentHttpError(404, "Secret not found.");
                sendJson(response, 200, { secret: projectRigSecret(secret) });
            },
        },
        {
            method: "DELETE",
            path: "/v0/secrets/:secretId",
            handle: async ({ ctx, dependencies, params, response }) => {
                const secretId = validatedSecretId(params.secretId);
                const removed = await dependencies.agent.modules.secrets.remove(
                    ctx,
                    secretOwner(dependencies.agent),
                    secretId,
                );
                sendJson(response, 200, { removed });
            },
        },
    ]);
}

async function listRigSecrets(
    ctx: Context,
    agent: StartedHappyAgent,
): Promise<readonly RigSecretSummary[]> {
    const secrets: RigSecretSummary[] = [];
    let cursor: number | undefined;
    for (;;) {
        const page = await agent.modules.secrets.list(
            ctx,
            secretOwner(agent),
            cursor === undefined ? {} : { cursor },
        );
        secrets.push(...page.secrets.map(projectRigSecret));
        if (secrets.length > MAX_RIG_SECRET_SUMMARIES) {
            throw new AgentHttpError(409, "The secret catalog is too large for Rig to display.");
        }
        if (page.nextCursor === undefined) return secrets;
        cursor = page.nextCursor;
    }
}

async function registerSecret(
    ctx: Context,
    agent: StartedHappyAgent,
    body: RegisterSecretRequest,
): Promise<SecretReference> {
    try {
        return await agent.modules.secrets.register(ctx, secretOwner(agent), body);
    } catch (error) {
        throw secretMutationError(error, "The secret could not be saved.");
    }
}

async function updateSecret(
    ctx: Context,
    agent: StartedHappyAgent,
    secretId: string,
    body: UpdateSecretRequest,
): Promise<SecretReference | undefined> {
    try {
        return await agent.modules.secrets.update(ctx, secretOwner(agent), secretId, body);
    } catch (error) {
        throw secretMutationError(error, "The secret could not be changed.");
    }
}

/**
 * Rig's catalog is daemon-global, while SecretsModule deliberately scopes storage by an opaque
 * acting-agent identity. The durable root agent is the daemon's stable owner for this adapter.
 */
function secretOwner(agent: StartedHappyAgent): string {
    return agent.agent.id;
}

function projectRigSecret(secret: SecretReference): RigSecretSummary {
    const summary = {
        ...(secret.availableToModel === undefined
            ? {}
            : { availableToModel: secret.availableToModel }),
        description: secret.description,
        environmentVariables: [...secret.environmentVariables],
        id: secret.id,
        ...(secret.kind === "github" ? { kind: secret.kind } : {}),
    };
    if (!Value.Check(rigSecretSummarySchema, summary)) {
        throw new Error("Happy Agent created invalid Rig secret metadata.");
    }
    return summary;
}

function validatedSecretId(value: string | undefined): string {
    if (!Value.Check(secretIdSchema, value)) {
        throw new AgentHttpError(400, "The secret ID is invalid.");
    }
    return value;
}

function secretMutationError(error: unknown, fallback: string): AgentHttpError {
    return new AgentHttpError(400, error instanceof Error ? error.message : fallback);
}
