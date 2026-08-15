import { Type } from "@sinclair/typebox";

import type { AgentContext } from "../../agent/context/AgentContext.js";
import type { PluginContext } from "../../agent/context/PluginContext.js";
import { resolveFileSystemPath } from "../../agent/context/resolveFileSystemPath.js";
import { defineTool } from "../../agent/types.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import { getPluginsDirectory } from "../../plugins/getPluginsDirectory.js";
import {
    githubGitRefSchema,
    githubPluginCatalogEntrySchema,
    githubPluginNameSchema,
    githubPluginSourceSchema,
    githubRepositorySchema,
} from "../../plugins/githubPluginCatalog.js";
import { pluginVersionSchema } from "../../plugins/types.js";
import { pluginInstallClassificationSchema } from "../../protocol/index.js";

/**
 * Plugins live in Rig's managed home rather than the workspace, so every plugin action reaches
 * outside the Auto sandbox and is reviewed before it runs.
 */
const OUTSIDE_WORKSPACE = "Access: unrestricted filesystem access outside the workspace sandbox";
const GITHUB_ACCESS = "Access: reads public repository data from GitHub";

export const pluginDiscoverTool = defineTool({
    name: "plugin_discover",
    label: "Discover GitHub plugins",
    description:
        "List the plugins offered by a GitHub repository whose root contains happy-plugins.json. The repository must be written as owner/repo; omit ref to use its default branch.",
    arguments: githubPluginSourceSchema,
    returnType: Type.Object(
        {
            plugins: Type.Array(githubPluginCatalogEntrySchema),
            ref: Type.Optional(Type.String()),
            repository: Type.String(),
        },
        { additionalProperties: false },
    ),
    requiresAutoOrFullAccess: true,
    shouldReviewInAutoMode: () => true,
    describeAutoPermissionAction: ({ repository, ref }) =>
        `read the plugin catalog from ${quoteVisibleExact(repository)} on GitHub at ${quoteVisibleExact(ref ?? "the default branch")}. ${GITHUB_ACCESS}`,
    execute: async ({ repository, ref }, context, execution) => {
        const catalog = await requirePlugins(context).discoverRepository(
            execution.ctx,
            {
                ...(ref === undefined ? {} : { ref }),
                repository,
            },
            execution.signal,
        );
        return {
            plugins: catalog.plugins.map((plugin) => plugin.source.plugin),
            ...(ref === undefined ? {} : { ref }),
            repository,
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        result.plugins.length === 0
            ? `No plugins are listed by ${result.repository}.`
            : `Found ${String(result.plugins.length)} ${result.plugins.length === 1 ? "plugin" : "plugins"} in ${result.repository}.`,
    locks: [],
});

export const pluginInstallTool = defineTool({
    name: "plugin_install",
    label: "Install plugin",
    description:
        "Install a prebuilt plugin from a folder on this machine or from a plugin listed by a GitHub repository. Rig copies and validates the plugin folder, then starts its declared JavaScript or TypeScript entry point right away. Plugin code must register every contribution before calling happy.ready(...) within the startup window.",
    arguments: Type.Object(
        {
            path: Type.Optional(
                Type.String({
                    description: "Path to the plugin folder containing happy.plugin.json.",
                }),
            ),
            plugin: Type.Optional(githubPluginNameSchema),
            ref: Type.Optional(githubGitRefSchema),
            repository: Type.Optional(githubRepositorySchema),
        },
        {
            additionalProperties: false,
            description:
                "Provide either a local path or a GitHub repository, indexed plugin name, and optional ref.",
        },
    ),
    returnType: Type.Object({
        classification: pluginInstallClassificationSchema,
        description: Type.String(),
        directory: Type.String(),
        folder: Type.String(),
        name: Type.String(),
        version: pluginVersionSchema,
    }),
    requiresAutoOrFullAccess: true,
    shouldReviewInAutoMode: () => true,
    shouldRunInFullAccessInAutoMode: () => true,
    describeAutoPermissionAction: (source, context) => {
        if (
            source.path !== undefined &&
            source.repository === undefined &&
            source.plugin === undefined &&
            source.ref === undefined
        ) {
            return `install the prebuilt plugin at ${quoteVisibleExact(resolvePluginSource(source.path, context))} into ${quoteVisibleExact(getPluginsDirectory())}, validating and running it. ${OUTSIDE_WORKSPACE}`;
        }
        if (
            source.path === undefined &&
            source.repository !== undefined &&
            source.plugin !== undefined
        ) {
            return `download the indexed prebuilt plugin ${quoteVisibleExact(source.plugin)} from ${quoteVisibleExact(source.repository)} on GitHub at ${quoteVisibleExact(source.ref ?? "the default branch")}, install it into ${quoteVisibleExact(getPluginsDirectory())}, validating and running it. ${GITHUB_ACCESS}. ${OUTSIDE_WORKSPACE}`;
        }
        return `attempt to install a plugin from an invalid source into ${quoteVisibleExact(getPluginsDirectory())}. ${GITHUB_ACCESS}. ${OUTSIDE_WORKSPACE}`;
    },
    execute: async (source, context, execution) => {
        if (source.path !== undefined) {
            if (
                source.repository !== undefined ||
                source.plugin !== undefined ||
                source.ref !== undefined
            ) {
                throw new Error(
                    "Provide either a local plugin path or a GitHub repository and plugin name, but not both.",
                );
            }
            return requirePlugins(context).install(execution.ctx, {
                fs: context.fs,
                ...(execution.signal === undefined ? {} : { signal: execution.signal }),
                sourceDirectory: resolvePluginSource(source.path, context),
            });
        }
        if (source.repository === undefined || source.plugin === undefined) {
            throw new Error(
                "Provide either a local plugin path or a GitHub repository and plugin name.",
            );
        }
        return requirePlugins(context).installFromGitHub(
            execution.ctx,
            {
                plugin: source.plugin,
                ...(source.ref === undefined ? {} : { ref: source.ref }),
                repository: source.repository,
            },
            {
                fs: context.fs,
                ...(execution.signal === undefined ? {} : { signal: execution.signal }),
            },
        );
    },
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
    execute: ({ name }, context, execution) =>
        requirePlugins(context).uninstall(execution.ctx, { fs: context.fs, name }),
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
                    Type.Literal("failed"),
                    Type.Literal("running"),
                    Type.Literal("stopped"),
                ]),
                statusMessage: Type.Optional(Type.String()),
                version: pluginVersionSchema,
            }),
        ),
    }),
    shouldReviewInAutoMode: () => true,
    describeAutoPermissionAction: () =>
        `list the plugins installed under ${quoteVisibleExact(getPluginsDirectory())}. ${OUTSIDE_WORKSPACE}`,
    execute: async (_args, context, execution) => {
        const { failures, plugins } = await requirePlugins(context).list(execution.ctx);
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
        "Read the bounded current log or startup diagnostic for one installed plugin, including whether it is running, stopped, or failed.",
    arguments: Type.Object(
        { name: Type.String({ description: "Installed plugin name or folder name." }) },
        { additionalProperties: false },
    ),
    returnType: Type.Object(
        {
            error: Type.Optional(Type.String()),
            folder: Type.String(),
            name: Type.String(),
            source: Type.Union([Type.Literal("current_run"), Type.Literal("error")]),
            status: Type.Union([
                Type.Literal("failed"),
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
    execute: ({ name }, context, execution) => requirePlugins(context).readLog(execution.ctx, name),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        `Read the ${result.status === "failed" ? "startup diagnostic" : "current log"} for ${result.name}.`,
    locks: [],
});

export const pluginTools = [
    pluginDiscoverTool,
    pluginInstallTool,
    pluginUninstallTool,
    pluginListTool,
    pluginLogsTool,
];

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
