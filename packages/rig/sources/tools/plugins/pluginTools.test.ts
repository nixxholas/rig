import { describe, expect, it, vi } from "vitest";

import type { AgentContext } from "../../agent/context/AgentContext.js";
import type { PluginContext } from "../../agent/context/PluginContext.js";
import {
    pluginInstallTool,
    pluginListTool,
    pluginLogsTool,
    pluginUninstallTool,
} from "./pluginTools.js";

describe("plugin tools", () => {
    it("reviews every plugin action and elevates only the two that change the installation", () => {
        const context = {} as AgentContext;

        expect(pluginInstallTool.shouldReviewInAutoMode({ path: "./clock" }, context)).toBe(true);
        expect(
            pluginInstallTool.shouldRunInFullAccessInAutoMode({ path: "./clock" }, context),
        ).toBe(true);
        expect(pluginUninstallTool.shouldReviewInAutoMode({ name: "Clock" }, context)).toBe(true);
        expect(
            pluginUninstallTool.shouldRunInFullAccessInAutoMode({ name: "Clock" }, context),
        ).toBe(true);
        expect(pluginListTool.shouldReviewInAutoMode({}, context)).toBe(true);
        expect(pluginListTool.shouldRunInFullAccessInAutoMode({}, context)).toBe(false);
    });

    it("discloses the folder it reaches outside the workspace", () => {
        const context = createContext();

        const install = pluginInstallTool.describeAutoPermissionAction?.(
            { path: "clock" },
            context,
        );
        expect(install).toContain("/workspace/clock");
        expect(install).toContain("outside the workspace sandbox");
        expect(install).toContain("running it");

        const uninstall = pluginUninstallTool.describeAutoPermissionAction?.(
            { name: "Clock" },
            context,
        );
        expect(uninstall).toContain("stop the plugin");
        expect(uninstall).toContain("keeping the folder it writes to");
        expect(pluginListTool.describeAutoPermissionAction?.({}, context)).toContain(
            "outside the workspace sandbox",
        );
    });

    it("installs from a path the session resolves and uninstalls by name", async () => {
        const install = vi.fn(async () => ({
            description: "A small clock.",
            directory: "/home/steve/.happy/rig/plugins/clock",
            folder: "clock",
            name: "Clock",
        }));
        const uninstall = vi.fn(async () => ({
            dataDirectory: "/home/steve/Happy/Plugins/clock",
            folder: "clock",
            name: "Clock",
        }));
        const context = createContext({ install, uninstall });

        await expect(
            pluginInstallTool.execute({ path: "./clock" }, context, {}),
        ).resolves.toMatchObject({ name: "Clock" });
        expect(install).toHaveBeenCalledWith({
            fs: context.fs,
            sourceDirectory: "/workspace/clock",
        });

        await expect(
            pluginUninstallTool.execute({ name: "Clock" }, context, {}),
        ).resolves.toMatchObject({ dataDirectory: "/home/steve/Happy/Plugins/clock" });
        expect(uninstall).toHaveBeenCalledWith({ fs: context.fs, name: "Clock" });
    });

    it("reports which installed plugins are running", async () => {
        const context = createContext({
            list: async () => ({
                failures: [{ error: "happy.plugin.json is invalid.", folder: "broken" }],
                plugins: [
                    {
                        applications: [],
                        dataDirectory: "/home/steve/Happy/Plugins/clock",
                        description: "A small clock.",
                        directory: "/home/steve/.happy/rig/plugins/clock",
                        folder: "clock",
                        logAvailable: true,
                        name: "Clock",
                        status: "running",
                    },
                ],
                version: "01900000-0000-7000-8000-000000000001",
            }),
        });

        const result = await pluginListTool.execute({}, context, {});
        expect(result.plugins).toMatchObject([{ name: "Clock", status: "running" }]);
        expect(result.failures).toEqual([
            { error: "happy.plugin.json is invalid.", folder: "broken" },
        ]);
        expect(pluginListTool.toUI(result, {})).toBe("Found 1 installed plugin.");
    });

    it("reads bounded current logs through the plugin context", async () => {
        const context = createContext({
            readLog: async () => ({
                folder: "clock",
                name: "Clock",
                source: "current_run",
                status: "stopped",
                text: "[stdout] tick\n",
                truncated: false,
                updatedAt: 42,
            }),
        });

        await expect(pluginLogsTool.execute({ name: "Clock" }, context, {})).resolves.toMatchObject(
            { status: "stopped", text: "[stdout] tick\n" },
        );
    });

    it("says so when a session cannot manage plugins", async () => {
        const context = { fs: { cwd: "/workspace" } } as AgentContext;

        await expect(pluginListTool.execute({}, context, {})).rejects.toThrow(
            "Plugins are unavailable in this session.",
        );
    });
});

function createContext(plugins: Partial<PluginContext> = {}): AgentContext {
    return {
        fs: { cwd: "/workspace" },
        plugins: {
            install: async () => {
                throw new Error("unexpected install");
            },
            list: async () => ({ failures: [], plugins: [] }),
            readLog: async () => {
                throw new Error("unexpected log read");
            },
            uninstall: async () => {
                throw new Error("unexpected uninstall");
            },
            ...plugins,
        },
    } as AgentContext;
}
