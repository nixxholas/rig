import type { CreateSessionRequest } from "../protocol/index.js";
import type { ProjectSessionSettings } from "../project/ProjectRepository.js";
import {
    resolveDockerExecutionConfig,
    validateDockerExecutionConfig,
    type DockerExecutionConfig,
} from "../execution/index.js";
import { SessionConfigurationError } from "./SessionConfigurationError.js";

export async function configureSessionRequest(
    request: CreateSessionRequest,
    defaultDocker: DockerExecutionConfig | undefined,
    queryProjectSettings?: () =>
        | ProjectSessionSettings
        | undefined
        | Promise<ProjectSessionSettings | undefined>,
): Promise<CreateSessionRequest> {
    if (request.local === true && request.docker !== undefined) {
        throw new SessionConfigurationError(
            "Choose either local execution or a Docker environment, not both.",
        );
    }
    const { local: _local, ...configured } = request;
    const projectSettings =
        request.local === true || request.docker !== undefined
            ? undefined
            : await queryProjectSettings?.();
    const projectCompute = projectSettings?.settings.defaultWorkspaceCompute;
    const projectDocker =
        projectCompute?.type === "docker" && projectSettings !== undefined
            ? {
                  image: projectCompute.image,
                  mounts: [{ source: request.cwd, target: "/workspace" }],
                  name:
                      projectSettings.workspaceId === undefined
                          ? `rig-project-${projectSettings.projectId}-${String(projectCompute.generation)}`
                          : `rig-workspace-${projectSettings.workspaceId}-${String(projectCompute.generation)}`,
                  workingDirectory: "/workspace",
              }
            : undefined;
    const docker =
        request.docker ??
        (request.local === true || projectCompute?.type === "local"
            ? undefined
            : (projectDocker ?? defaultDocker));
    if (docker !== undefined) {
        try {
            validateDockerExecutionConfig(docker);
            configured.docker = resolveDockerExecutionConfig(docker, request.cwd);
        } catch (error) {
            throw new SessionConfigurationError(
                error instanceof Error ? error.message : "The Docker settings are invalid.",
            );
        }
    }
    return configured;
}
