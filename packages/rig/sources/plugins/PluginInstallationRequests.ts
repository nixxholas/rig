import type { InstalledPlugin } from "./installPluginFromPath.js";
import { PluginCatalogError } from "./PluginCatalogError.js";

const MAXIMUM_REQUESTS = 256;

/** Bounded daemon ownership for retrying one exact installation without applying it twice. */
export class PluginInstallationRequests {
    readonly #requests = new Map<
        string,
        { completed: boolean; promise: Promise<InstalledPlugin>; sourceIdentity: string }
    >();

    run(
        requestId: string,
        sourceIdentity: string,
        install: () => Promise<InstalledPlugin>,
    ): Promise<InstalledPlugin> {
        const existing = this.#requests.get(requestId);
        if (existing !== undefined) {
            if (existing.sourceIdentity !== sourceIdentity) {
                throw new PluginCatalogError(
                    "invalid_source",
                    "That plugin installation request identity already belongs to a different source.",
                );
            }
            return existing.promise;
        }
        while (this.#requests.size >= MAXIMUM_REQUESTS) {
            let completedRequestId: string | undefined;
            for (const [candidateRequestId, entry] of this.#requests) {
                if (!entry.completed) continue;
                completedRequestId = candidateRequestId;
                break;
            }
            if (completedRequestId === undefined) {
                throw new PluginCatalogError(
                    "source_unavailable",
                    "Rig is already handling the maximum number of retained plugin installation requests.",
                );
            }
            this.#requests.delete(completedRequestId);
        }
        const operation = install();
        const entry = { completed: false, promise: operation, sourceIdentity };
        entry.promise = operation.then(
            (result) => {
                entry.completed = true;
                return result;
            },
            (error: unknown) => {
                this.#requests.delete(requestId);
                throw error;
            },
        );
        this.#requests.set(requestId, entry);
        return entry.promise;
    }
}
