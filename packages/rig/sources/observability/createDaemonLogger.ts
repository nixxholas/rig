import type { LogContext, Logger } from "@steve.kite/stdlib";

import type { DaemonLog, DaemonLogLevel } from "../server/DaemonLog.js";

const MAX_MESSAGE_LENGTH = 65_536;

export function createDaemonLogger(daemonLog: DaemonLog): Logger {
    const write = (severity: keyof Logger, context: LogContext, args: readonly unknown[]): void => {
        daemonLog.record(
            daemonLevel(severity),
            typeof context.event === "string" ? context.event : "daemon_log",
            formatMessage(args),
            { ...daemonDetails(context), severity },
        );
    };

    return {
        trace: (context, ...args) => write("trace", context, args),
        debug: (context, ...args) => write("debug", context, args),
        info: (context, ...args) => write("info", context, args),
        warn: (context, ...args) => write("warn", context, args),
        error: (context, ...args) => write("error", context, args),
        fatal: (context, ...args) => write("fatal", context, args),
    };
}

function daemonLevel(severity: keyof Logger): DaemonLogLevel {
    if (severity === "warn") return "warning";
    if (severity === "error" || severity === "fatal") return "error";
    return "info";
}

function daemonDetails(
    context: LogContext,
): Readonly<Record<string, boolean | number | string | undefined>> {
    const details: Record<string, boolean | number | string | undefined> = {};
    for (const [key, value] of Object.entries(context)) {
        if (key === "event") continue;
        if (
            value === undefined ||
            typeof value === "boolean" ||
            typeof value === "number" ||
            typeof value === "string"
        ) {
            details[key] = value;
        }
    }
    return details;
}

function formatMessage(args: readonly unknown[]): string {
    return args.map(formatArgument).join(" ").slice(0, MAX_MESSAGE_LENGTH);
}

function formatArgument(value: unknown): string {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.message;
    if (value === undefined) return "undefined";
    if (typeof value === "bigint" || typeof value === "symbol") return String(value);
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}
