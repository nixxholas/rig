import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { startUnifiedEgressProxy } from "../../sources/network/startUnifiedEgressProxy.js";
import type { UnifiedEgressProxy } from "../../sources/network/UnifiedEgressProxy.js";

/**
 * The supervisor and the unified proxy meet here.
 *
 * Every other test of this protocol implements one side of it twice: the Rust suite writes a host
 * in Rust, and the TypeScript suite writes a client in TypeScript. Only this test proves the two
 * real implementations agree, with a real descriptor handed to a real sandboxed process.
 */
const LIVE = process.env.HAPPY_AGENT_COMPUTE_LIVE_TEST === "1";
const describeLive = LIVE ? describe : describe.skip;

const SUPERVISOR_BINARY =
    process.env.HAPPY_AGENT_SUPERVISOR_BINARY ??
    join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../happy-agent-supervisor/native/target/debug/happy-agent-supervisor",
    );

const WORKLOAD_TIMEOUT_MS = 20_000;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
});

describeLive("live unified egress proxy with the real supervisor", () => {
    beforeAll(() => {
        if (process.platform !== "darwin" && process.platform !== "linux") {
            throw new Error("The supervisor runs only on macOS and Linux.");
        }
        if (!existsSync(SUPERVISOR_BINARY)) {
            throw new Error(
                `The supervisor binary is missing at ${SUPERVISOR_BINARY}. Build it with "cargo +1.96.0 build --manifest-path native/Cargo.toml" in packages/happy-agent-supervisor, or set HAPPY_AGENT_SUPERVISOR_BINARY.`,
            );
        }
    });

    it("carries an allowed request from inside the sandbox to a real origin", async () => {
        const origin = await startOrigin();
        const proxy = startProxy();
        const command = proxy.registerCommand({ allowedDomains: [{ domain: "allowed.test" }] });

        const run = await supervise(proxy, command.token, [
            "/usr/bin/curl",
            "--silent",
            "--show-error",
            "--max-time",
            "10",
            `http://allowed.test:${String(origin.port)}/probe`,
        ]);

        expect(run.stderr).toBe("");
        expect(run.stdout).toBe("origin-ok");
        expect(run.code).toBe(0);
        expect(command.denial()).toBeUndefined();
    }, 30_000);

    it("refuses a host the command's policy does not allow", async () => {
        const origin = await startOrigin();
        const proxy = startProxy();
        const command = proxy.registerCommand({ allowedDomains: [{ domain: "allowed.test" }] });

        const run = await supervise(proxy, command.token, [
            "/usr/bin/curl",
            "--silent",
            "--output",
            "/dev/null",
            "--write-out",
            "%{http_code}",
            "--max-time",
            "10",
            `http://denied.test:${String(origin.port)}/probe`,
        ]);

        expect(run.stdout).toBe("403");
        expect(command.denial()).toEqual({
            host: "denied.test",
            port: origin.port,
            reason: "not_allowed",
        });
    }, 30_000);

    it("carries a SOCKS5 tunnel from inside the sandbox", async () => {
        const origin = await startOrigin();
        const proxy = startProxy();
        const command = proxy.registerCommand({ allowedDomains: [{ domain: "allowed.test" }] });

        const run = await supervise(
            proxy,
            command.token,
            [
                "/usr/bin/curl",
                "--silent",
                "--show-error",
                "--max-time",
                "10",
                "--socks5-hostname",
                "$ALL_PROXY_ENDPOINT",
                `http://allowed.test:${String(origin.port)}/probe`,
            ],
            { resolveSocksEndpoint: true },
        );

        expect(run.stderr).toBe("");
        expect(run.stdout).toBe("origin-ok");
    }, 30_000);

    it("gives a command whose token the proxy does not know no network at all", async () => {
        const origin = await startOrigin();
        const proxy = startProxy();
        proxy.registerCommand({ allowedDomains: [{ domain: "allowed.test" }] });

        const run = await supervise(proxy, "0".repeat(64), [
            "/usr/bin/curl",
            "--silent",
            "--max-time",
            "10",
            `http://allowed.test:${String(origin.port)}/probe`,
        ]);

        expect(run.code).toBe(125);
        expect(run.stdout).toBe("");
        expect(run.stderr).toContain("refused the command authentication token");
    }, 30_000);
});

function startProxy(): UnifiedEgressProxy {
    const proxy = startUnifiedEgressProxy({
        // Name resolution belongs to the host. Pinning it here keeps the test off real DNS while
        // still exercising the path the supervisor never gets to take.
        resolveAddress: async () => "127.0.0.1",
    });
    cleanups.push(() => proxy.close());
    return proxy;
}

async function startOrigin(): Promise<{ port: number; server: HttpServer }> {
    const server = createHttpServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" }).end("origin-ok");
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("origin has no port");
    cleanups.push(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return { port: address.port, server };
}

interface SupervisedRun {
    code: number | null;
    stderr: string;
    stdout: string;
}

async function supervise(
    proxy: UnifiedEgressProxy,
    token: string,
    command: readonly string[],
    options: { resolveSocksEndpoint?: boolean } = {},
): Promise<SupervisedRun> {
    const workspace = await mkdtemp(join(tmpdir(), "unified-egress-live-"));
    cleanups.push(() => rm(workspace, { force: true, recursive: true }));
    const policyPath = join(workspace, "policy.json");
    await writeFile(
        policyPath,
        JSON.stringify({
            mode: "workspace_write",
            network: {
                egress: true,
                allowedHosts: ["allowed.test"],
                localBinding: false,
                outgoingProxy: { upstreamFd: 3, token, frontEnds: ["http", "socks5"] },
            },
        }),
    );

    // `curl --socks5-hostname` takes the endpoint as an argument rather than from the environment,
    // and only the supervisor knows which port it bound, so the workload is asked to substitute it.
    const argv =
        options.resolveSocksEndpoint === true
            ? [
                  "/bin/sh",
                  "-c",
                  `exec ${command
                      .map((argument) =>
                          argument === "$ALL_PROXY_ENDPOINT"
                              ? '"${ALL_PROXY#socks5h://}"'
                              : `'${argument}'`,
                      )
                      .join(" ")}`,
              ]
            : [...command];

    const child: ChildProcess = spawn(
        SUPERVISOR_BINARY,
        ["--policy-file", policyPath, "--", ...argv],
        { cwd: workspace, stdio: ["ignore", "pipe", "pipe", "pipe"] },
    );
    cleanups.push(() => {
        child.kill("SIGKILL");
    });
    const link = child.stdio[3];
    if (link === null || link === undefined) throw new Error("the supervisor link was not created");
    // Rig connects the descriptor before the sandbox exists and hands the other end over. Nothing
    // inside the sandbox ever finds the proxy by address.
    proxy.attach(link as never);

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    // A workload that never starts must fail the test rather than hang it, so the wait is bounded
    // and reports what the supervisor managed to say before it stopped.
    const code = await new Promise<number | null>((resolve, reject) => {
        const deadline = setTimeout(() => {
            child.kill("SIGKILL");
            reject(
                new Error(
                    `the supervised command did not finish within ${WORKLOAD_TIMEOUT_MS}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
                ),
            );
        }, WORKLOAD_TIMEOUT_MS);
        child.once("close", (exitCode) => {
            clearTimeout(deadline);
            resolve(exitCode);
        });
    });
    return { code, stderr, stdout };
}
