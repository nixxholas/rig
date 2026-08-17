import { Type } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { hostComputeSchema, type HostCompute } from "../compute/ComputeModule.js";
import type { ComputeResolver } from "../compute/ComputeResolver.js";
import { projectContextSchema } from "./ProjectEvent.js";

/**
 * How the catalog reaches the machine its project folders live on.
 *
 * The catalog looks at folders itself — it probes Git, reads a remote, finds a picture, clones a
 * repository — and it does all of that through the same compute the agent works on, so a project
 * inside a container is inspected inside that container rather than on the machine running Rig.
 */
export const projectComputeResolverSchema = Type.Unsafe<ComputeResolver>(
    Type.Object(
        {
            resolve: Type.Function(
                [projectContextSchema, Type.String({ minLength: 1 })],
                Type.Promise(Type.Union([hostComputeSchema, Type.Undefined()])),
            ),
        },
        { additionalProperties: false },
    ),
);

export type ProjectComputeResolver = ComputeResolver;

/**
 * The compute this agent's project work runs on.
 *
 * A catalog built without one is still a perfectly good catalog — it records what it is told —
 * but it cannot go and look for itself, and it says so plainly rather than reporting a folder as
 * missing because nothing ever checked.
 */
export async function requireProjectCompute(
    ctx: Context,
    resolver: ComputeResolver | undefined,
    agentId: string,
): Promise<HostCompute> {
    if (resolver === undefined) {
        throw new Error(
            "This project catalog was built without a compute, so it cannot inspect project folders.",
        );
    }
    const compute = await resolver.resolve(ctx, agentId);
    if (compute === undefined) {
        throw new Error(
            `Agent "${agentId}" has no compute, so its project folders cannot be inspected.`,
        );
    }
    return compute;
}
