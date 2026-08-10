import { describe, expect, it } from "vitest";

import { codexUpdatePlanTool } from "../../tools/codex/update_plan.js";
import { createJustBashToolHarness } from "../../../tools/testing/createJustBashToolHarness.js";
import { createTestRootContext } from "../../../testing/createTestRootContext.js";

const ctx = createTestRootContext();

describe("Codex update_plan tool", () => {
    it("accepts a valid plan and reports human-readable progress", async () => {
        const args = {
            explanation: "Finished the audit and started implementation.",
            plan: [
                { step: "Audit behavior", status: "completed" as const },
                { step: "Implement support", status: "in_progress" as const },
                { step: "Run tests", status: "pending" as const },
            ],
        };
        const harness = createJustBashToolHarness();

        const result = await codexUpdatePlanTool.execute(args, harness.context, { ctx });

        expect(result).toEqual({ text: "Plan updated" });
        expect(codexUpdatePlanTool.toLLM(result)).toEqual([{ type: "text", text: "Plan updated" }]);
        expect(codexUpdatePlanTool.toUI(result, args)).toBe(
            "Plan updated: 1 completed, 1 in progress, 1 pending",
        );
    });

    it("rejects plans with multiple active steps", async () => {
        const harness = createJustBashToolHarness();

        await expect(
            codexUpdatePlanTool.execute(
                {
                    plan: [
                        { step: "First task", status: "in_progress" },
                        { step: "Second task", status: "in_progress" },
                    ],
                },
                harness.context,
                { ctx },
            ),
        ).rejects.toThrow("at most one step in progress");
    });
});
