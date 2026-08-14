import { type Static, Type } from "@sinclair/typebox";

import type { ComputePermissionMode } from "../ComputePermissions.js";

/**
 * Largest request or response body the managed proxy will buffer for interception.
 *
 * Interception hands a whole body to an optional observer, so it is bounded rather than streamed
 * without limit. A body past this size is forwarded untouched instead of being held in memory.
 */
export const MANAGED_NETWORK_MAX_BODY_BYTES = 256 * 1024;

const MANAGED_NETWORK_MAX_HEADER_VALUE_LENGTH = 8_192;
const MANAGED_NETWORK_MAX_HEADER_COUNT = 128;
const MANAGED_NETWORK_MAX_METHOD_LENGTH = 64;
const MANAGED_NETWORK_MAX_URL_LENGTH = 8_192;

const exact = { additionalProperties: false } as const;
const nonEmptyText = Type.String({ minLength: 1 });
const headerValueSchema = Type.Union([
    Type.String({ maxLength: MANAGED_NETWORK_MAX_HEADER_VALUE_LENGTH }),
    Type.Array(Type.String({ maxLength: MANAGED_NETWORK_MAX_HEADER_VALUE_LENGTH }), {
        maxItems: 32,
    }),
]);
const headersSchema = Type.Record(
    Type.String({ maxLength: 256, minLength: 1 }),
    headerValueSchema,
    {
        maxProperties: MANAGED_NETWORK_MAX_HEADER_COUNT,
    },
);
const bodyBase64Schema = Type.String({
    maxLength: Math.ceil(MANAGED_NETWORK_MAX_BODY_BYTES / 3) * 4,
    pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});

/**
 * The HTTP request handed to an interceptor. This mirrors the request the proxy is about to make,
 * with the body already buffered so an observer sees the whole thing.
 */
export const managedNetworkHttpRequestSchema = Type.Object(
    {
        body: Type.Uint8Array({ maxByteLength: MANAGED_NETWORK_MAX_BODY_BYTES }),
        headers: headersSchema,
        hostname: Type.String({ maxLength: 253, minLength: 1 }),
        method: Type.String({ maxLength: MANAGED_NETWORK_MAX_METHOD_LENGTH, minLength: 1 }),
        url: Type.String({ maxLength: MANAGED_NETWORK_MAX_URL_LENGTH, minLength: 1 }),
    },
    exact,
);
export type ManagedNetworkHttpRequest = Static<typeof managedNetworkHttpRequestSchema>;

/**
 * How an interceptor decides one HTTP request: leave it alone, fail it, rewrite it, or answer it
 * with a synthetic response. The proxy validates whatever an interceptor returns against this
 * schema before acting on it, so a broken interceptor cannot smuggle unbounded bodies or malformed
 * headers past the boundary.
 */
export const managedNetworkRequestCompletionSchema = Type.Union([
    Type.Object({ type: Type.Literal("pass_through") }, exact),
    Type.Object({ error: nonEmptyText, type: Type.Literal("error") }, exact),
    Type.Object(
        {
            bodyBase64: Type.Optional(bodyBase64Schema),
            headers: Type.Optional(headersSchema),
            method: Type.Optional(
                Type.String({ maxLength: MANAGED_NETWORK_MAX_METHOD_LENGTH, minLength: 1 }),
            ),
            type: Type.Literal("request"),
            url: Type.Optional(
                Type.String({ maxLength: MANAGED_NETWORK_MAX_URL_LENGTH, minLength: 1 }),
            ),
        },
        exact,
    ),
    Type.Object(
        {
            bodyBase64: Type.Optional(bodyBase64Schema),
            headers: Type.Optional(headersSchema),
            status: Type.Integer({ maximum: 599, minimum: 200 }),
            type: Type.Literal("response"),
        },
        exact,
    ),
]);
export type ManagedNetworkRequestCompletion = Static<typeof managedNetworkRequestCompletionSchema>;

/** A closed opaque tunnel, reported to an observer after the fact as byte counts. */
export interface ManagedNetworkTunnel {
    bytesFromClient: number;
    bytesFromServer: number;
    hostname: string;
    port: number;
    type: "tunnel";
}

/**
 * An optional hook the managed proxy consults for HTTP interception and tunnel observation.
 *
 * Interception policy belongs to the agent layer above the compute, so the compute only exposes a
 * generic hook. The proxy still enforces allow and deny lists, bounded DNS resolution, and private
 * address blocking regardless of whether an interceptor is present, and validates every
 * completion before acting on it.
 */
export interface ManagedNetworkInterceptor {
    interceptHttp(request: ManagedNetworkHttpRequest): Promise<ManagedNetworkRequestCompletion>;
    observeTunnel(tunnel: ManagedNetworkTunnel): void;
    recordFailure(hostname: string, error: unknown): void;
    shouldIntercept(hostname: string): boolean;
}

export interface ManagedNetworkRule {
    domain: string;
    ports?: readonly number[];
}

export interface ManagedNetworkPolicy {
    allowLocalBinding?: boolean;
    /** Allows destinations on loopback, link-local, and private networks. */
    allowPrivateAddresses?: boolean;
    allowedDomains?: readonly ManagedNetworkRule[];
    allowedLoopbackPorts?: readonly number[];
    deniedDomains?: readonly ManagedNetworkRule[];
}

export interface ManagedNetworkBlockedRequest {
    host: string;
    port: number;
    protocol: "http" | "https_connect" | "socks5";
    reason: "denied" | "dns_resolution_failed" | "non_public_address" | "not_allowed";
}

export interface ManagedNetworkProxyHandle {
    blockedRequest(): ManagedNetworkBlockedRequest | undefined;
    close(): Promise<void>;
    onBlockedRequest(listener: (request: ManagedNetworkBlockedRequest) => void): () => void;
    port: number;
    socksPort: number;
}

export function shouldApplyManagedNetworkPolicy(permissionMode: ComputePermissionMode): boolean {
    return permissionMode === "auto" || permissionMode === "workspace_write";
}

export function shouldBypassManagedProxyForLoopback(
    policy: ManagedNetworkPolicy | undefined,
    hasIsolatedNetworkNamespace: boolean,
): boolean {
    return (
        hasIsolatedNetworkNamespace ||
        policy?.allowLocalBinding === true ||
        (policy?.allowedLoopbackPorts?.length ?? 0) > 0
    );
}

export function validateManagedNetworkLoopbackPorts(ports: readonly number[]): void {
    for (const port of ports) {
        if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
            throw new Error(`Invalid managed network loopback port: ${String(port)}`);
        }
        if (port === 1080 || port === 3128) {
            throw new Error(
                `Managed network loopback port ${String(port)} is reserved for the managed network proxy.`,
            );
        }
    }
}

export function withTrustedLoopbackPorts(
    policy: ManagedNetworkPolicy | undefined,
    trustedPorts: readonly number[] | undefined,
): ManagedNetworkPolicy | undefined {
    if (trustedPorts === undefined || trustedPorts.length === 0) return policy;
    validateManagedNetworkLoopbackPorts(trustedPorts);
    return {
        ...policy,
        allowedLoopbackPorts: [
            ...new Set([...(policy?.allowedLoopbackPorts ?? []), ...trustedPorts]),
        ],
    };
}
