import type { Context } from "@steve.kite/stdlib";

import {
    CURRENT_ONBOARDING_VERSION,
    type OnboardMurmurRequest,
    type OnboardMurmurResponse,
    type OnboardingStatus,
} from "../protocol/index.js";
import { onboardingMarkCompleted } from "../persistence/onboarding/onboardingMarkCompleted.js";
import { queryOnboardingState } from "../persistence/onboarding/queryOnboardingState.js";

export interface OnboardingServiceContract {
    onboardMurmur(ctx: Context, request: OnboardMurmurRequest): Promise<OnboardMurmurResponse>;
    status(ctx: Context): Promise<OnboardingStatus>;
}

export interface OnboardingPersistence {
    query<T>(ctx: Context, operation: (ctx: Context) => Promise<T>): Promise<T>;
    transaction<T>(ctx: Context, operation: (ctx: Context) => Promise<T>): Promise<T>;
}

export interface OnboardingServiceOptions {
    currentVersion?: number;
    murmurConfigured: (ctx: Context) => boolean | Promise<boolean>;
    onboardMurmur: (ctx: Context, request: OnboardMurmurRequest) => Promise<OnboardMurmurResponse>;
    persistence: OnboardingPersistence;
    profileComplete: (ctx: Context) => boolean | Promise<boolean>;
    /** Whether the daemon's current model catalog exposes at least one available model. */
    providersConfigured: (ctx: Context) => boolean | Promise<boolean>;
}

/**
 * Answers which onboarding step comes next and records completion durably.
 *
 * Onboarding proves each requirement once. After provider and profile setup, the
 * person must explicitly enable or disable Murmur before the version completes.
 */
export class OnboardingService implements OnboardingServiceContract {
    readonly #currentVersion: number;
    readonly #murmurConfigured: (ctx: Context) => boolean | Promise<boolean>;
    readonly #onboardMurmur: (
        ctx: Context,
        request: OnboardMurmurRequest,
    ) => Promise<OnboardMurmurResponse>;
    readonly #persistence: OnboardingPersistence;
    readonly #profileComplete: (ctx: Context) => boolean | Promise<boolean>;
    readonly #providersConfigured: (ctx: Context) => boolean | Promise<boolean>;

    constructor(options: OnboardingServiceOptions) {
        this.#currentVersion = options.currentVersion ?? CURRENT_ONBOARDING_VERSION;
        this.#murmurConfigured = options.murmurConfigured;
        this.#onboardMurmur = options.onboardMurmur;
        this.#persistence = options.persistence;
        this.#profileComplete = options.profileComplete;
        this.#providersConfigured = options.providersConfigured;
    }

    async status(ctx: Context): Promise<OnboardingStatus> {
        if (await this.#completed(ctx)) return this.#status("complete");
        if (!(await this.#providersConfigured(ctx))) {
            // Configuration may have changed while the check ran; completion stays authoritative.
            return (await this.#completed(ctx))
                ? this.#status("complete")
                : this.#status("provider_setup");
        }
        if (await this.#completed(ctx)) return this.#status("complete");
        if (!(await this.#profileComplete(ctx))) return this.#status("profile_required");
        if (!(await this.#murmurConfigured(ctx))) return this.#status("murmur_setup");
        await this.#markCompleted(ctx);
        return this.#status("complete");
    }

    async onboardMurmur(
        ctx: Context,
        request: OnboardMurmurRequest,
    ): Promise<OnboardMurmurResponse> {
        if (!(await this.#completed(ctx))) {
            if (!(await this.#providersConfigured(ctx))) {
                throw new Error("Configure a provider before setting up Murmur.");
            }
            if (!(await this.#profileComplete(ctx))) {
                throw new Error("Create a human profile before setting up Murmur.");
            }
        }
        const result = await this.#onboardMurmur(ctx, request);
        if (!(await this.#murmurConfigured(ctx))) {
            throw new Error("Murmur onboarding did not persist a choice.");
        }
        await this.#markCompleted(ctx);
        return result;
    }

    async #completed(ctx: Context): Promise<boolean> {
        return (
            (await this.#persistence.query(ctx, async (ctx) => queryOnboardingState(ctx)))
                .completedVersion >= this.#currentVersion
        );
    }

    async #markCompleted(ctx: Context): Promise<void> {
        await this.#persistence.transaction(ctx, async (ctx) =>
            onboardingMarkCompleted(ctx, this.#currentVersion),
        );
    }

    #status(state: OnboardingStatus["state"]): OnboardingStatus {
        return {
            onboardingVersion: this.#currentVersion,
            state,
        };
    }
}
