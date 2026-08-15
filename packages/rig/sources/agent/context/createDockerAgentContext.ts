import type { AgentContext } from "./AgentContext.js";
import type { FolderContext } from "./FolderContext.js";
import type { UserInputContext } from "./UserInputContext.js";
import { createFileReadState } from "./FileReadState.js";
import {
    createPermissionContext,
    DEFAULT_PERMISSION_MODE,
    type PermissionMode,
} from "../../permissions/index.js";
import {
    CONTAINER_DOCS_PATH,
    createDockerBashContext,
    createDockerFileSystemContext,
    DockerEnvironment,
    type DockerExecutionConfig,
} from "../../execution/index.js";
import type { SessionSecretContext } from "../../secrets/index.js";
import type { PluginContext } from "./PluginContext.js";
import { posix } from "node:path";

export interface CreateDockerAgentContextOptions {
    docker: DockerExecutionConfig;
    environment?: Readonly<Record<string, string>>;
    folders?: FolderContext;
    permissionMode?: PermissionMode;
    plugins?: PluginContext;
    protectedPaths?: readonly string[];
    secrets?: SessionSecretContext;
    sessionId: string;
    userInput?: UserInputContext;
}

export function createDockerAgentContext(options: CreateDockerAgentContextOptions): AgentContext {
    const environment = new DockerEnvironment(options.docker, options.sessionId);
    const protectedPaths = (options.protectedPaths ?? []).map((path) =>
        posix.resolve(environment.config.workingDirectory, path),
    );
    const permissions = createPermissionContext(options.permissionMode ?? DEFAULT_PERMISSION_MODE, {
        protectedPaths,
    });
    const context: AgentContext = {
        bash: createDockerBashContext(
            environment,
            permissions,
            options.secrets,
            options.plugins?.network,
            options.environment,
        ),
        docsPath: CONTAINER_DOCS_PATH,
        fileReads: createFileReadState(),
        fs: createDockerFileSystemContext(environment, permissions),
        permissions,
    };
    if (options.secrets !== undefined) context.secrets = options.secrets;
    if (options.userInput !== undefined) context.userInput = options.userInput;
    if (options.folders !== undefined) context.folders = options.folders;
    return context;
}
