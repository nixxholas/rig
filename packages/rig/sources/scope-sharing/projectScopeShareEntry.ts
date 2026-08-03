import { Type, type Static } from "@sinclair/typebox";

import { canonicalShareJson, shareContentHash } from "../sharing/canonicalShareJson.js";
import type { ShareOpaqueEntry } from "../sharing/ShareTransport.js";
import { sessionShareProjectionSchema } from "../session-sharing/projectSessionShareEntry.js";

const exact = { additionalProperties: false } as const;
const identifierSchema = Type.String({ maxLength: 256, minLength: 1 });
const labelSchema = Type.String({ maxLength: 1024 });
const timestampSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });

/**
 * What one replicated entry is about.
 *
 * A scope share replicates one gapless log whose entries carry this tag, so a
 * member can tell the project or workspace facts from the session list from the
 * transcript without a second channel.
 */
export const scopeShareSubjectKindSchema = Type.Union([
    Type.Literal("scope"),
    Type.Literal("session_index"),
    Type.Literal("session_event"),
]);
export type ScopeShareSubjectKind = Static<typeof scopeShareSubjectKindSchema>;

/**
 * The project or workspace itself.
 *
 * Deliberately absent, and never to be added: absolute paths (only the folder's
 * own name travels), file contents, diffs, working-tree or Git object data,
 * secrets, Docker and external-tool configuration, instructions and system
 * prompts, and permission state of any kind.
 */
export const scopeShareScopeFactsSchema = Type.Object(
    {
        archived: Type.Boolean(),
        baseCommit: Type.Optional(identifierSchema),
        baseRef: Type.Optional(labelSchema),
        createdAt: timestampSchema,
        /** The folder's own name. Never the path that leads to it. */
        folderName: Type.Optional(labelSchema),
        gitAhead: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        gitBehind: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        gitBranch: Type.Optional(labelSchema),
        gitDetached: Type.Boolean(),
        gitHead: Type.Optional(identifierSchema),
        name: labelSchema,
        scopeId: identifierSchema,
        scopeKind: Type.Union([Type.Literal("workspace"), Type.Literal("project")]),
        /** A workspace's lifecycle status; a project reports its readiness the same way. */
        status: labelSchema,
        title: Type.Optional(labelSchema),
        updatedAt: timestampSchema,
    },
    exact,
);
export type ScopeShareScopeFacts = Static<typeof scopeShareScopeFactsSchema>;

/** One session's place in the shared scope, without any of its content. */
export const scopeShareSessionIndexSchema = Type.Object(
    {
        agentKind: labelSchema,
        archived: Type.Boolean(),
        createdAt: timestampSchema,
        description: Type.Optional(labelSchema),
        modelLabel: labelSchema,
        parentSessionId: Type.Optional(identifierSchema),
        providerLabel: labelSchema,
        rootSessionId: identifierSchema,
        sessionId: identifierSchema,
        status: labelSchema,
        title: Type.Optional(labelSchema),
        updatedAt: timestampSchema,
        workspaceId: Type.Optional(identifierSchema),
    },
    exact,
);
export type ScopeShareSessionIndex = Static<typeof scopeShareSessionIndexSchema>;

/**
 * One entry of the scope's log.
 *
 * A transcript entry reuses the session-share projection verbatim, so a member
 * renders a shared workspace's conversation with exactly the code that renders a
 * shared session, and the owning session travels in this envelope rather than
 * inside the payload.
 */
export const scopeShareProjectionSchema = Type.Union([
    Type.Object(
        {
            payload: scopeShareScopeFactsSchema,
            subject: Type.Literal("scope"),
            version: Type.Literal(1),
        },
        exact,
    ),
    Type.Object(
        {
            payload: scopeShareSessionIndexSchema,
            sessionId: identifierSchema,
            subject: Type.Literal("session_index"),
            version: Type.Literal(1),
        },
        exact,
    ),
    Type.Object(
        {
            payload: sessionShareProjectionSchema,
            sessionId: identifierSchema,
            subject: Type.Literal("session_event"),
            version: Type.Literal(1),
        },
        exact,
    ),
]);
export type ScopeShareProjection = Static<typeof scopeShareProjectionSchema>;

/** Build the opaque entry one projection travels as. */
export function projectScopeShareEntry(options: {
    createdAt: number;
    projection: ScopeShareProjection;
    shareEventId: string;
    shareId: string;
    shareSequence: number;
}): ShareOpaqueEntry {
    const canonicalJson = canonicalShareJson(options.projection);
    return {
        canonicalJson,
        contentHash: shareContentHash(canonicalJson),
        createdAt: options.createdAt,
        shareEventId: options.shareEventId,
        shareId: options.shareId,
        shareSequence: options.shareSequence,
    };
}

/** The subject a projection belongs to, which is how superseded facts are found. */
export function scopeShareProjectionSubject(projection: ScopeShareProjection): {
    subjectId: string;
    subjectKind: ScopeShareSubjectKind;
} {
    return projection.subject === "scope"
        ? { subjectId: projection.payload.scopeId, subjectKind: "scope" }
        : { subjectId: projection.sessionId, subjectKind: projection.subject };
}
