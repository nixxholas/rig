import { describe, expect, it } from "vitest";

import { renderTurnCompletionSeparator } from "./renderTurnCompletionSeparator.js";
import { stripAnsi } from "./testing/stripAnsi.js";

describe("renderTurnCompletionSeparator", () => {
    it("renders elapsed work as one width-bounded history row", () => {
        const rendered = stripAnsi(renderTurnCompletionSeparator(65_000, 40));
        expect(rendered).toContain("Worked for 1m 5s");
        expect(rendered).toHaveLength(40);
        expect(stripAnsi(renderTurnCompletionSeparator(0, 12))).toBe("────────────");
        expect(stripAnsi(renderTurnCompletionSeparator(60_000, 12))).toBe("────────────");
        expect(stripAnsi(renderTurnCompletionSeparator(3_723_000, 24))).toHaveLength(24);
    });

    it("shows the turn usage summary even for short turns", () => {
        const rendered = stripAnsi(
            renderTurnCompletionSeparator(12_000, 60, "3.1k generated · 50% cache hit"),
        );
        expect(rendered).toContain("Worked for 12s · 3.1k generated · 50% cache hit");
        expect(rendered).toHaveLength(60);
    });
});
