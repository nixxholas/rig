import { Value } from "@sinclair/typebox/value";

import type { P2pNetwork } from "../p2p/index.js";
import {
    rigProfileIdSchema,
    rigProfileResponseSchema,
    type RigProfile,
    type RigProfileResponse,
} from "../protocol/index.js";
import type { RigProfileStore } from "./RigProfileStore.js";
import { sameRigProfile } from "./sameRigProfile.js";

const PROFILE_RESPONSE_MAXIMUM_BYTES = 256 * 1024;
const MAXIMUM_CONCURRENT_PROFILE_RETRIES = 3;

export async function replicateProfileForP2pRequest(options: {
    body: Uint8Array;
    network: P2pNetwork;
    onSynchronized?: (peerId: string, profileId: string, version: number) => void;
    path: string;
    peerId: string;
    profiles: RigProfileStore;
    signal: AbortSignal;
}): Promise<void> {
    const profileId = messageProfileId(options.path, options.body);
    if (profileId === undefined) return;
    const profile = options.profiles.get(profileId);
    if (profile === undefined || !options.profiles.isLocal(profileId)) {
        throw new P2pProfileReplicationError(403, "That human profile is not owned by this Rig.");
    }
    let candidate = profile;
    for (let attempt = 0; attempt < MAXIMUM_CONCURRENT_PROFILE_RETRIES; attempt += 1) {
        try {
            await replicateProfileToP2pPeer({
                network: options.network,
                peerId: options.peerId,
                profile: candidate,
                signal: options.signal,
            });
            options.onSynchronized?.(options.peerId, candidate.id, candidate.version);
            return;
        } catch (error) {
            if (!(error instanceof NewerP2pProfileError)) throw error;
            const latest = options.profiles.get(profileId);
            if (
                latest === undefined ||
                !options.profiles.isLocal(profileId) ||
                latest.version < error.profile.version
            ) {
                throw new P2pProfileReplicationError(
                    409,
                    "The remote Rig has conflicting state for that human profile.",
                );
            }
            if (sameRigProfile(latest, error.profile)) {
                options.onSynchronized?.(options.peerId, latest.id, latest.version);
                return;
            }
            candidate = latest;
        }
    }
    throw new P2pProfileReplicationError(
        502,
        "The human profile kept changing while it was synchronized.",
    );
}

export async function replicateProfileToP2pPeer(options: {
    createIfMissing?: boolean;
    network: P2pNetwork;
    peerId: string;
    profile: RigProfile;
    signal: AbortSignal;
}): Promise<"missing" | "synchronized"> {
    const path = `/profiles/${encodeURIComponent(options.profile.id)}`;
    const current = await options.network.fetch(
        options.peerId,
        {
            body: new Uint8Array(),
            headers: { accept: "application/json" },
            method: "GET",
            path,
        },
        options.signal,
    );
    const currentBody = await collectBody(current.response.body);
    if (current.response.status === 200) {
        const decoded = decodeProfileResponse(currentBody);
        if (
            decoded.profile.id !== options.profile.id ||
            decoded.profile.parentInstanceId !== options.profile.parentInstanceId ||
            decoded.profile.createdAt !== options.profile.createdAt
        ) {
            throw new P2pProfileReplicationError(
                409,
                "The remote Rig has that profile under another parent.",
            );
        }
        if (sameRigProfile(decoded.profile, options.profile)) return "synchronized";
        if (decoded.profile.version > options.profile.version) {
            throw new NewerP2pProfileError(decoded.profile);
        }
        if (decoded.profile.version === options.profile.version) {
            throw new P2pProfileReplicationError(
                409,
                "The remote Rig has conflicting state for that human profile.",
            );
        }
    } else if (current.response.status === 404) {
        if (options.createIfMissing === false) return "missing";
    } else {
        throw new P2pProfileReplicationError(
            current.response.status === 403 ? 403 : 502,
            "The remote Rig could not check the human profile.",
        );
    }

    const encoded = Buffer.from(JSON.stringify({ profile: options.profile }), "utf8");
    const replicated = await options.network.fetch(
        options.peerId,
        {
            body: encoded,
            headers: {
                accept: "application/json",
                "content-type": "application/json",
            },
            method: "PUT",
            path,
        },
        options.signal,
    );
    const replicatedBody = await collectBody(replicated.response.body);
    if (replicated.response.status !== 200) {
        throw new P2pProfileReplicationError(
            replicated.response.status === 403 || replicated.response.status === 409
                ? replicated.response.status
                : 502,
            "The remote Rig did not accept the human profile.",
        );
    }
    const decoded = decodeProfileResponse(replicatedBody);
    if (!sameRigProfile(decoded.profile, options.profile)) {
        if (
            decoded.profile.id === options.profile.id &&
            decoded.profile.parentInstanceId === options.profile.parentInstanceId &&
            decoded.profile.createdAt === options.profile.createdAt &&
            decoded.profile.version > options.profile.version
        ) {
            throw new NewerP2pProfileError(decoded.profile);
        }
        throw new P2pProfileReplicationError(
            502,
            "The remote Rig returned a different human profile.",
        );
    }
    return "synchronized";
}

export class P2pProfileReplicationError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = "P2pProfileReplicationError";
        this.status = status;
    }
}

class NewerP2pProfileError extends Error {
    readonly profile: RigProfile;

    constructor(profile: RigProfile) {
        super("The remote Rig returned a newer human profile.");
        this.name = "NewerP2pProfileError";
        this.profile = profile;
    }
}

function messageProfileId(path: string, body: Uint8Array): string | undefined {
    const pathname = new URL(path, "http://rig.local").pathname;
    if (
        pathname !== "/messages" &&
        pathname !== "/projects/clone" &&
        pathname !== "/sessions" &&
        !/^\/projects\/[^/]+\/workspaces$/u.test(pathname) &&
        !/^\/sessions\/[^/]+\/(?:context|messages|steer)$/u.test(pathname)
    ) {
        return undefined;
    }
    let decoded: unknown;
    try {
        decoded = JSON.parse(Buffer.from(body).toString("utf8"));
    } catch {
        return undefined;
    }
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
        return undefined;
    }
    const identity = (decoded as { identity?: unknown }).identity;
    return Value.Check(rigProfileIdSchema, identity) ? identity : undefined;
}

async function collectBody(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
        const buffer = Buffer.from(chunk);
        total += buffer.byteLength;
        if (total > PROFILE_RESPONSE_MAXIMUM_BYTES) {
            throw new P2pProfileReplicationError(
                502,
                "The remote Rig returned an oversized profile response.",
            );
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

function decodeProfileResponse(body: Buffer): RigProfileResponse {
    let value: unknown;
    try {
        value = JSON.parse(body.toString("utf8"));
    } catch {
        throw new P2pProfileReplicationError(
            502,
            "The remote Rig returned an invalid profile response.",
        );
    }
    if (!Value.Check(rigProfileResponseSchema, value)) {
        throw new P2pProfileReplicationError(
            502,
            "The remote Rig returned an invalid profile response.",
        );
    }
    return value;
}
