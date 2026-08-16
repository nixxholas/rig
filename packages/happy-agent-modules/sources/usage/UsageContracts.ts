import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { usageAgentIdSchema, usageAgentTreeSchema } from "./Usage.js";

/**
 * Context is a class-backed value with non-enumerable extension state.  The
 * module never inspects that state, but still gives TypeBox a closed,
 * provider-neutral structural contract instead of using an unconstrained
 * schema.
 */
export const usageContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: false }),
);

/** A callback may complete synchronously or return a Promise that resolves to void. */
export const usageVoidOrPromiseVoidSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);

/** A policy callback may complete synchronously or return a Promise of a boolean decision. */
export const usageBooleanOrPromiseBooleanSchema = Type.Union([
    Type.Boolean(),
    Type.Promise(Type.Boolean()),
]);

/**
 * Reads the complete, bounded subtree rooted at an agent.  The host owns the
 * roster and relationship query; Usage validates the returned snapshot before
 * exposing it to a model.
 */
export const usageAgentTreeReaderSchema = Type.Function(
    [usageContextSchema, usageAgentIdSchema],
    Type.Union([usageAgentTreeSchema, Type.Promise(usageAgentTreeSchema)]),
);

/**
 * Authorizes a model-facing subtree read.  The absence of this policy is
 * intentionally a denial, even when a tree reader is supplied.
 */
export const usageAgentTreeAuthorizationSchema = Type.Function(
    [usageContextSchema, usageAgentIdSchema],
    usageBooleanOrPromiseBooleanSchema,
);

export type UsageAgentTreeReader = Static<typeof usageAgentTreeReaderSchema>;
export type UsageAgentTreeAuthorization = Static<typeof usageAgentTreeAuthorizationSchema>;
