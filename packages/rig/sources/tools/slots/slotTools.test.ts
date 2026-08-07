import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";

import type { AgentContext } from "../../agent/context/AgentContext.js";
import { slotActionSchema } from "../../protocol/SlotProtocol.js";
import { slotCreateTool } from "./slot_create.js";
import { slotRemoveTool } from "./slot_remove.js";
import { slotUpdateTool } from "./slot_update.js";

describe("slot tools", () => {
    it("teaches models the allowed scopes for each slot", () => {
        const matrix =
            "Allowed scopes by slot: sidebar — everywhere; title — project or workspace; status line — everywhere, project, workspace, or session; above composer — everywhere, project, workspace, or session.";

        expect(slotCreateTool.description).toContain(matrix);
        expect(slotUpdateTool.description).toContain(matrix);
    });

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

    it("discloses an open-applet button's destination path and query", () => {
        const context = {} as AgentContext;
        const args = {
            slot: "sidebar",
            scope: "everywhere",
            content: {
                action: {
                    path: "reports/today.html",
                    query: { theme: "dark", view: "compact" },
                    type: "open-applet",
                    applet: "build-dashboard",
                },
                label: "View build",
                type: "button",
            },
            description: "Build dashboard shortcut",
            purpose: "Open the current build report",
        } as const;

        expect(slotCreateTool.describeAutoPermissionAction?.(args, context)).toContain(
            'open the applet "build-dashboard" at path "reports/today.html" with query parameters "theme" set to "dark", "view" set to "compact"',
        );
    });

    it("accepts complete new-chat selection and permission parameters", () => {
        const action = {
            effort: "high",
            model: "openai/gpt-5.6-sol",
            projectId: "project-1",
            prompt: "Inspect the failing build.",
            provider: "codex-work",
            readOnly: true,
            serviceTier: "fast",
            title: "Build investigation",
            type: "new-chat",
            workspaceId: "workspace-1",
        } as const;

        expect(Value.Check(slotActionSchema, action)).toBe(true);
        expect(
            Value.Check(slotActionSchema, {
                ...action,
                serviceTier: "turbo",
            }),
        ).toBe(false);

        const args = {
            content: {
                action,
                label: "Investigate",
                type: "button",
            },
            description: "Build investigation shortcut",
            purpose: "Start a correctly configured investigation chat",
            scope: "everywhere",
            slot: "sidebar",
        } as const;
        const description = slotCreateTool.describeAutoPermissionAction?.(args, {} as AgentContext);
        expect(description).toContain('using provider "codex-work"');
        expect(description).toContain("with priority service");
        expect(description).toContain("in Read only");
        expect(description).toContain('titled "Build investigation"');
    });
});
