import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";

import type { AgentContext } from "../../agent/context/AgentContext.js";
import { createJustBashToolHarness } from "../testing/createJustBashToolHarness.js";
import { webappCreateTool } from "./webapp_create.js";
import { webappRevertTool } from "./webapp_revert.js";
import { webappUpdateTool } from "./webapp_update.js";

describe("webapp tools", () => {
    it("requires and discloses the 512x512 icon source when creating a webapp", () => {
        const context = {} as AgentContext;
        const args = {
            description: "Usage dashboard",
            iconPath: "/workspace/icon.png",
            name: "usage-dashboard",
            path: "/workspace/dist",
            purpose: "Track spend",
        };

        expect(Value.Check(webappCreateTool.arguments, args)).toBe(true);
        expect(Value.Check(webappCreateTool.arguments, { ...args, iconPath: undefined })).toBe(
            false,
        );
        const action = webappCreateTool.describeAutoPermissionAction?.(args, context);
        expect(action).toContain('folder "/workspace/dist"');
        expect(action).toContain('icon "/workspace/icon.png"');
        expect(webappCreateTool.requiresAutoOrFullAccess).toBe(true);
        expect(webappCreateTool.shouldRunInFullAccessInAutoMode(args, context)).toBe(true);
    });

    it("describes reverting a webapp when requesting Auto review", () => {
        const context = {} as AgentContext;

        expect(
            webappRevertTool.shouldReviewInAutoMode({ name: "dashboard", version: 2 }, context),
        ).toBe(true);
        expect(webappRevertTool.requiresAutoOrFullAccess).toBe(true);
        expect(
            webappRevertTool.shouldRunInFullAccessInAutoMode(
                { name: "dashboard", version: 2 },
                context,
            ),
        ).toBe(true);
        expect(
            webappRevertTool.describeAutoPermissionAction?.(
                { name: "dashboard", version: 2 },
                context,
            ),
        ).toContain("version v2");
    });

    it("elevates reviewed webapp version imports", () => {
        const context = {} as AgentContext;
        const args = {
            changeDescription: "Add filters",
            name: "dashboard",
            path: "/workspace/dist",
        };

        expect(webappUpdateTool.requiresAutoOrFullAccess).toBe(true);
        expect(webappUpdateTool.shouldReviewInAutoMode(args, context)).toBe(true);
        expect(webappUpdateTool.shouldRunInFullAccessInAutoMode(args, context)).toBe(true);
    });

    it("rejects webapp sources outside the active sharing boundary", async () => {
        const harness = createJustBashToolHarness({
            files: {
                "/private/dist/index.html": "private",
                "/private/icon.png": "private",
            },
        });

        await expect(
            webappCreateTool.execute(
                {
                    description: "Private dashboard",
                    iconPath: "/private/icon.png",
                    name: "private-dashboard",
                    path: "/private/dist",
                    purpose: "Must not leak",
                },
                harness.context,
                {},
            ),
        ).rejects.toThrow("must be inside the active workspace or Rig-generated media directory");
    });
});
