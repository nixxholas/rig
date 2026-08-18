import { Type, type Static } from "@sinclair/typebox";
import type { MurmurSnapshot } from "@slopus/happy-agent-modules";
import type { Context } from "@steve.kite/stdlib";

import type { StartedHappyAgent } from "../../start/startHappyAgent.js";
import { readValidatedBody } from "./body.js";
import { AgentHttpError, sendJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";

const exact = { additionalProperties: false } as const;
const sharingIdentitySchema = Type.String({
    minLength: 43,
    maxLength: 43,
    pattern: "^[A-Za-z0-9_-]+$",
});
const requestContactSchema = Type.Object({ invitation: sharingIdentitySchema }, exact);

/**
 * The one shape the module does not produce: sharing used to carry shared folders, and clients
 * still read the field. Nothing in this installation shares a folder, so it is always empty.
 */
type SharingSnapshotResponse = MurmurSnapshot & { readonly folderShares: readonly never[] };

export function createSharingRoutes(): AgentHttpRouteGroup {
    return createRouteGroup("sharing", [
        {
            method: "GET",
            path: "/v0/sharing",
            handle: async ({ ctx, dependencies, response }) => {
                const murmur = requireSharing(dependencies.agent);
                sendJson(response, 200, await withFolderShares(sharingCall(murmur.snapshot(ctx))));
            },
        },
        {
            method: "DELETE",
            path: "/v0/sharing",
            handle: async ({ ctx, dependencies, response }) => {
                const murmur = requireSharing(dependencies.agent);
                sendJson(response, 200, await withFolderShares(sharingCall(murmur.reset(ctx))));
            },
        },
        {
            method: "POST",
            path: "/v0/sharing/invitations",
            handle: async ({ ctx, dependencies, response }) => {
                const murmur = requireSharing(dependencies.agent);
                sendJson(response, 201, await sharingCall(murmur.createInvitation(ctx)));
            },
        },
        {
            method: "POST",
            path: "/v0/sharing/contact-requests",
            handle: async ({ ctx, dependencies, request, response }) => {
                const murmur = requireSharing(dependencies.agent);
                const body = await readContactRequest(request);
                // Asking is not becoming a contact: the other side still has to answer, so the
                // answer here is "accepted for processing" rather than "created".
                sendJson(response, 202, {
                    request: await sharingCall(murmur.requestContact(ctx, body.invitation)),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/sharing/contact-requests/:requestId/accept",
            handle: async ({ ctx, dependencies, params, response }) => {
                const murmur = requireSharing(dependencies.agent);
                await sharingCall(murmur.acceptContact(ctx, routeValue(params.requestId)));
                sendJson(response, 200, await withFolderShares(sharingCall(murmur.snapshot(ctx))));
            },
        },
        {
            method: "DELETE",
            path: "/v0/sharing/contact-requests/:requestId",
            handle: async ({ ctx, dependencies, params, response }) => {
                const murmur = requireSharing(dependencies.agent);
                await sharingCall(murmur.rejectContact(ctx, routeValue(params.requestId)));
                sendJson(response, 200, await withFolderShares(sharingCall(murmur.snapshot(ctx))));
            },
        },
        {
            method: "DELETE",
            path: "/v0/sharing/contacts/:identity",
            handle: async ({ ctx, dependencies, params, response }) => {
                const murmur = requireSharing(dependencies.agent);
                await sharingCall(murmur.removeContact(ctx, routeIdentity(params.identity)));
                sendJson(response, 200, await withFolderShares(sharingCall(murmur.snapshot(ctx))));
            },
        },
    ]);
}

/**
 * Binds sharing to the person this installation has just named.
 *
 * Creating the profile is the moment an installation with sharing enabled acquires someone to
 * share as, and there is no separate step for a person to take. Sharing being off, or already
 * bound, makes this nothing at all.
 */
export async function bindSharingProfile(
    ctx: Context,
    agent: StartedHappyAgent,
    profileId: string,
): Promise<void> {
    const murmur = agent.modules.murmur;
    if (!murmur.enabled || murmur.running) return;
    await murmur.bindProfile(ctx, profileId);
}

function requireSharing(agent: StartedHappyAgent): StartedHappyAgent["modules"]["murmur"] {
    if (!agent.modules.murmur.enabled) {
        throw new AgentHttpError(503, "Sharing is unavailable.");
    }
    return agent.modules.murmur;
}

async function readContactRequest(
    request: Parameters<typeof readValidatedBody>[0],
): Promise<Static<typeof requestContactSchema>> {
    try {
        return await readValidatedBody(request, requestContactSchema);
    } catch (error: unknown) {
        if (error instanceof AgentHttpError && error.status === 400) {
            throw new AgentHttpError(400, "The contact invitation is invalid.");
        }
        throw error;
    }
}

/**
 * Turns a sharing failure into the answer the client expects.
 *
 * A request naming something that is not there is a 404; everything else a sharing operation
 * refuses is a conflict with the state the caller was looking at, and the message says which.
 */
async function sharingCall<Result>(operation: Promise<Result>): Promise<Result> {
    try {
        return await operation;
    } catch (error: unknown) {
        const message =
            error instanceof Error ? error.message : "The sharing request could not be completed.";
        throw new AgentHttpError(message === "Contact request not found." ? 404 : 409, message);
    }
}

async function withFolderShares(
    snapshot: Promise<MurmurSnapshot>,
): Promise<SharingSnapshotResponse> {
    return { ...(await snapshot), folderShares: [] };
}

function routeValue(value: string | undefined): string {
    if (value === undefined || value.length === 0) {
        throw new AgentHttpError(404, "Contact request not found.");
    }
    return value;
}

function routeIdentity(value: string | undefined): string {
    if (value === undefined || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
        throw new AgentHttpError(404, "Route not found.");
    }
    return value;
}
