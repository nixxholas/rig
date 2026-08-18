import {
    type AgentKV,
    type AgentModule,
    type AgentModuleHooks,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { createId } from "@paralleldrive/cuid2";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    titleNameRequestSchema,
    titleRefineRequestSchema,
    titleSessionIdSchema,
    titleWorkspaceIdSchema,
    type TitleNameRequest,
    type TitleNames,
    type TitleRefineRequest,
} from "./Title.js";
import { ConfigModule } from "../config/ConfigModule.js";
import type { Workspace } from "../workspaces/Workspace.js";
import { WorkspacesModule } from "../workspaces/WorkspacesModule.js";
import { withPreservedNumericPrefix } from "../workspaces/impl/withPreservedNumericPrefix.js";
import {
    createNamingRequest,
    createRefinementRequest,
    wantedNames,
} from "./impl/createNamingRequest.js";
import { parseSuggestedNames } from "./impl/parseSuggestedNames.js";
import { runNamingInference } from "./impl/runNamingInference.js";
import { selectNamingRoute } from "./impl/selectNamingRoute.js";

/**
 * How long one name may take.
 *
 * A person is watching their own first message while this runs, and the agent's real work is
 * waiting behind it, so a name that has not arrived quickly is worth less than starting. Three
 * words from the cheapest model at no reasoning effort is seconds of work; ten of them is already
 * an account that is not going to answer.
 */
const DEFAULT_NAMING_TIMEOUT_MS = 10_000;

export const titlesModuleOptionsSchema = Type.Object(
    {
        /** The accounts a name may be written on, and the catalog it picks a cheap model from. */
        config: Type.Unsafe<ConfigModule>(Type.Object({}, { additionalProperties: true })),
        /** The catalog a named workspace is renamed through. */
        workspaces: Type.Unsafe<WorkspacesModule>(Type.Object({}, { additionalProperties: true })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 120_000 })),
        clock: Type.Optional(Type.Function([], Type.Number())),
    },
    { additionalProperties: false },
);

export type TitlesModuleOptions = Static<typeof titlesModuleOptionsSchema>;

/**
 * The names a first message settles: the chat's title, and the workspace and branch it works in.
 *
 * One bounded inference on the cheapest model of the account the chat is already running on
 * answers both: the title a person reads in a list, and the lower-case slug the folder and the Git
 * branch both carry. Those two are one subject written two ways, so one reading of the message
 * settles them — and this runs in front of the agent's own work, where a second round trip is time
 * a person spends watching a placeholder. Nothing here runs inside the agent's loop or touches its
 * history: naming is a side question asked about the conversation, not a turn of it.
 *
 * A chat gets one second look, when its first piece of work is over and the conversation says what
 * the first message could only ask for. The workspace and the branch get none: a folder and a Git
 * ref are named once, because renaming either would move them out from under agents already
 * working there.
 *
 * The module remembers both of those onces — which workspaces have taken a name, and which chats
 * have had their second look — because the triggers are events and events happen again.
 */
export class TitlesModule implements AgentModule<AnyAgentTool> {
    readonly name = "titles";

    readonly #config: ConfigModule;
    readonly #workspaces: WorkspacesModule;
    readonly #timeoutMs: number;
    readonly #clock: () => number;
    #store: AgentKV | undefined;

    constructor(options: TitlesModuleOptions) {
        if (!Value.Check(titlesModuleOptionsSchema, options)) {
            throw new Error("Titles module options are invalid.");
        }
        this.#config = options.config;
        this.#workspaces = options.workspaces;
        this.#timeoutMs = options.timeoutMs ?? DEFAULT_NAMING_TIMEOUT_MS;
        this.#clock = options.clock ?? Date.now;
    }

    /**
     * Takes hold of the store shared by every agent in the collection.
     *
     * What this module remembers belongs to the installation rather than to any one conversation:
     * whether a workspace has taken a name is a question the next chat in it asks. The store only
     * reaches a module through a lifecycle hook, and every agent — the root one included — is
     * created or restored while the collection starts, so it is here before anything can ask.
     */
    readonly beforeStart = (): AgentModuleHooks<AnyAgentTool> => ({
        agentCreatedTransact: (_ctx, scope) => {
            this.#store = scope.sharedKV;
        },
        agentRestoredTransact: (_ctx, scope) => {
            this.#store = scope.sharedKV;
        },
    });

    /**
     * Names a chat from the first thing a person said, and the workspace it works in with it.
     *
     * A chat is called nothing at all, and a workspace someone opened from a client is called
     * something like "Workspace 3", until there is anything to name them after; the first message
     * is that. This runs in front of the agent's own work, so a person is not reading a placeholder
     * while the answer arrives, and it is one request rather than two — the folder and the Git
     * branch carry the same name, and the title is the same subject written as prose.
     *
     * The workspace name is settled here and forwarded to the catalog that owns folders and
     * branches; the chat title is answered to the caller, because what a chat is called belongs to
     * whoever keeps chats. A workspace takes a name once, from the first chat that manages it:
     * renaming it later would move the folder out from under agents already working in it. A name a
     * person chose is never replaced, and failing to think of one never fails the message.
     */
    async nameFromFirstMessage(
        ctx: Context,
        agentId: string,
        request: {
            readonly firstMessage: string;
            readonly providerId?: string;
            readonly sessionNamed?: boolean;
            readonly workspace?: { readonly projectId: string; readonly workspaceId: string };
        },
    ): Promise<TitlesFromFirstMessage> {
        if (request.firstMessage.trim().length === 0) return {};
        const place = request.workspace;
        const wantTitle = request.sessionNamed !== true;
        try {
            const current = await this.#unnamedWorkspace(ctx, agentId, place);
            const wantSlug = current !== undefined;
            if (!wantSlug && !wantTitle) return {};
            const names = await this.suggestNames(ctx, {
                firstMessage: request.firstMessage,
                wanted: { slug: wantSlug, title: wantTitle },
                ...(request.providerId === undefined ? {} : { providerId: request.providerId }),
            });
            const renamed =
                current === undefined || names.slug === undefined
                    ? undefined
                    : await this.#renameWorkspace(ctx, agentId, current, names.slug);
            if (renamed !== undefined && place !== undefined) {
                await this.markWorkspaceNamed(ctx, place.workspaceId);
            }
            return {
                ...(renamed === undefined || names.slug === undefined
                    ? {}
                    : { branch: names.slug }),
                ...(wantTitle && names.title !== undefined ? { title: names.title } : {}),
                ...(renamed === undefined ? {} : { workspace: renamed }),
            };
        } catch (error) {
            ctx.log.debug("Naming a chat from its first message did not happen.", {}, error);
            return {};
        }
    }

    /**
     * The names a first message suggests, in one request.
     *
     * Both names come out of one reading of the message because they are two ways of saying the
     * same subject, and because a person is waiting on their own first message while this runs.
     * Every name is optional by design: what could not be named keeps its placeholder, and the
     * message is already on its way.
     */
    async suggestNames(
        ctx: Context,
        request: TitleNameRequest,
        options: { readonly signal?: AbortSignal } = {},
    ): Promise<TitleNames> {
        if (!Value.Check(titleNameRequestSchema, request)) {
            throw new Error("Naming request is invalid.");
        }
        if (request.firstMessage.trim().length === 0) return {};
        if (wantedNames(request.wanted).length === 0) return {};
        const route = this.#route(request.providerId);
        if (route === undefined) return {};
        const text = createNamingRequest(request.wanted, request.firstMessage);
        const answer = await runNamingInference(ctx, {
            instructions: text.instructions,
            prompt: text.prompt,
            providers: this.#config.providers,
            route,
            timeoutMs: this.#timeoutMs,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        return parseSuggestedNames(answer, request.wanted);
    }

    /**
     * A second look at a chat's title, once the chat is a conversation rather than one message.
     *
     * The first message is a request, and a request often turns out to be about something else:
     * a question that became a rewrite, a bug report that became a design. This asks the same
     * cheap model whether the name still fits, and it answers with the name it already had unless
     * the conversation plainly says otherwise. Nothing back means the title stands.
     */
    async refineChat(
        ctx: Context,
        request: TitleRefineRequest,
        options: { readonly signal?: AbortSignal } = {},
    ): Promise<string | undefined> {
        if (!Value.Check(titleRefineRequestSchema, request)) {
            throw new Error("Title refinement request is invalid.");
        }
        if (request.transcript.trim().length === 0) return undefined;
        const route = this.#route(request.providerId);
        if (route === undefined) return undefined;
        const text = createRefinementRequest(request.transcript, request.currentTitle);
        const answer = await runNamingInference(ctx, {
            instructions: text.instructions,
            prompt: text.prompt,
            providers: this.#config.providers,
            route,
            timeoutMs: this.#timeoutMs,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        return parseSuggestedNames(answer, { title: true }).title;
    }

    /**
     * Takes the one second look a chat gets, or says it has already been taken.
     *
     * A chat is looked at again once, when its first piece of work is over. The claim is durable
     * because the trigger is not: a restart, a second turn and a resumed run would each otherwise
     * pay for another naming, and a title that changes on every turn is a title nobody can find a
     * chat by.
     */
    async claimChatRefinement(ctx: Context, sessionId: string): Promise<boolean> {
        assertSessionId(sessionId);
        // One statement decides it. Two triggers can reach this at the same moment — the person
        // writing again while the turn that was about to end ends — and a read followed by a write
        // would let both of them believe they won.
        const attempt = createId();
        const stored = await this.#refined().getOrCreate(ctx, sessionId, () => ({
            at: Math.trunc(this.#clock()),
            attempt,
        }));
        return Value.Check(refinementClaimSchema, stored) && stored.attempt === attempt;
    }

    /**
     * Hands back a claim that produced nothing.
     *
     * An attempt that thought of no name spent nothing: the account was busy, the answer came back
     * empty, the conversation was not worth reading yet. Keeping the claim would settle the chat's
     * first title for good on the strength of a failure.
     */
    async releaseChatRefinement(ctx: Context, sessionId: string): Promise<void> {
        assertSessionId(sessionId);
        await this.#refined().delete(ctx, sessionId);
    }

    /** Whether a workspace has already taken the name of a chat. */
    async workspaceWasNamed(ctx: Context, workspaceId: string): Promise<boolean> {
        assertWorkspaceId(workspaceId);
        return (await this.#named().read(ctx, workspaceId)) !== undefined;
    }

    /**
     * Records that a workspace has taken a name from a chat.
     *
     * Only a name that actually arrived is recorded. An attempt that failed spent nothing: the
     * next chat in the workspace tries again rather than leaving the folder called "workspace 3"
     * for good.
     */
    async markWorkspaceNamed(ctx: Context, workspaceId: string): Promise<void> {
        assertWorkspaceId(workspaceId);
        await this.#named().write(ctx, workspaceId, { at: Math.trunc(this.#clock()) });
    }

    /**
     * The cheapest model of the account the chat is already on, or of the configured default.
     *
     * Naming is a side question about a conversation, not part of it, so it is asked of the least
     * expensive model that can answer — and of the same account, because that is the credential
     * this installation is known to have.
     */
    #route(providerId: string | undefined): ReturnType<typeof selectNamingRoute> {
        const models = this.#config.models;
        return selectNamingRoute(models, providerId, models[0]?.providerId);
    }

    /**
     * The workspace this chat could still name, or nothing.
     *
     * Two things settle a workspace's name for good, and either is enough: a person named it, or an
     * earlier chat did. Both are checked before a model is asked anything, because a name that
     * cannot be used is a request not worth making.
     */
    async #unnamedWorkspace(
        ctx: Context,
        agentId: string,
        place: { readonly projectId: string; readonly workspaceId: string } | undefined,
    ): Promise<Workspace | undefined> {
        if (place === undefined) return undefined;
        if (await this.workspaceWasNamed(ctx, place.workspaceId)) return undefined;
        const current = await this.#workspaces.get(ctx, agentId, place.workspaceId);
        if (current === undefined || current.projectRef !== place.projectId) return undefined;
        return current.nameConfigured ? undefined : current;
    }

    /**
     * Hands the name to the catalog that owns folders and branches.
     *
     * The folder and the branch take the same name: they are the same piece of work under two
     * filesystems, and a folder called one thing on a branch called another is only confusing.
     */
    async #renameWorkspace(
        ctx: Context,
        agentId: string,
        current: Workspace,
        slug: string,
    ): Promise<Workspace> {
        return await this.#workspaces.inheritName(ctx, agentId, {
            workspaceId: current.id,
            name: withPreservedNumericPrefix(current.name, slug),
        });
    }

    /** The workspaces that have taken a name, keyed by workspace. */
    #named(): AgentKV {
        return this.#requireStore().scoped("named");
    }

    /** The chats whose second look has been claimed, keyed by chat. */
    #refined(): AgentKV {
        return this.#requireStore().scoped("refined");
    }

    #requireStore(): AgentKV {
        if (this.#store === undefined) {
            throw new Error("The titles module has not been started by an agent collection.");
        }
        return this.#store;
    }
}

/** What a first message settled: the chat's title, and the workspace and branch it renamed. */
export interface TitlesFromFirstMessage {
    readonly branch?: string;
    readonly title?: string;
    readonly workspace?: Workspace;
}

/** What a claimed second look stores: when it was claimed, and by which attempt. */
const refinementClaimSchema = Type.Object(
    {
        at: Type.Integer({ minimum: 0 }),
        attempt: Type.String({ minLength: 1, maxLength: 64 }),
    },
    { additionalProperties: false },
);

function assertWorkspaceId(workspaceId: string): void {
    if (!Value.Check(titleWorkspaceIdSchema, workspaceId)) {
        throw new Error("Workspace ID is invalid.");
    }
}

function assertSessionId(sessionId: string): void {
    if (!Value.Check(titleSessionIdSchema, sessionId)) {
        throw new Error("Session ID is invalid.");
    }
}
