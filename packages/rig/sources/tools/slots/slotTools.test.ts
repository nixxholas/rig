import { describe, expect, it } from "vitest";

import type { AgentContext } from "../../agent/context/AgentContext.js";
import { slotCreateTool } from "./slot_create.js";
import { slotRemoveTool } from "./slot_remove.js";
import { slotUpdateTool } from "./slot_update.js";

describe("slot tools", () => {
    it("describes every slot mutation that requires Auto review", () => {
        const context = {} as AgentContext;
        const createArgs = {
            slot: "status-line",
            scope: "session",
            sessionId: "session-1",
            content: { type: "text", markdown: "Ready" },
            description: "Session status",
            purpose: "Show the current status",
        } as const;
        const updateArgs = { id: "entry-1", description: "Updated status" };
        const removeArgs = { id: "entry-1" };

        expect(slotCreateTool.shouldReviewInAutoMode(createArgs, context)).toBe(true);
        expect(slotCreateTool.describeAutoPermissionAction?.(createArgs, context)).toContain(
            'status line slot for session "session-1"',
        );
        expect(slotUpdateTool.shouldReviewInAutoMode(updateArgs, context)).toBe(true);
        expect(slotUpdateTool.describeAutoPermissionAction?.(updateArgs, context)).toContain(
            'update Happy UI slot entry "entry-1"',
        );
        expect(slotRemoveTool.shouldReviewInAutoMode(removeArgs, context)).toBe(true);
        expect(slotRemoveTool.describeAutoPermissionAction?.(removeArgs, context)).toBe(
            'remove Happy UI slot entry "entry-1"',
        );
    });

    it("discloses an open-webapp button's destination path and query", () => {
        const context = {} as AgentContext;
        const args = {
            slot: "sidebar",
            scope: "everywhere",
            content: {
                action: {
                    path: "reports/today.html",
                    query: { theme: "dark", view: "compact" },
                    type: "open-webapp",
                    webapp: "build-dashboard",
                },
                label: "View build",
                type: "button",
            },
            description: "Build dashboard shortcut",
            purpose: "Open the current build report",
        } as const;

        expect(slotCreateTool.describeAutoPermissionAction?.(args, context)).toContain(
            'open the webapp "build-dashboard" at path "reports/today.html" with query parameters "theme" set to "dark", "view" set to "compact"',
        );
    });
});
