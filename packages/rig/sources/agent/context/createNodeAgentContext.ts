import type { NativeProcessManager } from "../../processes/index.js";
import type { AgentContext } from "./AgentContext.js";
import type { FolderContext } from "./FolderContext.js";
import { createFileReadState } from "./FileReadState.js";
import { createNodeBashContext } from "./createNodeBashContext.js";
import { createNodeFileSystemContext } from "./createNodeFileSystemContext.js";
import type { UserInputContext } from "./UserInputContext.js";
import {
    createPermissionContext,
    DEFAULT_PERMISSION_MODE,
    type PermissionMode,
} from "../../permissions/index.js";
import type { SessionSecretContext } from "../../secrets/index.js";
import { getBundledDocsRoot } from "../../execution/getBundledDocsRoot.js";
import type { PluginContext } from "./PluginContext.js";
import { resolve } from "node:path";
import type { Context } from "@steve.kite/stdlib";

export interface CreateNodeAgentContextOptions {
    cwd: string;
    environment?: NodeJS.ProcessEnv;
    folders?: FolderContext;
    processManager: NativeProcessManager;
    permissionMode?: PermissionMode;
    plugins?: PluginContext;
    protectedPaths?: readonly string[];
    secrets?: SessionSecretContext;
    userInput?: UserInputContext;
}

export function createNodeAgentContext(
    ctx: Context,
    options: CreateNodeAgentContextOptions,
): AgentContext {
    const protectedPaths = (options.protectedPaths ?? []).map((path) => resolve(options.cwd, path));
    const permissions = createPermissionContext(options.permissionMode ?? DEFAULT_PERMISSION_MODE, {
        protectedPaths,
    });
    const context: AgentContext = {
        fs: createNodeFileSystemContext(options.cwd, {
            permissionMode: () => permissions.mode,
            protectedPaths,
        }),
        bash: createNodeBashContext({
            ctx,
            cwd: options.cwd,
            ...(options.environment === undefined ? {} : { environment: options.environment }),
            processManager: options.processManager,
            permissions,
            ...(options.plugins?.network === undefined
                ? {}
                : { networkInterceptor: options.plugins.network }),
            ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
        }),
        docsPath: getBundledDocsRoot(),
        fileReads: createFileReadState(),
        permissions,
    };
    if (options.secrets !== undefined) context.secrets = options.secrets;
    if (options.userInput !== undefined) context.userInput = options.userInput;
    if (options.folders !== undefined) context.folders = options.folders;
    return context;
}
