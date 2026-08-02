import { PluginWorkspaceOperationError } from "./PluginWorkspaceOperationError.js";

type PluginWorkspaceOperation = "execute" | "path" | "read" | "resolve" | "write";

export function toPluginWorkspaceOperationError(
    error: unknown,
    operation: PluginWorkspaceOperation,
): PluginWorkspaceOperationError {
    if (error instanceof PluginWorkspaceOperationError) return error;
    const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
    if (code === "ENOENT") {
        if (operation === "read") {
            return new PluginWorkspaceOperationError(
                "The requested workspace file does not exist.",
                404,
                error,
            );
        }
        if (operation === "write") {
            return new PluginWorkspaceOperationError(
                "The workspace file could not be written because its path is unavailable.",
                400,
                error,
            );
        }
        return new PluginWorkspaceOperationError(
            "The workspace directory is unavailable.",
            404,
            error,
        );
    }
    if (code === "ENOTDIR") {
        if (operation === "execute" || operation === "resolve") {
            return new PluginWorkspaceOperationError(
                "The workspace directory is unavailable.",
                404,
                error,
            );
        }
        if (operation === "read") {
            return new PluginWorkspaceOperationError(
                "The requested workspace file does not exist.",
                404,
                error,
            );
        }
        return new PluginWorkspaceOperationError(
            operation === "write"
                ? "The workspace file could not be written because part of its path is not a directory."
                : "The workspace file path is invalid because part of it is not a directory.",
            400,
            error,
        );
    }
    if (code === "EISDIR") {
        return new PluginWorkspaceOperationError(
            operation === "read"
                ? "The requested workspace path is not a file."
                : "The workspace file could not be written because its path is a directory.",
            400,
            error,
        );
    }
    if (code === "EACCES" || code === "EPERM") {
        return new PluginWorkspaceOperationError(
            operation === "execute"
                ? "The workspace command could not start because the workspace or Bash is not accessible."
                : "The requested workspace file path is not accessible.",
            400,
            error,
        );
    }
    if (code === "EROFS") {
        return new PluginWorkspaceOperationError(
            "The workspace file system is read-only.",
            400,
            error,
        );
    }
    if (code === "EEXIST") {
        return new PluginWorkspaceOperationError(
            "The workspace file could not be written because a path entry already exists.",
            400,
            error,
        );
    }
    if (code === "ELOOP") {
        return new PluginWorkspaceOperationError(
            "The workspace file path contains a symbolic-link loop.",
            400,
            error,
        );
    }
    return new PluginWorkspaceOperationError(
        operation === "execute"
            ? "The workspace command could not be executed."
            : operation === "read"
              ? "The workspace file could not be read."
              : operation === "write"
                ? "The workspace file could not be written."
                : "The workspace file path could not be resolved.",
        400,
        error,
    );
}
