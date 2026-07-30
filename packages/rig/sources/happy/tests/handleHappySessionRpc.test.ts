import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeAgentContext } from "../../agent/context/createNodeAgentContext.js";
import { NativeProcessManager } from "../../processes/index.js";
import { handleHappySessionRpc } from "../handleHappySessionRpc.js";
import { resolveHappyRipgrepExecutable } from "../resolveHappyRipgrepExecutable.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("handleHappySessionRpc", () => {
    it("runs Happy shell and file operations through Rig's permission-aware context", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-happy-rpc-"));
        directories.push(cwd);
        const context = createNodeAgentContext({
            cwd,
            permissionMode: "workspace_write",
            processManager: new NativeProcessManager(),
        });
        let abortCalls = 0;
        const answered: { answers: Record<string, unknown>; requestId: string }[] = [];
        const cancelled: string[] = [];
        const call = (method: string, params: unknown) =>
            handleHappySessionRpc({
                abort: async () => {
                    abortCalls += 1;
                    return { aborted: true };
                },
                answerQuestion: (requestId, answers) => {
                    answered.push({ answers, requestId });
                },
                cancelQuestion: (requestId) => {
                    cancelled.push(requestId);
                },
                context: () => context,
                method,
                params,
            });

        await expect(resolveHappyRipgrepExecutable(context)).resolves.not.toBe("rg");
        await expect(call("abort", undefined)).resolves.toEqual({ aborted: true });
        expect(abortCalls).toBe(1);

        const written = await call("writeFile", {
            content: Buffer.from("hello").toString("base64"),
            expectedHash: null,
            path: "note.txt",
        });
        expect(written).toMatchObject({ success: true, hash: expect.any(String) });
        await expect(call("readFile", { path: "note.txt" })).resolves.toEqual({
            content: Buffer.from("hello").toString("base64"),
            success: true,
        });
        await expect(call("bash", { command: "printf mobile-shell" })).resolves.toMatchObject({
            exitCode: 0,
            stdout: "mobile-shell",
            success: true,
        });
        await expect(
            call("ripgrep", { args: ["--fixed-strings", "hello", "note.txt"] }),
        ).resolves.toMatchObject({
            exitCode: 0,
            stdout: "hello\n",
            success: true,
        });

        await expect(
            call("permission", {
                approved: true,
                decision: "approved",
                id: "call-1",
                updatedInput: { answers: { "Where to?": "Locally" } },
            }),
        ).resolves.toMatchObject({ success: true });
        expect(answered).toEqual([{ answers: { "Where to?": "Locally" }, requestId: "call-1" }]);

        await expect(
            call("permission", { approved: false, decision: "denied", id: "call-2" }),
        ).resolves.toMatchObject({ success: true });
        expect(cancelled).toEqual(["call-2"]);

        await expect(call("permission", { approved: true, id: "call-3" })).rejects.toThrow(
            "Happy approved a question without any answers.",
        );

        context.permissions?.setMode("read_only");
        await expect(
            call("writeFile", {
                content: Buffer.from("blocked").toString("base64"),
                expectedHash: (written as { hash: string }).hash,
                path: "note.txt",
            }),
        ).rejects.toThrow("File changes are disabled in read-only mode");
    });

    it("waits for a denied question to finish cancelling", async () => {
        let finishCancellation = () => {};
        let cancelled = false;
        const cancellation = new Promise<void>((resolve) => {
            finishCancellation = resolve;
        });
        const result = handleHappySessionRpc({
            abort: async () => ({ aborted: true }),
            answerQuestion: () => {},
            cancelQuestion: async () => {
                await cancellation;
                cancelled = true;
            },
            context: () => {
                throw new Error("The permission RPC does not need an agent context.");
            },
            method: "permission",
            params: { approved: false, decision: "denied", id: "call-1" },
        });
        let settled = false;
        void result.then(() => {
            settled = true;
        });

        await Promise.resolve();
        expect(settled).toBe(false);
        finishCancellation();
        await expect(result).resolves.toEqual({ success: true });
        expect(cancelled).toBe(true);
    });
});
