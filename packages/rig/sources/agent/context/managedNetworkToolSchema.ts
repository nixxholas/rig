import { Type, type Static } from "@sinclair/typebox";

import type { ManagedNetworkPolicy } from "./ManagedNetworkPolicy.js";

const managedNetworkRuleSchema = Type.Object(
    {
        domain: Type.String({
            description: 'Exact domain or leading wildcard such as "*.coderabbit.ai".',
        }),
        ports: Type.Optional(
            Type.Array(Type.Integer({ maximum: 65_535, minimum: 1 }), {
                description: "Allowed destination ports. All ports when omitted.",
            }),
        ),
    },
    { additionalProperties: false },
);

export const managedNetworkToolSchema = Type.Object(
    {
        allowed_domains: Type.Optional(
            Type.Array(managedNetworkRuleSchema, {
                description: "External domains this command may contact through the managed proxy.",
                minItems: 1,
            }),
        ),
        allowed_loopback_ports: Type.Optional(
            Type.Array(Type.Integer({ maximum: 65_535, minimum: 1 }), {
                description:
                    "Host loopback ports the sandboxed command may contact directly, such as a local development proxy.",
                minItems: 1,
            }),
        ),
        denied_domains: Type.Optional(
            Type.Array(managedNetworkRuleSchema, {
                description: "Domains denied even when an allow wildcard matches.",
            }),
        ),
    },
    { additionalProperties: false },
);

export type ManagedNetworkToolArguments = Static<typeof managedNetworkToolSchema>;

export function toManagedNetworkPolicy(
    value: ManagedNetworkToolArguments | undefined,
): ManagedNetworkPolicy | undefined {
    if (value === undefined) return undefined;
    return {
        ...(value.allowed_domains === undefined ? {} : { allowedDomains: value.allowed_domains }),
        ...(value.allowed_loopback_ports === undefined
            ? {}
            : { allowedLoopbackPorts: value.allowed_loopback_ports }),
        ...(value.denied_domains === undefined ? {} : { deniedDomains: value.denied_domains }),
    };
}

export function describeManagedNetworkAccess(value: ManagedNetworkToolArguments): string {
    const destinations = (value.allowed_domains ?? [])
        .map(({ domain, ports }) =>
            ports === undefined ? domain : `${domain}:${ports.map(String).join(",")}`,
        )
        .concat((value.allowed_loopback_ports ?? []).map((port) => `localhost:${String(port)}`))
        .join(", ");
    return `Allow this command to connect through Rig's managed network proxy to ${destinations}?`;
}
