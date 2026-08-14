import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const supervisorPermissionModeSchema = Type.Union([
    Type.Literal("read_only"),
    Type.Literal("workspace_write"),
    Type.Literal("auto"),
    Type.Literal("full_access"),
]);

export type SupervisorPermissionMode = Static<typeof supervisorPermissionModeSchema>;

export const supervisorProxyFrontEndSchema = Type.Union([
    Type.Literal("http"),
    Type.Literal("socks5"),
]);

export type SupervisorProxyFrontEnd = Static<typeof supervisorProxyFrontEndSchema>;

/**
 * Host-side TLS termination, which the supervisor requests but never performs.
 *
 * The supervisor holds no TLS stack and no private key. Naming a certificate authority here only
 * points the workload's trust at the file the host wrote, so a caller that never asked for
 * interception never has a certificate authority injected into its environment.
 */
export const supervisorTlsTerminationSchema = Type.Object(
    {
        certificateAuthorityFile: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);

export type SupervisorTlsTermination = Static<typeof supervisorTlsTerminationSchema>;

/**
 * The already-connected link to the unified host proxy, and the front-ends to expose over it.
 *
 * `upstreamFd` is a descriptor Rig connected before the sandbox existed and passed to the
 * supervisor, so nothing inside the sandbox reaches the proxy — or anything else — by address. The
 * token authenticates exactly one command's policy on the other end.
 */
export const supervisorOutgoingProxySchema = Type.Object(
    {
        upstreamFd: Type.Integer({ minimum: 3 }),
        token: Type.String({ maxLength: 512, minLength: 1 }),
        frontEnds: Type.Array(supervisorProxyFrontEndSchema, { minItems: 1 }),
        tlsTermination: Type.Optional(supervisorTlsTerminationSchema),
    },
    { additionalProperties: false },
);

export type SupervisorOutgoingProxy = Static<typeof supervisorOutgoingProxySchema>;

export const supervisorNetworkPolicySchema = Type.Object(
    {
        egress: Type.Boolean(),
        allowedHosts: Type.Optional(Type.Array(Type.String())),
        localBinding: Type.Boolean(),
        outgoingProxy: Type.Optional(supervisorOutgoingProxySchema),
    },
    { additionalProperties: false },
);

export type SupervisorNetworkPolicy = Static<typeof supervisorNetworkPolicySchema>;

/**
 * The native supervisor's input. Its names intentionally match ComputePermissions one-for-one.
 *
 * The working directory is the workspace root for `workspace_write` and `auto`; keeping it out of
 * the document prevents two sources of truth for the process cwd. A non-empty `allowedHosts`
 * requires `network.outgoingProxy`, because the host list is enforced by the host proxy that owns
 * the command's token — the supervisor never resolves a name or opens a socket to a destination.
 */
export const supervisorPolicySchema = Type.Object(
    {
        mode: supervisorPermissionModeSchema,
        allowedReadPaths: Type.Optional(Type.Array(Type.String())),
        deniedReadPaths: Type.Optional(Type.Array(Type.String())),
        allowedWritePaths: Type.Optional(Type.Array(Type.String())),
        deniedWritePaths: Type.Optional(Type.Array(Type.String())),
        network: supervisorNetworkPolicySchema,
    },
    { additionalProperties: false },
);

export type SupervisorPolicy = Static<typeof supervisorPolicySchema>;

export function parseSupervisorPolicy(value: unknown): SupervisorPolicy {
    if (!Value.Check(supervisorPolicySchema, value)) {
        const details = [...Value.Errors(supervisorPolicySchema, value)]
            .map((error) => `${error.path || "/"} ${error.message}`)
            .join("; ");
        throw new Error(`Invalid supervisor policy: ${details}`);
    }
    return Value.Parse(supervisorPolicySchema, value);
}
