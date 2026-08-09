import type { AgentSessionTransferSchedule } from "../agent/context/WorkspaceContext.js";
import type { ProjectRepository } from "../project/ProjectRepository.js";
import type { TransferSessionResponse } from "../protocol/index.js";
import type { InMemorySession } from "./InMemorySession.js";
import { WorkspaceTransferTargetRestoreError } from "../git/prepareWorkspaceTransfer.js";

interface SessionTransferDependencies {
    hasAttachedSessions(workspaceId: string): boolean | Promise<boolean>;
    projects: ProjectRepository;
    releaseTarget(workspaceId: string, sessionId: string): void;
    reserveTarget(workspaceId: string, sessionId: string): void;
    session: InMemorySession;
    targetWorkspaceId: string;
}

export async function scheduleSessionWorkspaceTransfer(
    dependencies: SessionTransferDependencies,
): Promise<AgentSessionTransferSchedule> {
    const source = await dependencies.session.scheduleWorkspaceTransfer(
        dependencies.targetWorkspaceId,
    );
    try {
        await dependencies.projects.validateSessionTransfer(
            source.projectId,
            source.sourceWorkspaceId,
            dependencies.targetWorkspaceId,
        );
        await assertTargetHasNoSessions(dependencies);
        dependencies.reserveTarget(dependencies.targetWorkspaceId, dependencies.session.id);
        return {
            state: "scheduled",
            targetWorkspaceId: dependencies.targetWorkspaceId,
        };
    } catch (error) {
        await dependencies.session.failWorkspaceTransfer(dependencies.targetWorkspaceId, error);
        dependencies.releaseTarget(dependencies.targetWorkspaceId, dependencies.session.id);
        throw error;
    }
}

export async function executeSessionWorkspaceTransfer(
    dependencies: SessionTransferDependencies & { scheduled?: boolean },
): Promise<TransferSessionResponse> {
    const source = await dependencies.session.beginWorkspaceTransfer(
        dependencies.targetWorkspaceId,
        dependencies.scheduled === true ? { scheduled: true } : {},
    );
    let prepared:
        | Awaited<ReturnType<ProjectRepository["prepareSessionTransfer"]>>["prepared"]
        | undefined;
    try {
        dependencies.reserveTarget(dependencies.targetWorkspaceId, dependencies.session.id);
        await assertTargetHasNoSessions(dependencies);
        const transfer = await dependencies.projects.prepareSessionTransfer(
            source.projectId,
            source.sourceWorkspaceId,
            dependencies.targetWorkspaceId,
            async () => await assertTargetHasNoSessions(dependencies),
        );
        prepared = transfer.prepared;
        const session = await dependencies.session.completeWorkspaceTransfer({
            commit: prepared.commit,
            targetWorkspaceId: dependencies.targetWorkspaceId,
            workspacePath: transfer.target.path,
        });
        await prepared.commitTransfer();
        return { commit: prepared.commit, session, state: "succeeded" };
    } catch (error) {
        if (dependencies.session.workspaceTransferState().status === "succeeded") {
            await prepared?.commitTransfer();
            throw error;
        }
        let failure = error;
        let target: "not_touched" | "restored" | "restore_failed" =
            error instanceof WorkspaceTransferTargetRestoreError ? "restore_failed" : "not_touched";
        if (prepared !== undefined) {
            try {
                await prepared.rollback(error);
            } catch (rollbackError) {
                failure =
                    rollbackError instanceof WorkspaceTransferTargetRestoreError
                        ? dependencies.projects.markSessionTransferTargetFailed(
                              source.projectId,
                              dependencies.targetWorkspaceId,
                              rollbackError,
                          )
                        : rollbackError;
            }
            if (prepared.state.status === "failed") target = prepared.state.target;
        }
        await dependencies.session.failWorkspaceTransfer(
            dependencies.targetWorkspaceId,
            failure,
            target,
        );
        throw failure;
    } finally {
        dependencies.releaseTarget(dependencies.targetWorkspaceId, dependencies.session.id);
    }
}

async function assertTargetHasNoSessions(dependencies: SessionTransferDependencies): Promise<void> {
    if (await dependencies.hasAttachedSessions(dependencies.targetWorkspaceId)) {
        throw new Error(
            "The target workspace must have no attached sessions before this session can move there.",
        );
    }
}
