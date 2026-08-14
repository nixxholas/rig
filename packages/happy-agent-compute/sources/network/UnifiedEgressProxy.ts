import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { EGRESS_LINK_MAX_HOST_BYTES } from "./impl/egressLinkFrames.js";

const exact = { additionalProperties: false } as const;

const unifiedEgressRuleSchema = Type.Object(
    {
        domain: Type.String({ maxLength: 253, minLength: 1 }),
        ports: Type.Optional(
            Type.Array(Type.Integer({ maximum: 65_535, minimum: 1 }), { maxItems: 64 }),
        ),
    },
    exact,
);

/**
 * One command's network policy, as the unified proxy holds it.
 *
 * A token resolves to exactly one of these. It is never shared between commands and never becomes
 * an ambient capability: revoking the command's registration is what makes its link stop working.
 */
export const unifiedEgressCommandPolicySchema = Type.Object(
    {
        /** Allows destinations on loopback, link-local, and private networks. */
        allowPrivateAddresses: Type.Optional(Type.Boolean()),
        allowedDomains: Type.Optional(Type.Array(unifiedEgressRuleSchema, { maxItems: 512 })),
        deniedDomains: Type.Optional(Type.Array(unifiedEgressRuleSchema, { maxItems: 512 })),
        /**
         * Requests host-side TLS termination. It is off unless a command asks for it, and asking
         * for it without a configured terminator is refused rather than quietly downgraded to a
         * tunnel the caller would believe was being inspected.
         */
        tlsTermination: Type.Optional(Type.Boolean()),
    },
    exact,
);

export type UnifiedEgressCommandPolicy = Static<typeof unifiedEgressCommandPolicySchema>;

export const unifiedEgressDestinationSchema = Type.Object(
    {
        host: Type.String({ maxLength: EGRESS_LINK_MAX_HOST_BYTES, minLength: 1 }),
        port: Type.Integer({ maximum: 65_535, minimum: 1 }),
    },
    exact,
);

export type UnifiedEgressDestination = Static<typeof unifiedEgressDestinationSchema>;

export type UnifiedEgressDenialReason =
    | "connection_failed"
    | "denied"
    | "dns_resolution_failed"
    | "non_public_address"
    | "not_allowed";

export interface UnifiedEgressDenial {
    host: string;
    port: number;
    reason: UnifiedEgressDenialReason;
}

/** A live registration. Its token authenticates one command and nothing else. */
export interface UnifiedEgressCommand {
    denial(): UnifiedEgressDenial | undefined;
    onDenial(listener: (denial: UnifiedEgressDenial) => void): () => void;
    /** Ends the registration and drops every link that authenticated with this token. */
    revoke(): void;
    readonly token: string;
}

export interface UnifiedEgressProxy {
    /**
     * Serves a link whose descriptor is already connected. Rig connects it before the sandbox
     * exists and hands the other end to the supervisor, so nothing inside the sandbox reaches
     * anything by address.
     */
    attach(link: NodeJS.ReadWriteStream & { destroy(): void }): void;
    close(): Promise<void>;
    registerCommand(policy: UnifiedEgressCommandPolicy): UnifiedEgressCommand;
}

export function parseUnifiedEgressCommandPolicy(value: unknown): UnifiedEgressCommandPolicy {
    if (!Value.Check(unifiedEgressCommandPolicySchema, value)) {
        const details = [...Value.Errors(unifiedEgressCommandPolicySchema, value)]
            .map((error) => `${error.path || "/"} ${error.message}`)
            .join("; ");
        throw new Error(`Invalid unified egress command policy: ${details}`);
    }
    return Value.Parse(unifiedEgressCommandPolicySchema, value);
}

export function parseUnifiedEgressDestination(
    value: unknown,
): UnifiedEgressDestination | undefined {
    return Value.Check(unifiedEgressDestinationSchema, value)
        ? Value.Parse(unifiedEgressDestinationSchema, value)
        : undefined;
}
