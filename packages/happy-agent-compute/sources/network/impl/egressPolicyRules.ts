import type { ManagedNetworkBlockedRequest, ManagedNetworkRule } from "../ManagedNetworkPolicy.js";

/**
 * The part of a network policy that decides whether one destination may be reached at all.
 *
 * Both the per-command proxy and the unified proxy answer that question, and they have to answer
 * it identically: a second implementation of domain matching is a second place for an allow list
 * to be wrong.
 */
export interface EgressDestinationRules {
    allowedDomains?: readonly ManagedNetworkRule[];
    deniedDomains?: readonly ManagedNetworkRule[];
}

export function normalizeEgressDomain(domain: string): string {
    return domain.trim().toLowerCase().replace(/\.$/u, "");
}

/** Returns why a destination is blocked, or `undefined` when the policy permits it. */
export function egressBlockReason(
    policy: EgressDestinationRules,
    host: string,
    port: number,
): "denied" | "not_allowed" | undefined {
    const normalizedHost = normalizeEgressDomain(host);
    if (policy.deniedDomains?.some((rule) => matchesRule(rule, normalizedHost, port)) === true) {
        return "denied";
    }
    return policy.allowedDomains?.some((rule) => matchesRule(rule, normalizedHost, port)) === true
        ? undefined
        : "not_allowed";
}

function matchesRule(rule: ManagedNetworkRule, host: string, port: number): boolean {
    const pattern = normalizeEgressDomain(rule.domain);
    const domainMatches =
        pattern === "*" ||
        (pattern.startsWith("*.") &&
            host.length > pattern.length - 1 &&
            host.endsWith(pattern.slice(1)))
            ? true
            : host === pattern;
    return domainMatches && (rule.ports === undefined || rule.ports.includes(port));
}

/** Rejects a rule set that cannot be evaluated, rather than letting it silently match nothing. */
export function validateEgressRules(policy: EgressDestinationRules): void {
    for (const rule of [...(policy.allowedDomains ?? []), ...(policy.deniedDomains ?? [])]) {
        const domain = normalizeEgressDomain(rule.domain);
        if (
            domain.length === 0 ||
            domain.includes("/") ||
            domain.includes(":") ||
            (domain.includes("*") &&
                domain !== "*" &&
                (!domain.startsWith("*.") || domain.slice(2).includes("*")))
        ) {
            throw new Error(`Invalid managed network domain pattern: ${rule.domain}`);
        }
        for (const port of rule.ports ?? []) {
            if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
                throw new Error(`Invalid managed network port: ${String(port)}`);
            }
        }
    }
}

export type EgressBlockedReason = ManagedNetworkBlockedRequest["reason"];
