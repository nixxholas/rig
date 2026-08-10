import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";

import type { AgentContext } from "../../agent/context/AgentContext.js";
import { createJustBashToolHarness } from "../testing/createJustBashToolHarness.js";
import { appletCreateTool } from "./applet_create.js";
import { appletRevertTool } from "./applet_revert.js";
import { appletUpdateTool } from "./applet_update.js";

describe("applet tools", () => {
    it("requires and discloses the 512x512 icon source when creating an applet", () => {
        const context = {} as AgentContext;
        const args = {
            description: "Usage dashboard",
            iconPath: "/workspace/icon.png",
            name: "usage-dashboard",
            path: "/workspace/dist",
            purpose: "Track spend",
        };

        expect(Value.Check(appletCreateTool.arguments, args)).toBe(true);
        expect(Value.Check(appletCreateTool.arguments, { ...args, allowedScopes: [] })).toBe(false);
        expect(Value.Check(appletCreateTool.arguments, { ...args, iconPath: undefined })).toBe(
            false,
        );
        const action = appletCreateTool.describeAutoPermissionAction?.(args, context);
        expect(action).toContain('folder "/workspace/dist"');
        expect(action).toContain('icon "/workspace/icon.png"');
        expect(appletCreateTool.requiresAutoOrFullAccess).toBe(true);
        expect(appletCreateTool.shouldRunInFullAccessInAutoMode(args, context)).toBe(true);
    });

    it("describes reverting an applet when requesting Auto review", () => {
        const context = {} as AgentContext;

        expect(
            appletRevertTool.shouldReviewInAutoMode({ name: "dashboard", version: 2 }, context),
        ).toBe(true);
        expect(appletRevertTool.requiresAutoOrFullAccess).toBe(true);
        expect(
            appletRevertTool.shouldRunInFullAccessInAutoMode(
                { name: "dashboard", version: 2 },
                context,
            ),
        ).toBe(true);
        expect(
            appletRevertTool.describeAutoPermissionAction?.(
                { name: "dashboard", version: 2 },
                context,
            ),
        ).toContain("version v2");
    });

    it("elevates reviewed applet version imports", () => {
        const context = {} as AgentContext;
        const args = {
            changeDescription: "Add filters",
            name: "dashboard",
            path: "/workspace/dist",
        };

        expect(appletUpdateTool.requiresAutoOrFullAccess).toBe(true);
        expect(appletUpdateTool.shouldReviewInAutoMode(args, context)).toBe(true);
        expect(appletUpdateTool.shouldRunInFullAccessInAutoMode(args, context)).toBe(true);
    });

    it("rejects applet sources outside the active sharing boundary", async () => {
        const harness = createJustBashToolHarness({
            files: {
                "/private/dist/index.html": "private",
                "/private/icon.png": "private",
            },
        });

        await expect(
            appletCreateTool.execute(
                {
                    description: "Private dashboard",
                    iconPath: "/private/icon.png",
                    name: "private-dashboard",
                    path: "/private/dist",
                    purpose: "Must not leak",
                },
                harness.context,
                { ctx: harness.ctx },
            ),
        ).rejects.toThrow("must be inside the active workspace or Rig-generated media directory");
    });
});
