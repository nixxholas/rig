import { join } from "node:path";

import { Type } from "@sinclair/typebox";

import type { AgentContext } from "../../agent/context/AgentContext.js";
import { resolveFileSystemPath } from "../../agent/context/resolveFileSystemPath.js";
import { defineTool } from "../../agent/types.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import { discoverPlugins } from "../../plugins/discoverPlugins.js";
import { getPluginDataDirectory } from "../../plugins/getPluginDataDirectory.js";
import { getPluginsDirectory } from "../../plugins/getPluginsDirectory.js";
import { installPluginFromPath } from "./installPluginFromPath.js";

const installedPluginSchema = Type.Object({
    description: Type.String(),
    directory: Type.String(),
    folder: Type.String(),
    name: Type.String(),
});

/**
 * Plugins live in Rig's managed home rather than the workspace, so every plugin action reaches
 * outside the Auto sandbox and is reviewed before it runs.
 */
const OUTSIDE_WORKSPACE = "Access: unrestricted filesystem access outside the workspace sandbox";

export const pluginInstallTool = defineTool({
    name: "plugin_install",
    label: "Install plugin",
    description:
        "Install a plugin from a folder on this machine. Rig copies the sources into its managed plugins folder and compiles them; a plugin that fails to build is not installed. Restart the daemon to start a newly installed plugin.",
    arguments: Type.Object(
        {
            path: Type.String({
                description: "Path to the plugin folder containing happy.plugin.json.",
            }),
        },
        { additionalProperties: false },
    ),
    returnType: installedPluginSchema,
    shouldReviewInAutoMode: () => true,
    shouldRunInFullAccessInAutoMode: () => true,
    describeAutoPermissionAction: ({ path }, context) =>
        `install the plugin at ${quoteVisibleExact(resolvePluginSource(path, context))} into ${quoteVisibleExact(getPluginsDirectory())}, compiling its TypeScript. ${OUTSIDE_WORKSPACE}`,
    execute: ({ path }, context) =>
        installPluginFromPath({
            fs: context.fs,
            pluginsDirectory: getPluginsDirectory(),
            sourceDirectory: resolvePluginSource(path, context),
        }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Installed the ${result.name} plugin. Restart Rig to start it.`,
    locks: ["plugins"],
});

export const pluginUninstallTool = defineTool({
    name: "plugin_uninstall",
    label: "Uninstall plugin",
    description:
        "Uninstall a plugin by its name. Rig removes the installed code and keeps everything the plugin wrote in its own folder.",
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
        `uninstall the plugin ${quoteVisibleExact(name)}, deleting its installed code under ${quoteVisibleExact(getPluginsDirectory())} while keeping the folder it writes to. ${OUTSIDE_WORKSPACE}`,
    execute: async ({ name }, context) => {
        const pluginsDirectory = getPluginsDirectory();
        const discovery = await discoverPlugins(pluginsDirectory);
        const wanted = name.trim().toLowerCase();
        const installed = discovery.plugins.find(
            (plugin) =>
                plugin.manifest.name.toLowerCase() === wanted ||
                plugin.folderName.toLowerCase() === wanted,
        );
        if (installed === undefined) {
            const known = discovery.plugins.map((plugin) => plugin.manifest.name);
            throw new Error(
                known.length === 0
                    ? `No plugin named ${name} is installed. No plugins are installed.`
                    : `No plugin named ${name} is installed. Installed plugins: ${known.join(", ")}.`,
            );
        }
        await context.fs.rm(join(pluginsDirectory, installed.folderName), {
            force: true,
            recursive: true,
        });
        return {
            dataDirectory: getPluginDataDirectory(installed.folderName),
            folder: installed.folderName,
            name: installed.manifest.name,
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Uninstalled the ${result.name} plugin and kept its data.`,
    locks: ["plugins"],
});

export const pluginListTool = defineTool({
    name: "plugin_list",
    label: "List plugins",
    description:
        "List the plugins installed on this machine, along with the folder each one writes to and any that failed to register.",
    arguments: Type.Object({}, { additionalProperties: false }),
    returnType: Type.Object({
        failures: Type.Array(Type.Object({ error: Type.String(), folder: Type.String() })),
        plugins: Type.Array(
            Type.Object({
                dataDirectory: Type.String(),
                description: Type.String(),
                folder: Type.String(),
                name: Type.String(),
            }),
        ),
    }),
    shouldReviewInAutoMode: () => true,
    describeAutoPermissionAction: () =>
        `list the plugins installed under ${quoteVisibleExact(getPluginsDirectory())}. ${OUTSIDE_WORKSPACE}`,
    execute: async () => {
        const discovery = await discoverPlugins(getPluginsDirectory());
        return {
            failures: discovery.failures.map((failure) => ({
                error: failure.error,
                folder: failure.folderName,
            })),
            plugins: discovery.plugins.map((plugin) => ({
                dataDirectory: getPluginDataDirectory(plugin.folderName),
                description: plugin.manifest.description,
                folder: plugin.folderName,
                name: plugin.manifest.name,
            })),
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        result.plugins.length === 0
            ? "No plugins are installed."
            : `Found ${String(result.plugins.length)} installed ${result.plugins.length === 1 ? "plugin" : "plugins"}.`,
    locks: [],
});

export const pluginTools = [pluginInstallTool, pluginUninstallTool, pluginListTool];

function resolvePluginSource(path: string, context: AgentContext): string {
    try {
        return resolveFileSystemPath(path, context.fs.cwd, context.fs.home);
    } catch {
        // Preserve malformed input so the reviewed action still shows the proposed path.
        return path;
    }
}
