import { Type } from "@sinclair/typebox";
import type { Profile } from "@slopus/happy-agent-modules";

import { readValidatedBody } from "./body.js";
import { AgentHttpError, sendJson } from "./errors.js";
import { bindSharingProfile } from "./sharingRoutes.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";

const exact = { additionalProperties: false } as const;
const profileNameSchema = Type.String({
    maxLength: 128,
    minLength: 1,
    pattern:
        "^[^\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b\\u200e\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f]+$",
});
const profileEmailSchema = Type.String({
    maxLength: 254,
    minLength: 3,
    pattern: "^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$",
});
const createProfileSchema = Type.Object(
    { email: profileEmailSchema, name: profileNameSchema },
    exact,
);
const updateProfileSchema = Type.Object(
    { email: Type.Optional(profileEmailSchema), name: Type.Optional(profileNameSchema) },
    { ...exact, minProperties: 1 },
);

export function createProfileRoutes(): AgentHttpRouteGroup {
    return createRouteGroup("profiles", [
        {
            method: "GET",
            path: "/v0/profiles",
            handle: async ({ ctx, dependencies, response }) => {
                // One installation is one person, so the list a client reads is either empty or
                // holds exactly that person.
                const profile = await dependencies.agent.modules.profile.get(ctx);
                sendJson(response, 200, { profiles: profile === undefined ? [] : [profile] });
            },
        },
        {
            method: "POST",
            path: "/v0/profiles",
            handle: async ({ ctx, dependencies, request, response }) => {
                const body = await readValidatedBody(request, createProfileSchema);
                const profile = await createProfile(
                    dependencies.agent.modules.profile.create(ctx, body),
                );
                // Naming the person is also what gives sharing someone to be, when it is on.
                await bindSharingProfile(ctx, dependencies.agent, profile.id);
                sendJson(response, 201, { profile });
            },
        },
        {
            method: "GET",
            path: "/v0/profiles/:profileId",
            handle: async ({ ctx, dependencies, params, response }) => {
                const profile = await dependencies.agent.modules.profile.getById(
                    ctx,
                    params.profileId ?? "",
                );
                if (profile === undefined) throw new AgentHttpError(404, "Rig profile not found.");
                sendJson(response, 200, { profile });
            },
        },
        {
            method: "PATCH",
            path: "/v0/profiles/:profileId",
            handle: async ({ ctx, dependencies, params, request, response }) => {
                const body = await readValidatedBody(request, updateProfileSchema);
                const profile = await createProfile(
                    dependencies.agent.modules.profile.update(ctx, params.profileId ?? "", body),
                );
                if (profile === undefined) throw new AgentHttpError(404, "Rig profile not found.");
                sendJson(response, 200, { profile });
            },
        },
    ]);
}

/**
 * A refused profile is the caller's mistake, not the agent's.
 *
 * Everything the module can refuse here — a second profile, an installation speaking for a
 * person it does not own — is something the request asked for, so its own message travels back.
 */
async function createProfile<Result extends Profile | undefined>(
    operation: Promise<Result>,
): Promise<Result> {
    try {
        return await operation;
    } catch (error: unknown) {
        throw new AgentHttpError(
            409,
            error instanceof Error ? error.message : "The Rig profile could not be saved.",
        );
    }
}
