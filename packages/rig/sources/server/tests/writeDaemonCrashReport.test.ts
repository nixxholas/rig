import { describe, expect, it, vi } from "vitest";

import { writeDaemonCrashReport } from "../writeDaemonCrashReport.js";

describe("writeDaemonCrashReport", () => {
    it("passes the original failure to Node's synchronous diagnostic writer", () => {
        const error = new Error("daemon crash");
        const writer = {
            directory: "/state/diagnostics",
            excludeEnv: true,
            writeReport: vi.fn(() => "report.json"),
        };
        const setMode = vi.fn();

        expect(writeDaemonCrashReport(error, writer, setMode)).toBe(
            "/state/diagnostics/report.json",
        );
        expect(writer.writeReport).toHaveBeenCalledWith(undefined, error);
        expect(setMode).toHaveBeenCalledWith("/state/diagnostics/report.json", 0o600);
    });

    it("turns a non-Error rejection into a useful report failure", () => {
        const writer = {
            directory: "/state/diagnostics",
            excludeEnv: true,
            writeReport: vi.fn(() => "/state/diagnostics/report.json"),
        };

        writeDaemonCrashReport("daemon rejection", writer, vi.fn());

        expect(writer.writeReport).toHaveBeenCalledWith(
            undefined,
            expect.objectContaining({ message: "daemon rejection" }),
        );
    });

    it("fails closed when the runtime cannot redact environment credentials", () => {
        const writer = {
            directory: "/state/diagnostics",
            excludeEnv: false,
            writeReport: vi.fn(() => "/state/diagnostics/report.json"),
        };

        expect(() => writeDaemonCrashReport(new Error("daemon crash"), writer, vi.fn())).toThrow(
            "cannot redact environment credentials",
        );
        expect(writer.writeReport).not.toHaveBeenCalled();
    });

    it("fails closed when the diagnostic directory is not absolute", () => {
        const writer = {
            directory: "",
            excludeEnv: true,
            writeReport: vi.fn(() => "report.json"),
        };

        expect(() => writeDaemonCrashReport(new Error("daemon crash"), writer, vi.fn())).toThrow(
            "diagnostic report directory is not an absolute path",
        );
        expect(writer.writeReport).not.toHaveBeenCalled();
    });
});
