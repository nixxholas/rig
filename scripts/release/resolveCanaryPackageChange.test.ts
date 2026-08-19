import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseCanaryCommit, resolveCanaryPackageChange } from "./resolveCanaryPackageChange.js";

describe("parseCanaryCommit", () => {
    it("extracts the commit suffix from a published canary version", () => {
        assert.equal(parseCanaryCommit("0.0.0-canary.812.abcdef0"), "abcdef0");
    });

    it("rejects missing and malformed canary versions", () => {
        assert.equal(parseCanaryCommit(undefined), undefined);
        assert.equal(parseCanaryCommit("0.0.0-canary.latest.abcdef0"), undefined);
        assert.equal(parseCanaryCommit("1.2.3"), undefined);
    });
});

describe("resolveCanaryPackageChange", () => {
    it("skips a package unchanged since its prior successful canary", () => {
        const decision = resolveCanaryPackageChange({
            fallbackBase: "current-push-base",
            packagePath: "packages/happy-plugins",
            publishedVersion: "0.0.0-canary.40.1111111",
            resolveCommit: (reference) =>
                reference === "1111111" ? "1111111111111111111111111111111111111111" : undefined,
            hasChanges: () => false,
        });

        assert.deepEqual(decision, {
            base: "1111111111111111111111111111111111111111",
            changed: false,
            publishedCommit: "1111111111111111111111111111111111111111",
            publishedVersion: "0.0.0-canary.40.1111111",
        });
    });

    it("publishes pending changes left behind by a failed canary workflow", () => {
        const bases: string[] = [];
        const decision = resolveCanaryPackageChange({
            fallbackBase: "failed-push",
            packagePath: "packages/happy-providers",
            publishedVersion: "0.0.0-canary.39.2222222",
            resolveCommit: () => "published-before-failed-push",
            hasChanges: (base) => {
                bases.push(base);
                return base === "published-before-failed-push";
            },
        });

        assert.equal(decision.changed, true);
        assert.deepEqual(bases, ["published-before-failed-push"]);
    });

    it("still finds pending package changes after an unrelated current push", () => {
        const decision = resolveCanaryPackageChange({
            fallbackBase: "failed-package-change",
            packagePath: "packages/happy-plugins",
            publishedVersion: "0.0.0-canary.38.3333333",
            resolveCommit: () => "last-successful-canary",
            hasChanges: (base) => base === "last-successful-canary",
        });

        assert.equal(decision.base, "last-successful-canary");
        assert.equal(decision.changed, true);
    });

    it("falls back to the current push for a missing or malformed tag", () => {
        for (const publishedVersion of [undefined, "not-a-canary"]) {
            const decision = resolveCanaryPackageChange({
                fallbackBase: "current-push-base",
                packagePath: "packages/happy-plugins",
                publishedVersion,
                resolveCommit: () => {
                    throw new Error("Malformed tags must not be resolved.");
                },
                hasChanges: (base) => base === "current-push-base",
            });

            assert.equal(decision.base, "current-push-base");
            assert.equal(decision.changed, true);
            assert.equal(decision.publishedCommit, undefined);
        }
    });

    it("does not publish an unrelated push when the canary watermark is unavailable", () => {
        const decision = resolveCanaryPackageChange({
            fallbackBase: "current-push-base",
            packagePath: "packages/happy-plugins",
            publishedVersion: undefined,
            resolveCommit: () => undefined,
            hasChanges: () => false,
        });

        assert.equal(decision.base, "current-push-base");
        assert.equal(decision.changed, false);
    });

    it("falls back to the current push when the published commit cannot be resolved", () => {
        const decision = resolveCanaryPackageChange({
            fallbackBase: "current-push-base",
            packagePath: "packages/happy-providers",
            publishedVersion: "0.0.0-canary.37.4444444",
            resolveCommit: () => undefined,
            hasChanges: (base) => base === "current-push-base",
        });

        assert.equal(decision.base, "current-push-base");
        assert.equal(decision.changed, true);
        assert.equal(decision.publishedCommit, undefined);
    });
});
