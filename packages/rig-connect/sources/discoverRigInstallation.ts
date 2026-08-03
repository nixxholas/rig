import { Value } from "@sinclair/typebox/value";

import { endpointUrl } from "./endpointUrl.js";
import {
    rigDaemonInstallationDiscoverySchema,
    type RigDaemonInstallationDiscovery,
} from "./RigInstallationInspection.js";
import { serverCompatibility, type ServerCompatibility } from "./ServerCompatibility.js";

export const DEFAULT_INSTALLATION_DISCOVERY_TIMEOUT_MS = 5_000;
export const MAXIMUM_INSTALLATION_RESPONSE_BYTES = 16 * 1_024;

export interface DiscoverRigInstallationOptions {
    endpoint: string;
    /** Test seam. Defaults to the global `fetch`. */
    fetch?: typeof globalThis.fetch;
    /** Cancels this one request without affecting any other Rig connection. */
    signal?: AbortSignal;
    /** Maximum time for the complete response. Defaults to five seconds. */
    timeoutMs?: number;
    token: string;
}

/**
 * Reads the installation metadata from one Rig endpoint.
 *
 * Discovery is deliberately separate from `connectRig`: it opens no live
 * stream and creates no stores, so callers can inspect an endpoint before
 * deciding whether to connect to it.
 */
export async function discoverRigInstallation(
    options: DiscoverRigInstallationOptions,
): Promise<RigDaemonInstallationDiscovery> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, options.timeoutMs ?? DEFAULT_INSTALLATION_DISCOVERY_TIMEOUT_MS);
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted === true) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    let bytes: Uint8Array;
    try {
        const response = await (options.fetch ?? globalThis.fetch)(
            endpointUrl(options.endpoint, "installation"),
            {
                headers: {
                    accept: "application/json",
                    authorization: `Bearer ${options.token}`,
                },
                method: "GET",
                signal: controller.signal,
            },
        );
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            if (response.status === 404) throw new RigInstallationDiscoveryUnsupportedError();
            throw new RigInstallationDiscoveryHttpError(response.status);
        }
        bytes = await readBoundedInstallationResponse(response);
    } catch (error) {
        if (timedOut) throw new Error("Rig installation discovery timed out.");
        throw error;
    } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
    }
    try {
        return Value.Decode(
            rigDaemonInstallationDiscoverySchema,
            JSON.parse(new TextDecoder().decode(bytes)) as unknown,
        );
    } catch {
        throw new Error("Rig returned an invalid installation discovery response.");
    }
}

/** Classifies whether the discovered daemon can speak this client protocol. */
export function rigInstallationCompatibility(
    inspection: RigDaemonInstallationDiscovery,
): ServerCompatibility {
    return serverCompatibility(inspection.daemonProtocolVersion);
}

/**
 * The server has no authenticated `/installation` endpoint, so it predates
 * discovery and must be upgraded before this client can identify it.
 */
export class RigInstallationDiscoveryUnsupportedError extends Error {
    readonly compatibility: Extract<ServerCompatibility, { status: "server_outdated" }>;
    readonly status = 404;

    constructor() {
        super("This Rig server does not support installation discovery. Update the Rig server.");
        this.name = "RigInstallationDiscoveryUnsupportedError";
        this.compatibility = serverCompatibility(0) as Extract<
            ServerCompatibility,
            { status: "server_outdated" }
        >;
    }
}

/** An HTTP refusal from a server that supports the discovery route. */
export class RigInstallationDiscoveryHttpError extends Error {
    readonly status: number;

    constructor(status: number) {
        super(`Rig rejected the installation discovery request (${String(status)}).`);
        this.name = "RigInstallationDiscoveryHttpError";
        this.status = status;
    }
}

async function readBoundedInstallationResponse(response: Response): Promise<Uint8Array> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_INSTALLATION_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Rig returned an installation response larger than 16 KB.");
    }
    if (response.body === null) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAXIMUM_INSTALLATION_RESPONSE_BYTES) {
                await reader.cancel().catch(() => undefined);
                throw new Error("Rig returned an installation response larger than 16 KB.");
            }
            chunks.push(value);
        }
    } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock();
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
}
