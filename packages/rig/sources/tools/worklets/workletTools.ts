import { Type } from "@sinclair/typebox";

import type { AgentContext } from "../../agent/context/AgentContext.js";
import type { WorkletContext } from "../../agent/context/WorkletContext.js";
import { defineTool } from "../../agent/types.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import {
    workletPermissionsSchema,
    workletSchema,
    type Worklet,
} from "../../protocol/WorkletProtocol.js";
import { getWorkletsDirectory } from "../../worklets/getWorkletsDirectory.js";
import { describeWorkletPermissions } from "../../worklets/describeWorkletPermissions.js";
import { assertShareableLocalPath } from "../attachments/assertShareableLocalPath.js";

/**
 * A worklet is code Rig runs in the background outside the workspace sandbox, so every change to
 * the installed set is reviewed before it happens.
 */
const OUTSIDE_WORKSPACE =
    "Access: reads the source folder and icon, then copies files outside the workspace sandbox and runs the worklet in the background";

export const workletInstallTool = defineTool({
    name: "worklet_install",
    label: "Install worklet",
    description:
        'Install a worklet by importing a folder of TypeScript and a required 512x512 PNG icon. Both sources must be inside the active workspace or Rig-generated media directory. At the folder\'s root it needs: a worklet.json naming the worklet, describing it in one line, and declaring the disk and network permissions it needs; a README.md saying in plain language what it does and why someone would run it; a DEVELOPMENT.md saying how it works inside, for whoever changes it next; and an index.ts that imports `worklet` from "happy-worklets", declares its tools, and calls worklet.ready(). Rig copies the folder in as version v1, gives the worklet a Data folder that survives every later version, and starts it in the background with exactly the permissions its manifest declared. Its tools then become callable by any agent.',
    arguments: Type.Object(
        {
            path: Type.String({ description: "Absolute path of the source folder to import." }),
            iconPath: Type.String({
                description: "Absolute path of the required 512x512 PNG icon.",
            }),
            permissions: workletPermissionsSchema,
            sourceDescription: Type.Optional(
                Type.String({
                    description: "Where the sources live, such as the project and folder.",
                }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: workletSchema,
    requiresAutoOrFullAccess: true,
    shouldReviewInAutoMode: () => true,
    shouldRunInFullAccessInAutoMode: () => true,
    describeAutoPermissionAction: ({ iconPath, path, permissions }) =>
        `install the folder ${quoteVisibleExact(path)} with icon ${quoteVisibleExact(iconPath)} as version v1 of a worklet under ${quoteVisibleExact(getWorkletsDirectory())}, and start it. ${describeWorkletPermissions(permissions)} Rig will refuse the install if these reviewed permissions differ from the staged worklet.json. ${OUTSIDE_WORKSPACE}`,
    execute: async (args, context) => {
        await Promise.all([
            assertShareableLocalPath(args.path, context),
            assertShareableLocalPath(args.iconPath, context),
        ]);
        const { permissions, ...request } = args;
        return requireWorklets(context).install(request, context.fs, permissions);
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Installed the ${result.name} worklet at version v1.`,
    locks: ["worklets"],
});

export const workletUpdateTool = defineTool({
    name: "worklet_update",
    label: "Update worklet",
    description:
        "Import a new version of an installed worklet from a source folder inside the active workspace or Rig-generated media directory. The folder needs the same worklet.json, README.md, DEVELOPMENT.md, and entry point an install does; its worklet.json must name the same worklet, and its declared permissions become the ones Rig enforces from now on. Keep the two documents current with the change rather than carrying the old ones forward. The import becomes the next version (v2, v3, ...) and the worklet restarts on it; earlier versions are kept and the worklet's Data folder is untouched. A description of the change is required.",
    arguments: Type.Object(
        {
            name: Type.String({ description: "The worklet to update." }),
            path: Type.String({ description: "Absolute path of the source folder to import." }),
            permissions: workletPermissionsSchema,
            changeDescription: Type.String({ description: "What changed in this import." }),
        },
        { additionalProperties: false },
    ),
    returnType: workletSchema,
    requiresAutoOrFullAccess: true,
    shouldReviewInAutoMode: () => true,
    shouldRunInFullAccessInAutoMode: () => true,
    describeAutoPermissionAction: ({ name, path, permissions }) =>
        `import ${quoteVisibleExact(path)} as the next version of the worklet ${quoteVisibleExact(name)} under ${quoteVisibleExact(getWorkletsDirectory())} and restart it. ${describeWorkletPermissions(permissions)} Rig will refuse the update if these reviewed permissions differ from the staged worklet.json. ${OUTSIDE_WORKSPACE}`,
    execute: async ({ changeDescription, name, path, permissions }, context) => {
        await assertShareableLocalPath(path, context);
        return requireWorklets(context).update(
            name,
            { changeDescription, path },
            context.fs,
            permissions,
        );
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        `Updated the ${result.name} worklet to version v${String(result.currentVersion)}.`,
    locks: ["worklets"],
});

export const workletRevertTool = defineTool({
    name: "worklet_revert",
    label: "Revert worklet",
    description:
        "Make an earlier version of a worklet current again and restart it on that version, under the permissions that version's manifest declared. No versions are deleted and the worklet's Data folder is untouched.",
    arguments: Type.Object(
        {
            name: Type.String({ description: "The worklet to revert." }),
            permissions: workletPermissionsSchema,
            version: Type.Integer({
                minimum: 1,
                description: "The existing version to make current.",
            }),
        },
        { additionalProperties: false },
    ),
    returnType: workletSchema,
    requiresAutoOrFullAccess: true,
    shouldReviewInAutoMode: () => true,
    describeAutoPermissionAction: ({ name, permissions, version }) =>
        `make version v${String(version)} of the worklet ${quoteVisibleExact(name)} current and restart it. ${describeWorkletPermissions(permissions)} Rig will refuse the revert if these reviewed permissions differ from the stored version. Access: runs the worklet in the background outside the workspace sandbox`,
    execute: ({ name, permissions, version }, context) =>
        requireWorklets(context).revert(name, { version }, permissions),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        `Reverted the ${result.name} worklet to version v${String(result.currentVersion)}.`,
    locks: ["worklets"],
});

export const workletUninstallTool = defineTool({
    name: "worklet_uninstall",
    label: "Uninstall worklet",
    description:
        "Stop a worklet and remove every version of its code. Its Data folder is kept, because the data outlives the code that wrote it.",
    arguments: Type.Object(
        { name: Type.String({ description: "The worklet to uninstall." }) },
        { additionalProperties: false },
    ),
    returnType: Type.Object({ name: Type.String() }, { additionalProperties: false }),
    requiresAutoOrFullAccess: true,
    shouldReviewInAutoMode: () => true,
    shouldRunInFullAccessInAutoMode: () => true,
    describeAutoPermissionAction: ({ name }) =>
        `stop the worklet ${quoteVisibleExact(name)} and delete its code under ${quoteVisibleExact(getWorkletsDirectory())}, keeping its Data folder. Access: deletes files outside the workspace sandbox`,
    execute: async ({ name }, context) => {
        await requireWorklets(context).uninstall(name);
        return { name };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Uninstalled the ${result.name} worklet and kept its data.`,
    locks: ["worklets"],
});

export const workletListTool = defineTool({
    name: "worklet_list",
    label: "List worklets",
    description:
        "List every installed worklet: what it is, its current version and version history, whether it is running, what it says about itself, and the tools it offers agents.",
    arguments: Type.Object({}, { additionalProperties: false }),
    returnType: Type.Object(
        { worklets: Type.Array(workletSchema) },
        { additionalProperties: false },
    ),
    execute: async (_args, context): Promise<{ worklets: Worklet[] }> => ({
        worklets: [...(await requireWorklets(context).list())],
    }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        result.worklets.length === 0
            ? "No worklets are installed."
            : `Found ${String(result.worklets.length)} ${result.worklets.length === 1 ? "worklet" : "worklets"}.`,
    shouldReviewInAutoMode: () => false,
    locks: [],
});

export const workletLogsTool = defineTool({
    name: "worklet_logs",
    label: "Read worklet log",
    description:
        "Read the bounded current log of one installed worklet, including whether it is running, stopped, or failed to start.",
    arguments: Type.Object(
        { name: Type.String({ description: "The worklet whose log to read." }) },
        { additionalProperties: false },
    ),
    returnType: Type.Object(
        { log: Type.String(), truncated: Type.Boolean() },
        { additionalProperties: false },
    ),
    execute: ({ name }, context) => requireWorklets(context).readLog(name),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => (result.log.length === 0 ? "The worklet has no output yet." : result.log),
    shouldReviewInAutoMode: () => false,
    locks: [],
});

export const workletTools = [
    workletInstallTool,
    workletUpdateTool,
    workletRevertTool,
    workletUninstallTool,
    workletListTool,
    workletLogsTool,
];

function requireWorklets(context: AgentContext): WorkletContext {
    if (context.worklets === undefined) {
        throw new Error("Worklets are unavailable in this session.");
    }
    return context.worklets;
}
