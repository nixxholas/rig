import { beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "./main.js";
import { readPackageVersion } from "../readPackageVersion.js";
import { runApp } from "./runApp.js";
import { runDesktop } from "./runDesktop.js";
import { runExec } from "./runExec.js";
import { runLocalProtocolServer } from "../server/index.js";
import { runHappyAuthCommand } from "../happy/index.js";
import { rigInspectionExitCode, runRigInspection } from "./runRigInspection.js";
import { runUpgradeCommand } from "./runUpgradeCommand.js";

vi.mock("./runApp.js", () => ({ runApp: vi.fn() }));
vi.mock("./runDesktop.js", () => ({ runDesktop: vi.fn() }));
vi.mock("./runExec.js", () => ({ runExec: vi.fn() }));
vi.mock("../readPackageVersion.js", () => ({ readPackageVersion: vi.fn(() => "1.2.3") }));
vi.mock("../server/index.js", () => ({ runLocalProtocolServer: vi.fn() }));
vi.mock("../happy/index.js", () => ({ runHappyAuthCommand: vi.fn() }));
vi.mock("./runRigInspection.js", () => ({
    rigInspectionExitCode: vi.fn(() => 0),
    runRigInspection: vi.fn(),
}));
vi.mock("./runUpgradeCommand.js", () => ({ runUpgradeCommand: vi.fn() }));

describe("main command dispatch", () => {
    beforeEach(() => {
        vi.mocked(runApp).mockReset();
        vi.mocked(runApp).mockResolvedValue({ action: "exit" });
        vi.mocked(runDesktop).mockReset();
        vi.mocked(runExec).mockReset();
        vi.mocked(runLocalProtocolServer).mockReset();
        vi.mocked(readPackageVersion).mockClear();
        vi.mocked(runHappyAuthCommand).mockReset();
        vi.mocked(runRigInspection).mockReset();
        vi.mocked(runRigInspection).mockReturnValue({
            cliProtocolVersion: 5,
            cliVersion: "1.2.3",
            data: { status: "absent" },
            formatVersion: 1,
            source: "cli",
        });
        vi.mocked(rigInspectionExitCode).mockReset();
        vi.mocked(rigInspectionExitCode).mockReturnValue(0);
        vi.mocked(runUpgradeCommand).mockReset();
    });

    it("starts the internal server only for its exact private invocation", async () => {
        await main(["--server"]);

        expect(runLocalProtocolServer).toHaveBeenCalledWith({
            happyIntegration: "enabled",
        });
        expect(runExec).not.toHaveBeenCalled();
        expect(runApp).not.toHaveBeenCalled();
    });

    it("treats --server after the exec separator as prompt text", async () => {
        await main(["exec", "--", "--server"]);

        expect(runExec).toHaveBeenCalledWith({
            fork: false,
            last: false,
            outputFormat: "text",
            prompt: "--server",
        });
        expect(runLocalProtocolServer).not.toHaveBeenCalled();
        expect(runApp).not.toHaveBeenCalled();
    });

    it("rejects --server as an unknown exec option", async () => {
        await expect(main(["exec", "--json", "--server"])).rejects.toThrow(
            "Unknown rig exec option '--server'.",
        );

        expect(runExec).not.toHaveBeenCalled();
        expect(runLocalProtocolServer).not.toHaveBeenCalled();
        expect(runApp).not.toHaveBeenCalled();
    });

    it("prints top-level help without starting a session", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        await main(["--help"]);

        expect(log).toHaveBeenCalledOnce();
        expect(log.mock.calls[0]?.[0]).toContain("Usage: rig");
        expect(log.mock.calls[0]?.[0]).toContain("rig desktop");
        expect(log.mock.calls[0]?.[0]).toContain("rig exec");
        expect(runApp).not.toHaveBeenCalled();
        log.mockRestore();
    });

    it("prints the installed version without starting a session", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        await main(["--version"]);

        expect(log).toHaveBeenCalledWith("Rig 1.2.3");
        expect(readPackageVersion).toHaveBeenCalledOnce();
        expect(runApp).not.toHaveBeenCalled();
        log.mockRestore();
    });

    it("inspects machine-readable installation state without starting a session or daemon", async () => {
        await expect(main(["inspect", "--json"])).resolves.toBe(0);

        expect(runRigInspection).toHaveBeenCalledWith({ json: true });
        expect(runApp).not.toHaveBeenCalled();
        expect(runLocalProtocolServer).not.toHaveBeenCalled();
    });

    it("returns status 2 when inspection completed with unusable data", async () => {
        vi.mocked(rigInspectionExitCode).mockReturnValue(2);

        await expect(main(["inspect"])).resolves.toBe(2);
        expect(rigInspectionExitCode).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: "absent" } }),
        );
    });

    it("upgrades to the newest Rig beta without starting a session", async () => {
        await main(["upgrade"]);

        expect(runUpgradeCommand).toHaveBeenCalledOnce();
        expect(runApp).not.toHaveBeenCalled();
    });

    it("rejects upgrade arguments before running npm", async () => {
        await expect(main(["upgrade", "latest"])).rejects.toThrow(
            "Rig upgrade does not take arguments.",
        );

        expect(runUpgradeCommand).not.toHaveBeenCalled();
    });

    it.each([["--bogus"], ["--json", "extra"]])(
        "rejects bogus inspection arguments %j",
        async (...arguments_) => {
            await expect(main(["inspect", ...arguments_])).rejects.toThrow(
                "Rig does not recognize that inspection option.",
            );
            expect(runRigInspection).not.toHaveBeenCalled();
            expect(runLocalProtocolServer).not.toHaveBeenCalled();
        },
    );

    it("starts Happy QR authentication without opening a session", async () => {
        await main(["happy", "auth"]);

        expect(runHappyAuthCommand).toHaveBeenCalledOnce();
        expect(runApp).not.toHaveBeenCalled();
    });

    it("builds and launches the local Happy desktop app without opening a session", async () => {
        await main(["desktop", "--build-only", "--force-build", "--happy2-root", "/source/happy2"]);

        expect(runDesktop).toHaveBeenCalledWith({
            buildOnly: true,
            forceBuild: true,
            happy2Root: "/source/happy2",
            skipBuild: false,
        });
        expect(runApp).not.toHaveBeenCalled();
    });

    it("prints desktop help without building the app", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        await main(["desktop", "--help"]);

        expect(log.mock.calls[0]?.[0]).toContain("Usage: rig desktop");
        expect(runDesktop).not.toHaveBeenCalled();
        expect(runApp).not.toHaveBeenCalled();
        log.mockRestore();
    });

    it.each(["resmue", "--unknown"])("rejects unknown top-level input %s", async (input) => {
        await expect(main([input])).rejects.toThrow(`Rig does not have`);

        expect(runApp).not.toHaveBeenCalled();
        expect(runExec).not.toHaveBeenCalled();
        expect(runLocalProtocolServer).not.toHaveBeenCalled();
    });

    it("reloads the TUI by resuming the same session", async () => {
        vi.mocked(runApp)
            .mockResolvedValueOnce({ action: "reload", sessionId: "session-reload-1" })
            .mockResolvedValueOnce({ action: "exit" });

        await main([]);

        expect(runApp).toHaveBeenCalledTimes(2);
        expect(runApp).toHaveBeenNthCalledWith(
            1,
            expect.not.objectContaining({ resumeSessionId: expect.anything() }),
        );
        expect(runApp).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ resumeSessionId: "session-reload-1" }),
        );
    });
});
