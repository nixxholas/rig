import type { SecretReference } from "./types.js";
import type { SecretRegistry } from "./SecretRegistry.js";

export interface RuntimeCommandSecret {
    activate?: () => RuntimeCommandSecretLease;
    description: string;
    environment: Readonly<Record<string, string>>;
    environmentVariables?: readonly string[];
    id: string;
    trustedLoopbackPorts?: readonly number[];
}

export interface RuntimeCommandSecretLease {
    environment: Readonly<Record<string, string>>;
    release(): void;
}

export interface ActivatedCommandSecrets {
    environment: NodeJS.ProcessEnv;
    release(): void;
}

export class SessionSecretContext {
    readonly #environmentVariables = new Map<string, Set<string>>();
    readonly #projectAttached = new Set<string>();
    readonly #registry: SecretRegistry;
    readonly #runtimeSecrets = new Map<string, RuntimeCommandSecret>();
    readonly #sessionAttached = new Set<string>();

    constructor(
        registry: SecretRegistry,
        sessionSecretIds: readonly string[] = [],
        projectSecretIds: readonly string[] = [],
    ) {
        this.#registry = registry;
        for (const secretId of sessionSecretIds) this.#attachRestored(secretId, "session");
        for (const secretId of projectSecretIds) this.#attachRestored(secretId, "project");
    }

    attach(secretId: string, scope: "project" | "session" = "session"): void {
        this.#modelReference(secretId);
        this.#setForScope(scope).add(secretId);
        this.#rememberEnvironmentVariables(secretId);
    }

    detach(secretId: string, scope: "project" | "session" = "session"): boolean {
        const removed = this.#setForScope(scope).delete(secretId);
        if (!this.ids().includes(secretId)) this.#environmentVariables.delete(secretId);
        return removed;
    }

    ids(): readonly string[] {
        this.#purgeHiddenAttachments();
        return [...new Set([...this.#sessionAttached, ...this.#projectAttached])].sort();
    }

    projectIds(): readonly string[] {
        this.#purgeHiddenAttachments();
        return [...this.#projectAttached].sort();
    }

    sessionIds(): readonly string[] {
        this.#purgeHiddenAttachments();
        return [...this.#sessionAttached].sort();
    }

    references(): readonly SecretReference[] {
        const attached = this.ids().flatMap((secretId) => {
            try {
                const reference = this.#modelReference(secretId);
                this.#rememberEnvironmentVariables(secretId);
                return [reference];
            } catch {
                return [];
            }
        });
        const runtime = [...this.#runtimeSecrets.values()].map((secret) => ({
            description: secret.description,
            environmentVariables: [
                ...(secret.environmentVariables ?? Object.keys(secret.environment)),
            ].sort(),
            id: secret.id,
        }));
        return [...attached, ...runtime].sort((left, right) => left.id.localeCompare(right.id));
    }

    environmentVariables(): readonly string[] {
        for (const secretId of this.ids()) this.#rememberEnvironmentVariables(secretId);
        return [
            ...new Set([
                ...[...this.#environmentVariables.values()].flatMap((names) => [...names]),
                ...[...this.#runtimeSecrets.values()].flatMap(
                    (secret) => secret.environmentVariables ?? Object.keys(secret.environment),
                ),
            ]),
        ];
    }

    resolve(secretIds: readonly string[]): NodeJS.ProcessEnv {
        const attached = new Set(this.ids());
        const selected = [...new Set(secretIds)];
        for (const secretId of selected) {
            if (!attached.has(secretId) && !this.#runtimeSecrets.has(secretId)) {
                throw new Error(`Secret '${secretId}' is not attached to this session or project.`);
            }
            if (!this.#runtimeSecrets.has(secretId)) this.#modelReference(secretId);
        }
        const environment = Object.create(null) as NodeJS.ProcessEnv;
        const owners = new Map<string, string>();
        for (const secretId of selected) {
            const runtime = this.#runtimeSecrets.get(secretId);
            const resolved =
                runtime === undefined ? this.#registry.resolve([secretId]) : runtime.environment;
            for (const [name, value] of Object.entries(resolved)) {
                const ownerKey = name.toUpperCase();
                const owner = owners.get(ownerKey);
                if (owner !== undefined) {
                    throw new Error(
                        `Secrets '${owner}' and '${secretId}' both define ${name}. Select only one of them for this command.`,
                    );
                }
                owners.set(ownerKey, secretId);
                environment[name] = value;
            }
        }
        return environment;
    }

    setRuntimeSecret(secret: RuntimeCommandSecret): void {
        if (this.ids().includes(secret.id)) {
            throw new Error(
                `Secret '${secret.id}' is already attached to this session or project.`,
            );
        }
        this.#runtimeSecrets.set(secret.id, {
            ...(secret.activate === undefined ? {} : { activate: secret.activate }),
            description: secret.description,
            environment: { ...secret.environment },
            ...(secret.environmentVariables === undefined
                ? {}
                : { environmentVariables: [...secret.environmentVariables] }),
            id: secret.id,
            ...(secret.trustedLoopbackPorts === undefined
                ? {}
                : { trustedLoopbackPorts: [...secret.trustedLoopbackPorts] }),
        });
    }

    removeRuntimeSecret(secretId: string): boolean {
        return this.#runtimeSecrets.delete(secretId);
    }

    activate(secretIds: readonly string[] | undefined): ActivatedCommandSecrets {
        if (secretIds === undefined || secretIds.length === 0) {
            return { environment: {}, release: () => {} };
        }
        const leases = [...new Set(secretIds)].flatMap((secretId) => {
            const activate = this.#runtimeSecrets.get(secretId)?.activate;
            return activate === undefined ? [] : [activate()];
        });
        const environment = Object.create(null) as NodeJS.ProcessEnv;
        for (const lease of leases) {
            for (const [name, value] of Object.entries(lease.environment)) {
                if (environment[name] !== undefined) {
                    for (const acquired of leases) acquired.release();
                    throw new Error(`Activated secrets both define ${name}.`);
                }
                environment[name] = value;
            }
        }
        let released = false;
        return {
            environment,
            release: () => {
                if (released) return;
                released = true;
                for (const lease of leases.reverse()) lease.release();
            },
        };
    }

    trustedLoopbackPorts(secretIds: readonly string[] | undefined): readonly number[] {
        if (secretIds === undefined || secretIds.length === 0) return [];
        const selected = new Set(secretIds);
        for (const secretId of selected) {
            if (!this.ids().includes(secretId) && !this.#runtimeSecrets.has(secretId)) {
                throw new Error(`Secret '${secretId}' is not attached to this session or project.`);
            }
        }
        return [
            ...new Set(
                [...selected].flatMap(
                    (secretId) => this.#runtimeSecrets.get(secretId)?.trustedLoopbackPorts ?? [],
                ),
            ),
        ];
    }

    #attachRestored(secretId: string, scope: "project" | "session"): void {
        try {
            if (this.#registry.reference(secretId).availableToModel === false) return;
        } catch {
            // Restored IDs remain attached while the instance registry is rebuilt.
        }
        this.#setForScope(scope).add(secretId);
        this.#rememberEnvironmentVariables(secretId);
    }

    #purgeHiddenAttachments(): void {
        for (const secretId of new Set([...this.#sessionAttached, ...this.#projectAttached])) {
            try {
                if (this.#registry.reference(secretId).availableToModel !== false) continue;
                this.#sessionAttached.delete(secretId);
                this.#projectAttached.delete(secretId);
                this.#environmentVariables.delete(secretId);
            } catch {
                // An environment registration may be restored after this session.
            }
        }
    }

    #modelReference(secretId: string): SecretReference {
        const reference = this.#registry.reference(secretId);
        if (reference.availableToModel === false) {
            throw new Error(
                `Secret '${secretId}' is managed by Rig and cannot be attached to agent commands.`,
            );
        }
        return reference;
    }

    #rememberEnvironmentVariables(secretId: string): void {
        try {
            const environmentVariables = this.#registry.environmentVariables(secretId);
            const names = this.#environmentVariables.get(secretId) ?? new Set<string>();
            for (const environmentVariable of environmentVariables) {
                names.add(environmentVariable);
            }
            this.#environmentVariables.set(secretId, names);
        } catch {
            // Restored IDs remain attached while the instance registry is rebuilt.
        }
    }

    #setForScope(scope: "project" | "session"): Set<string> {
        return scope === "project" ? this.#projectAttached : this.#sessionAttached;
    }
}
