import type { SessionEvent } from "../../protocol/index.js";
import type { ProviderQuota, ProviderQuotaWindow } from "@slopus/rig-providers";
import type { SessionQuotaContribution } from "./types.js";

interface WindowState {
    baselineUsedPercent: number;
    completedUsedPercent: number;
    epochKey: string;
    maximumUsedPercent: number;
}

export function aggregateQuotaContributions(
    events: readonly SessionEvent[],
): SessionQuotaContribution[] {
    const tracker = new SessionQuotaContributionTracker();
    for (const event of events) tracker.apply(event);
    return tracker.snapshot();
}

/** Incremental form used by live sessions so one quota update never rescans history. */
export class SessionQuotaContributionTracker {
    #windows = new Map<string, WindowState>();
    #providerOrder: string[] = [];

    seed(
        contributions: readonly SessionQuotaContribution[],
        latestQuotas: ReadonlyMap<string, ProviderQuota>,
    ): void {
        this.#windows.clear();
        this.#providerOrder = contributions.map((entry) => entry.providerId);
        for (const contribution of contributions) {
            const quota = latestQuotas.get(contribution.providerId);
            for (const windowName of ["fiveHour", "weekly"] as const) {
                const observed = contribution.windows[windowName];
                if (observed === undefined) continue;
                const window = quota?.windows[windowName];
                const available = window?.status === "available" ? window : undefined;
                this.#windows.set(windowKey(contribution.providerId, windowName), {
                    baselineUsedPercent: available?.usedPercent ?? 0,
                    completedUsedPercent: observed.observedUsedPercent,
                    epochKey:
                        available === undefined
                            ? ""
                            : JSON.stringify([available.resetsAt, available.durationMs ?? null]),
                    maximumUsedPercent: available?.usedPercent ?? 0,
                });
            }
        }
    }

    apply(event: SessionEvent): void {
        if (event.type === "session_reset") {
            this.#windows.clear();
            this.#providerOrder = [];
            return;
        }
        if (event.type !== "provider_quota_observed") return;
        if (!this.#providerOrder.includes(event.data.providerId)) {
            this.#providerOrder.push(event.data.providerId);
        }
        observeWindow(
            this.#windows,
            event.data.providerId,
            "fiveHour",
            event.data.quota.windows.fiveHour,
        );
        observeWindow(
            this.#windows,
            event.data.providerId,
            "weekly",
            event.data.quota.windows.weekly,
        );
    }

    snapshot(): SessionQuotaContribution[] {
        return this.#providerOrder.flatMap((providerId) => {
            const contribution: SessionQuotaContribution = { providerId, windows: {} };
            for (const window of ["fiveHour", "weekly"] as const) {
                const state = this.#windows.get(windowKey(providerId, window));
                if (state !== undefined) {
                    contribution.windows[window] = {
                        observedUsedPercent:
                            state.completedUsedPercent +
                            Math.max(0, state.maximumUsedPercent - state.baselineUsedPercent),
                    };
                }
            }
            return contribution.windows.fiveHour === undefined &&
                contribution.windows.weekly === undefined
                ? []
                : [contribution];
        });
    }
}

function observeWindow(
    windows: Map<string, WindowState>,
    providerId: string,
    windowName: "fiveHour" | "weekly",
    window: ProviderQuotaWindow | undefined,
): void {
    if (window?.status !== "available") return;
    const key = windowKey(providerId, windowName);
    const epochKey = JSON.stringify([window.resetsAt, window.durationMs ?? null]);
    const state = windows.get(key);
    if (state === undefined) {
        windows.set(key, {
            baselineUsedPercent: window.usedPercent,
            completedUsedPercent: 0,
            epochKey,
            maximumUsedPercent: window.usedPercent,
        });
        return;
    }
    if (state.epochKey !== epochKey) {
        state.completedUsedPercent += Math.max(
            0,
            state.maximumUsedPercent - state.baselineUsedPercent,
        );
        state.baselineUsedPercent = window.usedPercent;
        state.epochKey = epochKey;
        state.maximumUsedPercent = window.usedPercent;
        return;
    }
    state.maximumUsedPercent = Math.max(state.maximumUsedPercent, window.usedPercent);
}

function windowKey(providerId: string, window: "fiveHour" | "weekly"): string {
    return `${providerId}\0${window}`;
}
