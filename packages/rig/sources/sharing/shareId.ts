import { createId } from "@paralleldrive/cuid2";
import { Type, type Static } from "@sinclair/typebox";

/**
 * What a share replicates: one session's transcript, one workspace, or a whole
 * project.
 */
export const shareKindSchema = Type.Union([
    Type.Literal("session"),
    Type.Literal("workspace"),
    Type.Literal("project"),
]);
export type ShareKind = Static<typeof shareKindSchema>;

/**
 * A share's kind is carried in its own identifier.
 *
 * A shareId is a primary key, it is bound into Murmur's durable records, and it
 * is signed into every invitation — so the prefix is authenticated rather than a
 * hint a peer could rewrite. Session shares deliberately keep the bare cuid2 they
 * have always had: existing identifiers cannot be reformatted, so the unprefixed
 * form is the rule for that kind rather than a compatibility branch.
 */
const PREFIXES: Readonly<Record<Exclude<ShareKind, "session">, string>> = {
    project: "prj_",
    workspace: "wsp_",
};

export function createShareId(kind: ShareKind): string {
    return kind === "session" ? createId() : `${PREFIXES[kind]}${createId()}`;
}

export function shareKindOf(shareId: string): ShareKind {
    if (shareId.startsWith(PREFIXES.workspace)) return "workspace";
    if (shareId.startsWith(PREFIXES.project)) return "project";
    return "session";
}
