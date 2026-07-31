import { chmodSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface DaemonDiagnosticReportWriter {
    directory: string;
    excludeEnv: boolean;
    writeReport(filename?: string, error?: Error): string;
}

export function writeDaemonCrashReport(
    error: unknown,
    writer: DaemonDiagnosticReportWriter = process.report,
    setMode: (path: string, mode: number) => void = chmodSync,
): string {
    if (!writer.excludeEnv) {
        throw new Error(
            "The Node.js runtime cannot redact environment credentials from diagnostic reports.",
        );
    }
    if (!isAbsolute(writer.directory)) {
        throw new Error("The daemon diagnostic report directory is not an absolute path.");
    }
    const reportError =
        error instanceof Error
            ? error
            : new Error(typeof error === "string" ? error : "The Rig daemon failed.");
    const writtenPath = writer.writeReport(undefined, reportError);
    const reportPath = isAbsolute(writtenPath)
        ? writtenPath
        : resolve(writer.directory, writtenPath);
    setMode(reportPath, 0o600);
    return reportPath;
}
