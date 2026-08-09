import { CURRENT_ONBOARDING_VERSION, type OnboardingStatus } from "../protocol/index.js";
import { onboardingMarkCompleted } from "../persistence/onboarding/onboardingMarkCompleted.js";
import { queryOnboardingState } from "../persistence/onboarding/queryOnboardingState.js";
import type { TX } from "../persistence/Transaction.js";

export interface OnboardingServiceContract {
    status(): Promise<OnboardingStatus>;
}

export interface OnboardingPersistence {
    query<T>(operation: (tx: TX) => T): T;
    transaction<T>(operation: (tx: TX) => T): T;
}

export interface OnboardingServiceOptions {
    currentVersion?: number;
    persistence: OnboardingPersistence;
    profileComplete: () => boolean;
    /** Whether the daemon's current model catalog exposes at least one available model. */
    providersConfigured: () => boolean | Promise<boolean>;
}

/**
 * Answers which onboarding step comes next and records completion durably.
 *
 * Onboarding proves each requirement once. A provider only has to be configured;
 * inference is not verified, and a provider failing later never reopens onboarding.
 */
export class OnboardingService implements OnboardingServiceContract {
    readonly #currentVersion: number;
    readonly #persistence: OnboardingPersistence;
    readonly #profileComplete: () => boolean;
    readonly #providersConfigured: () => boolean | Promise<boolean>;

    constructor(options: OnboardingServiceOptions) {
        this.#currentVersion = options.currentVersion ?? CURRENT_ONBOARDING_VERSION;
        this.#persistence = options.persistence;
        this.#profileComplete = options.profileComplete;
        this.#providersConfigured = options.providersConfigured;
    }

    async status(): Promise<OnboardingStatus> {
        if (this.#completed()) return this.#status("complete");
        if (!(await this.#providersConfigured())) {
            // Configuration may have changed while the check ran; completion stays authoritative.
            return this.#completed() ? this.#status("complete") : this.#status("provider_setup");
        }
        if (this.#completed()) return this.#status("complete");
        if (!this.#profileComplete()) return this.#status("profile_required");
        this.#markCompleted();
        return this.#status("complete");
    }

    #completed(): boolean {
        return (
            this.#persistence.query(queryOnboardingState).completedVersion >= this.#currentVersion
        );
    }

    #markCompleted(): void {
        this.#persistence.transaction((tx) => onboardingMarkCompleted(tx, this.#currentVersion));
    }

    #status(state: OnboardingStatus["state"]): OnboardingStatus {
        return {
            onboardingVersion: this.#currentVersion,
            state,
        };
    }
}
