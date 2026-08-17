import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

/** Which of the three names a suggestion is for. Each one is asked for on its own. */
export const workspaceNameKindSchema = Type.Union([
    Type.Literal("branch"),
    Type.Literal("chat"),
    Type.Literal("workspace"),
]);
export type WorkspaceNameKind = Static<typeof workspaceNameKindSchema>;

export interface WorkspaceNameRequest {
    /** The first thing the person said, which is all the naming has to go on. */
    readonly firstMessage: string;
    readonly kind: WorkspaceNameKind;
    /** The provider the session runs on, so naming can use its cheapest model. */
    readonly providerId?: string;
}

/**
 * Names the first message suggests. The session layer supplies this, because choosing the cheapest
 * model of the session's own provider is inference wiring rather than project or Git work.
 */
export interface WorkspaceNameGenerator {
    suggest(ctx: Context, request: WorkspaceNameRequest): Promise<string | undefined>;
}

export interface GeneratedWorkspaceNames {
    readonly branch?: string;
    readonly chat?: string;
    readonly workspace?: string;
}

/**
 * Asks for the workspace name, the chat name and the branch name separately.
 *
 * They are three different questions — a folder, a conversation, and a Git ref — and asking for
 * them together produces one answer wearing three hats. A generator that declines, fails, or
 * answers with nothing usable simply leaves that name alone.
 */
export async function generateWorkspaceNames(
    ctx: Context,
    generator: WorkspaceNameGenerator,
    request: Omit<WorkspaceNameRequest, "kind">,
    wanted: { branch: boolean; chat: boolean; workspace: boolean },
): Promise<GeneratedWorkspaceNames> {
    const ask = async (kind: WorkspaceNameKind): Promise<string | undefined> => {
        try {
            const suggestion = await generator.suggest(ctx, { ...request, kind });
            return cleanSuggestion(suggestion);
        } catch {
            return undefined;
        }
    };
    const named = async (kind: WorkspaceNameKind, asked: boolean) => {
        if (!asked) return {};
        const name = await ask(kind);
        return name === undefined ? {} : { [kind]: name };
    };
    return {
        ...(await named("workspace", wanted.workspace)),
        ...(await named("chat", wanted.chat)),
        ...(await named("branch", wanted.branch)),
    };
}

/**
 * Keeps a leading number and replaces only what follows it.
 *
 * An automatically created workspace is often numbered, and the number is how a person tells one
 * from the next in a list. Naming it after the first message should change what the workspace is
 * about, not where it sits.
 */
export function withPreservedNumericPrefix(current: string, generated: string): string {
    // The separator the person already sees is kept too, so a renamed workspace still reads the
    // way its neighbours in the list do.
    const prefix = /^\d{1,4}[-_ ]+/u.exec(current)?.[0];
    return prefix === undefined ? generated : `${prefix}${generated}`;
}

function cleanSuggestion(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const cleaned = value
        .replace(/[\p{Cc}\p{Cf}]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
    if (cleaned.length === 0) return undefined;
    return [...cleaned].slice(0, 100).join("");
}
