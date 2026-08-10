import { describe, expect, it } from "vitest";

import { DaemonLog } from "../server/DaemonLog.js";
import { createDaemonLogger } from "./createDaemonLogger.js";

describe("createDaemonLogger", () => {
    it("adapts every stdlib log level to structured daemon records", () => {
        const lines: string[] = [];
        const daemonLog = new DaemonLog({
            now: () => Date.parse("2026-08-09T20:00:00.000Z"),
            path: "/state/server.log",
            pid: 42,
            version: "0.2.3",
            write: (_path, line) => lines.push(line),
        });
        const logger = createDaemonLogger(daemonLog);
        const context = { context: "request", event: "request_finished", requestId: "request-1" };

        logger.trace(context, "trace message");
        logger.debug(context, "debug message");
        logger.info(context, "info message");
        logger.warn(context, "warning message");
        logger.error(context, "error message");
        logger.fatal(context, "fatal message");

        expect(lines.map((line) => JSON.parse(line))).toEqual([
            expect.objectContaining({
                context: "request",
                event: "request_finished",
                level: "info",
                message: "trace message",
                requestId: "request-1",
                severity: "trace",
            }),
            expect.objectContaining({ level: "info", message: "debug message", severity: "debug" }),
            expect.objectContaining({ level: "info", message: "info message", severity: "info" }),
            expect.objectContaining({
                level: "warning",
                message: "warning message",
                severity: "warn",
            }),
            expect.objectContaining({
                level: "error",
                message: "error message",
                severity: "error",
            }),
            expect.objectContaining({
                level: "error",
                message: "fatal message",
                severity: "fatal",
            }),
        ]);
    });

    it("bounds messages and keeps only daemon-log-compatible context fields", () => {
        const lines: string[] = [];
        const daemonLog = new DaemonLog({
            path: "/state/server.log",
            write: (_path, line) => lines.push(line),
        });
        const logger = createDaemonLogger(daemonLog);

        expect(() =>
            logger.info(
                {
                    event: "context_test",
                    nested: { secret: "not serialized" },
                    requestId: "request-1",
                },
                "x".repeat(70_000),
            ),
        ).not.toThrow();

        const record = JSON.parse(lines[0]!) as Record<string, unknown>;
        expect(record.message).toHaveLength(65_536);
        expect(record.requestId).toBe("request-1");
        expect(record).not.toHaveProperty("nested");
    });
});
