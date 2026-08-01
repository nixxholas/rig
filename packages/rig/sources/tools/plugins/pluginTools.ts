import { Type } from "@sinclair/typebox";

import type { AgentContext } from "../../agent/context/AgentContext.js";
import type { PluginContext } from "../../agent/context/PluginContext.js";
import { resolveFileSystemPath } from "../../agent/context/resolveFileSystemPath.js";
import { defineTool } from "../../agent/types.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import { getPluginsDirectory } from "../../plugins/getPluginsDirectory.js";

/**
 * Plugins live in Rig's managed home rather than the workspace, so every plugin action reaches
 * outside the Auto sandbox and is reviewed before it runs.
 */
const OUTSIDE_WORKSPACE = "Access: unrestricted filesystem access outside the workspace sandbox";

export const pluginInstallTool = defineTool({
    name: "plugin_install",
    label: "Install plugin",
    description:
        "Install a plugin from a folder on this machine. Rig copies the sources into its managed plugins folder, compiles them, and starts the plugin right away; a plugin that fails to build is not installed.",
    arguments: Type.Object(
        {
            path: Type.String({
                description: "Path to the plugin folder containing happy.plugin.json.",
            }),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object({
        description: Type.String(),
        directory: Type.String(),
        folder: Type.String(),
        name: Type.String(),
    }),
    shouldReviewInAutoMode: () => true,
    shouldRunInFullAccessInAutoMode: () => true,
    describeAutoPermissionAction: ({ path }, context) =>
        `install the plugin at ${quoteVisibleExact(resolvePluginSource(path, context))} into ${quoteVisibleExact(getPluginsDirectory())}, compiling its TypeScript and running it. ${OUTSIDE_WORKSPACE}`,
    execute: ({ path }, context) =>
        requirePlugins(context).install({
            fs: context.fs,
            sourceDirectory: resolvePluginSource(path, context),
        }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Installed and started the ${result.name} plugin.`,
    locks: ["plugins"],
});

export const pluginUninstallTool = defineTool({
    name: "plugin_uninstall",
    label: "Uninstall plugin",
    description:
        "Uninstall a plugin by its name. Rig stops it, removes the installed code, and keeps everything the plugin wrote in its own folder.",
    arguments: Type.Object(
        { name: Type.String({ description: "Installed plugin name or folder name." }) },
        { additionalProperties: false },
    ),
    returnType: Type.Object({
        dataDirectory: Type.String(),
        folder: Type.String(),
        name: Type.String(),
    }),
    shouldReviewInAutoMode: () => true,
    shouldRunInFullAccessInAutoMode: () => true,
    describeAutoPermissionAction: ({ name }) =>
        `stop the plugin ${quoteVisibleExact(name)} and delete its installed code under ${quoteVisibleExact(getPluginsDirectory())}, keeping the folder it writes to. ${OUTSIDE_WORKSPACE}`,
    execute: ({ name }, context) => requirePlugins(context).uninstall({ fs: context.fs, name }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Uninstalled the ${result.name} plugin and kept its data.`,
    locks: ["plugins"],
});

export const pluginListTool = defineTool({
    name: "plugin_list",
    label: "List plugins",
    description:
        "List the plugins installed on this machine, showing which are running, the folder each one writes to, and any that failed to register.",
    arguments: Type.Object({}, { additionalProperties: false }),
    returnType: Type.Object({
        failures: Type.Array(Type.Object({ error: Type.String(), folder: Type.String() })),
        plugins: Type.Array(
            Type.Object({
                dataDirectory: Type.String(),
                description: Type.String(),
                directory: Type.String(),
                error: Type.Optional(Type.String()),
                folder: Type.String(),
                logAvailable: Type.Boolean(),
                name: Type.String(),
                status: Type.Union([
                    Type.Literal("build_failed"),
                    Type.Literal("running"),
                    Type.Literal("stopped"),
                ]),
            }),
        ),
    }),
    shouldReviewInAutoMode: () => true,
    describeAutoPermissionAction: () =>
        `list the plugins installed under ${quoteVisibleExact(getPluginsDirectory())}. ${OUTSIDE_WORKSPACE}`,
    execute: async (_args, context) => {
        const { failures, plugins } = await requirePlugins(context).list();
        return {
            failures: failures.map((failure) => ({ ...failure })),
            plugins: plugins.map((plugin) => ({ ...plugin })),
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        result.plugins.length === 0
            ? "No plugins are installed."
            : `Found ${String(result.plugins.length)} installed ${result.plugins.length === 1 ? "plugin" : "plugins"}.`,
    locks: [],
});

export const pluginLogsTool = defineTool({
    name: "plugin_logs",
    label: "Read plugin logs",
    description:
        "Read the bounded current log for one installed plugin, including whether it is running, stopped, or failed to build.",
    arguments: Type.Object(
        { name: Type.String({ description: "Installed plugin name or folder name." }) },
        { additionalProperties: false },
    ),
    returnType: Type.Object(
        {
            error: Type.Optional(Type.String()),
            folder: Type.String(),
            name: Type.String(),
            source: Type.Union([Type.Literal("build"), Type.Literal("current_run")]),
            status: Type.Union([
                Type.Literal("build_failed"),
                Type.Literal("running"),
                Type.Literal("stopped"),
            ]),
            text: Type.String(),
            truncated: Type.Boolean(),
            updatedAt: Type.Number(),
        },
        { additionalProperties: false },
    ),
    shouldReviewInAutoMode: () => true,
    describeAutoPermissionAction: ({ name }) =>
        `read the bounded current log for ${quoteVisibleExact(name)} under ${quoteVisibleExact(getPluginsDirectory())}. ${OUTSIDE_WORKSPACE}`,
    execute: ({ name }, context) => requirePlugins(context).readLog(name),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        `Read the ${result.status === "build_failed" ? "build diagnostics" : "current log"} for ${result.name}.`,
    locks: [],
});

export const pluginTools = [pluginInstallTool, pluginUninstallTool, pluginListTool, pluginLogsTool];

function requirePlugins(context: AgentContext): PluginContext {
    if (context.plugins === undefined) {
        throw new Error("Plugins are unavailable in this session.");
    }
    return context.plugins;
}

function resolvePluginSource(path: string, context: AgentContext): string {
    try {
        return resolveFileSystemPath(path, context.fs.cwd, context.fs.home);
    } catch {
        // Preserve malformed input so the reviewed action still shows the proposed path.
        return path;
    }
}
