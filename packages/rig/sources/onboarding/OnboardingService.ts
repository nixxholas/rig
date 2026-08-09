import {
    CURRENT_ONBOARDING_VERSION,
    type OnboardMurmurRequest,
    type OnboardMurmurResponse,
    type OnboardingStatus,
} from "../protocol/index.js";
import { onboardingMarkCompleted } from "../persistence/onboarding/onboardingMarkCompleted.js";
import { queryOnboardingState } from "../persistence/onboarding/queryOnboardingState.js";
import type { TX } from "../persistence/Transaction.js";

export interface OnboardingServiceContract {
    onboardMurmur(request: OnboardMurmurRequest): Promise<OnboardMurmurResponse>;
    status(): Promise<OnboardingStatus>;
}

export interface OnboardingPersistence {
    query<T>(operation: (tx: TX) => Promise<T>): Promise<T>;
    transaction<T>(operation: (tx: TX) => Promise<T>): Promise<T>;
}

export interface OnboardingServiceOptions {
    currentVersion?: number;
    murmurConfigured: () => boolean | Promise<boolean>;
    onboardMurmur: (request: OnboardMurmurRequest) => Promise<OnboardMurmurResponse>;
    persistence: OnboardingPersistence;
    profileComplete: () => boolean | Promise<boolean>;
    /** Whether the daemon's current model catalog exposes at least one available model. */
    providersConfigured: () => boolean | Promise<boolean>;
}

/**
 * Answers which onboarding step comes next and records completion durably.
 *
 * Onboarding proves each requirement once. After provider and profile setup, the
 * person must explicitly enable or disable Murmur before the version completes.
 */
export class OnboardingService implements OnboardingServiceContract {
    readonly #currentVersion: number;
    readonly #murmurConfigured: () => boolean | Promise<boolean>;
    readonly #onboardMurmur: (request: OnboardMurmurRequest) => Promise<OnboardMurmurResponse>;
    readonly #persistence: OnboardingPersistence;
    readonly #profileComplete: () => boolean | Promise<boolean>;
    readonly #providersConfigured: () => boolean | Promise<boolean>;

    constructor(options: OnboardingServiceOptions) {
        this.#currentVersion = options.currentVersion ?? CURRENT_ONBOARDING_VERSION;
        this.#murmurConfigured = options.murmurConfigured;
        this.#onboardMurmur = options.onboardMurmur;
        this.#persistence = options.persistence;
        this.#profileComplete = options.profileComplete;
        this.#providersConfigured = options.providersConfigured;
    }

    async status(): Promise<OnboardingStatus> {
        if (await this.#completed()) return this.#status("complete");
        if (!(await this.#providersConfigured())) {
            // Configuration may have changed while the check ran; completion stays authoritative.
            return (await this.#completed())
                ? this.#status("complete")
                : this.#status("provider_setup");
        }
        if (await this.#completed()) return this.#status("complete");
        if (!(await this.#profileComplete())) return this.#status("profile_required");
        if (!(await this.#murmurConfigured())) return this.#status("murmur_setup");
        await this.#markCompleted();
        return this.#status("complete");
    }

    async onboardMurmur(request: OnboardMurmurRequest): Promise<OnboardMurmurResponse> {
        if (!(await this.#completed())) {
            if (!(await this.#providersConfigured())) {
                throw new Error("Configure a provider before setting up Murmur.");
            }
            if (!(await this.#profileComplete())) {
                throw new Error("Create a human profile before setting up Murmur.");
            }
        }
        const result = await this.#onboardMurmur(request);
        if (!(await this.#murmurConfigured())) {
            throw new Error("Murmur onboarding did not persist a choice.");
        }
        await this.#markCompleted();
        return result;
    }

    async #completed(): Promise<boolean> {
        return (
            (await this.#persistence.query(async (tx) => queryOnboardingState(tx)))
                .completedVersion >= this.#currentVersion
        );
    }

    async #markCompleted(): Promise<void> {
        await this.#persistence.transaction(async (tx) =>
            onboardingMarkCompleted(tx, this.#currentVersion),
        );
    }

    #status(state: OnboardingStatus["state"]): OnboardingStatus {
        return {
            onboardingVersion: this.#currentVersion,
            state,
        };
    }
}
