import type { PermissionMode } from "../../permissions/index.js";
import { type Static, Type } from "@sinclair/typebox";
import type { HappyNetworkRequestCompletion, HappyNetworkTunnel } from "happy-plugins";
import { happyNetworkRequestSchema } from "happy-plugins";

export const managedNetworkHttpRequestSchema = Type.Omit(happyNetworkRequestSchema, ["mode"]);
export type ManagedNetworkHttpRequest = Static<typeof managedNetworkHttpRequestSchema>;

export interface ManagedNetworkInterceptor {
    interceptHttp(request: ManagedNetworkHttpRequest): Promise<HappyNetworkRequestCompletion>;
    observeTunnel(tunnel: HappyNetworkTunnel): void;
    recordFailure(hostname: string, error: unknown): void;
    shouldIntercept(hostname: string): boolean;
}

export interface ManagedNetworkRule {
    domain: string;
    ports?: readonly number[];
}

export interface ManagedNetworkPolicy {
    allowLocalBinding?: boolean;
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

export function shouldApplyManagedNetworkPolicy(permissionMode: PermissionMode): boolean {
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
                `Managed network loopback port ${String(port)} is reserved for Rig's managed network proxy.`,
            );
        }
    }
}
