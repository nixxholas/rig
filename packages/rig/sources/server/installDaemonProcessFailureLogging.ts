import type { DaemonLog } from "./DaemonLog.js";

export interface DaemonProcessFailureEvents {
    off(
        event: "uncaughtExceptionMonitor",
        listener: (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void,
    ): void;
    on(
        event: "uncaughtExceptionMonitor",
        listener: (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void,
    ): void;
}

export function installDaemonProcessFailureLogging(
    log: DaemonLog,
    processEvents: DaemonProcessFailureEvents = process,
    writeCrashReport?: (error: Error) => unknown,
): () => void {
    const onUncaughtException = (error: Error, origin: NodeJS.UncaughtExceptionOrigin): void => {
        log.record(
            "error",
            "daemon_fatal_error",
            origin === "unhandledRejection"
                ? "Rig daemon is terminating after an unhandled rejection."
                : "Rig daemon is terminating after an uncaught exception.",
            {
                errorMessage: error.message,
                errorName: error.name,
                errorStack: (error.stack ?? error.message).slice(0, 65_536),
                origin,
            },
        );
        try {
            writeCrashReport?.(error);
        } catch (reportError) {
            log.record(
                "error",
                "daemon_crash_report_failed",
                "Rig could not write a diagnostic report for the daemon failure.",
                {
                    errorMessage:
                        reportError instanceof Error ? reportError.message : String(reportError),
                },
            );
        }
    };
    processEvents.on("uncaughtExceptionMonitor", onUncaughtException);
    return () => processEvents.off("uncaughtExceptionMonitor", onUncaughtException);
}
