import type {
    InstallWorkletRequest,
    RevertWorkletRequest,
    UpdateWorkletRequest,
    Worklet,
    WorkletPermissions,
} from "../../protocol/WorkletProtocol.js";
import type { FileSystemContext } from "./FileSystemContext.js";

/**
 * How an agent manages the worklets installed on this machine.
 *
 * Each change takes effect at once — a worklet starts when it is installed, restarts when it is
 * updated or reverted, and stops when it is uninstalled — and every change is announced to every
 * attached client. The author session is baked in by whoever builds this context, so a tool can
 * never claim another agent's authorship through arguments.
 */
export interface WorkletContext {
    install(
        request: Omit<InstallWorkletRequest, "authorSessionId">,
        sourceFileSystem?: FileSystemContext,
        expectedPermissions?: WorkletPermissions,
    ): Promise<Worklet>;
    list(): Promise<readonly Worklet[]>;
    readLog(name: string): Promise<{ log: string; truncated: boolean }>;
    /** Changes whenever the daemon-wide set of callable worklet tools changes. */
    toolRevision?(): number;
    revert(
        name: string,
        request: RevertWorkletRequest,
        expectedPermissions?: WorkletPermissions,
    ): Promise<Worklet>;
    uninstall(name: string): Promise<void>;
    update(
        name: string,
        request: UpdateWorkletRequest,
        sourceFileSystem?: FileSystemContext,
        expectedPermissions?: WorkletPermissions,
    ): Promise<Worklet>;
}
