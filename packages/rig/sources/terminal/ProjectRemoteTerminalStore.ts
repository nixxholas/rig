import type { DockerExecutionConfig } from "../execution/index.js";
import { createRemoteTerminalManager } from "./createRemoteTerminalManager.js";
import type { RemoteTerminal } from "./RemoteTerminal.js";
import type { RemoteTerminalManager } from "./RemoteTerminalManager.js";
import type {
    CreateRemoteTerminalRequest,
    RemoteTerminalScope,
    RemoteTerminalSummary,
} from "./types.js";

export interface ProjectRemoteTerminalContext {
    cwd: string;
    docker?: DockerExecutionConfig;
}

interface ScopedRemoteTerminalManager {
    closing?: Promise<void>;
    manager: RemoteTerminalManager;
    pendingCreates: Set<Promise<RemoteTerminal>>;
    scope: RemoteTerminalScope;
}

export class ProjectRemoteTerminalStore {
    readonly #createManager: (
        context: ProjectRemoteTerminalContext,
        ownerId: string,
        onChange: (terminals: readonly RemoteTerminalSummary[]) => void,
    ) => RemoteTerminalManager;
    #closed = false;
    readonly #projectClosures = new Map<string, Promise<void>>();
    readonly #resolveContext: (scope: RemoteTerminalScope) => ProjectRemoteTerminalContext;
    readonly #onChange: (
        scope: RemoteTerminalScope,
        terminals: readonly RemoteTerminalSummary[],
    ) => void;
    readonly #scopes = new Map<string, ScopedRemoteTerminalManager>();
    readonly #workspaceClosures = new Map<string, Promise<void>>();

    constructor(options: {
        createManager?: (
            context: ProjectRemoteTerminalContext,
            ownerId: string,
            onChange: (terminals: readonly RemoteTerminalSummary[]) => void,
        ) => RemoteTerminalManager;
        onChange?: (
            scope: RemoteTerminalScope,
            terminals: readonly RemoteTerminalSummary[],
        ) => void;
        resolveContext: (scope: RemoteTerminalScope) => ProjectRemoteTerminalContext;
    }) {
        this.#createManager =
            options.createManager ??
            ((context, ownerId, onChange) =>
                createRemoteTerminalManager({
                    cwd: context.cwd,
                    ownerId,
                    onChange,
                    ...(context.docker === undefined ? {} : { docker: context.docker }),
                }));
        this.#onChange = options.onChange ?? (() => undefined);
        this.#resolveContext = options.resolveContext;
    }

    close(): Promise<void> {
        this.#closed = true;
        return this.#closeMatching(() => true);
    }

    closeProject(projectId: string): Promise<void> {
        const existing = this.#projectClosures.get(projectId);
        if (existing !== undefined) return existing;
        const closure = this.#closeMatching((scope) => scope.projectId === projectId).finally(
            () => {
                if (this.#projectClosures.get(projectId) === closure) {
                    this.#projectClosures.delete(projectId);
                }
            },
        );
        this.#projectClosures.set(projectId, closure);
        return closure;
    }

    closeWorkspace(projectId: string, workspaceId: string): Promise<void> {
        const key = scopeKey({ projectId, workspaceId });
        const existing = this.#workspaceClosures.get(key);
        if (existing !== undefined) return existing;
        const closure = this.#closeMatching(
            (scope) => scope.projectId === projectId && scope.workspaceId === workspaceId,
        ).finally(() => {
            if (this.#workspaceClosures.get(key) === closure) {
                this.#workspaceClosures.delete(key);
            }
        });
        this.#workspaceClosures.set(key, closure);
        return closure;
    }

    async create(
        scope: RemoteTerminalScope,
        request: CreateRemoteTerminalRequest,
    ): Promise<RemoteTerminal> {
        const key = scopeKey(scope);
        if (
            this.#closed ||
            this.#projectClosures.has(scope.projectId) ||
            this.#workspaceClosures.has(key)
        ) {
            throw new Error("This project or workspace is closing and cannot open a terminal.");
        }
        const scoped = this.#manager(scope);
        if (scoped.closing !== undefined) {
            throw new Error("This project or workspace is closing and cannot open a terminal.");
        }
        const creation = scoped.manager.create(request);
        scoped.pendingCreates.add(creation);
        try {
            return await creation;
        } finally {
            scoped.pendingCreates.delete(creation);
        }
    }

    get(scope: RemoteTerminalScope, terminalId: string): RemoteTerminal | undefined {
        return this.#scopes.get(scopeKey(scope))?.manager.get(terminalId);
    }

    list(scope: RemoteTerminalScope): readonly RemoteTerminal[] {
        return this.#scopes.get(scopeKey(scope))?.manager.list() ?? [];
    }

    groups(): readonly {
        scope: RemoteTerminalScope;
        terminals: readonly RemoteTerminalSummary[];
    }[] {
        return [...this.#scopes.values()].map((scoped) => ({
            scope: { ...scoped.scope },
            terminals: scoped.manager.list().map((terminal) => terminal.summary()),
        }));
    }

    #closeMatching(predicate: (scope: RemoteTerminalScope) => boolean): Promise<void> {
        const closures: Promise<void>[] = [];
        for (const scoped of this.#scopes.values()) {
            if (!predicate(scoped.scope)) continue;
            closures.push(this.#closeScope(scoped));
        }
        return Promise.all(closures).then(() => undefined);
    }

    #closeScope(scoped: ScopedRemoteTerminalManager): Promise<void> {
        if (scoped.closing !== undefined) return scoped.closing;
        const key = scopeKey(scoped.scope);
        scoped.closing = Promise.allSettled(scoped.pendingCreates)
            .then(() => scoped.manager.close())
            .finally(() => {
                if (this.#scopes.get(key) === scoped) this.#scopes.delete(key);
            });
        return scoped.closing;
    }

    #manager(scope: RemoteTerminalScope): ScopedRemoteTerminalManager {
        const key = scopeKey(scope);
        const existing = this.#scopes.get(key);
        if (existing !== undefined) return existing;
        const context = this.#resolveContext(scope);
        const scoped = {
            manager: this.#createManager(context, key, (terminals) =>
                this.#onChange(scope, terminals),
            ),
            pendingCreates: new Set<Promise<RemoteTerminal>>(),
            scope: { ...scope },
        };
        this.#scopes.set(key, scoped);
        return scoped;
    }
}

function scopeKey(scope: RemoteTerminalScope): string {
    return JSON.stringify([scope.projectId, scope.workspaceId ?? null]);
}
