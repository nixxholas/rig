import { describe, expect, it } from "vitest";

import {
    AutoPermissionDenialCircuitBreaker,
    AUTO_PERMISSION_DENIAL_WINDOW,
    MAX_CONSECUTIVE_AUTO_PERMISSION_DENIALS,
    MAX_RECENT_AUTO_PERMISSION_DENIALS,
} from "./AutoPermissionDenialCircuitBreaker.js";

describe("AutoPermissionDenialCircuitBreaker", () => {
    it("stops the turn after a run of refusals with nothing working in between", () => {
        const breaker = new AutoPermissionDenialCircuitBreaker();
        const stops = Array.from({ length: MAX_CONSECUTIVE_AUTO_PERMISSION_DENIALS }, () =>
            breaker.recordDenial(),
        );

        expect(stops.slice(0, -1)).not.toContain(true);
        expect(stops.at(-1)).toBe(true);
    });

    it("treats one allowed action as evidence the agent is no longer stuck", () => {
        const breaker = new AutoPermissionDenialCircuitBreaker();
        for (let index = 0; index < MAX_CONSECUTIVE_AUTO_PERMISSION_DENIALS - 1; index += 1) {
            breaker.recordDenial();
        }
        breaker.recordAllowed();

        expect(breaker.recordDenial()).toBe(false);
    });

    it("still stops a turn that keeps being refused between successes", () => {
        const breaker = new AutoPermissionDenialCircuitBreaker();
        let stopped = false;
        // Alternating keeps the consecutive count clear forever, so only the rate limit can end
        // this turn.
        for (
            let index = 0;
            index < MAX_RECENT_AUTO_PERMISSION_DENIALS * 2 && !stopped;
            index += 1
        ) {
            stopped = breaker.recordDenial();
            if (!stopped) breaker.recordAllowed();
        }

        expect(stopped).toBe(true);
    });

    it("stops the turn only once, so a winding-down turn does not raise repeated stops", () => {
        const breaker = new AutoPermissionDenialCircuitBreaker();
        while (!breaker.recordDenial()) {
            // Refuse until the breaker trips.
        }

        expect(breaker.recordDenial()).toBe(false);
    });

    it("forgets refusals that fall outside the window", () => {
        const breaker = new AutoPermissionDenialCircuitBreaker();
        for (let index = 0; index < MAX_RECENT_AUTO_PERMISSION_DENIALS - 1; index += 1) {
            breaker.recordDenial();
            breaker.recordAllowed();
        }
        for (let index = 0; index < AUTO_PERMISSION_DENIAL_WINDOW; index += 1) {
            breaker.recordAllowed();
        }

        expect(breaker.recordDenial()).toBe(false);
    });

    it("explains the stop in terms a person can act on", () => {
        const breaker = new AutoPermissionDenialCircuitBreaker();
        while (!breaker.recordDenial()) {
            // Refuse until the breaker trips.
        }

        expect(breaker.describeStop()).toContain("refused too many actions in this turn");
        expect(breaker.describeStop()).toContain("Tell the user");
    });
});
