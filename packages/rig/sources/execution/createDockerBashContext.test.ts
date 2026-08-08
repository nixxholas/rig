import { PassThrough } from "node:stream";

import type Dockerode from "dockerode";
import { describe, expect, it, vi } from "vitest";

import type { BashSessionExit } from "../agent/context/BashContext.js";
import { createPermissionContext } from "../permissions/index.js";
import { SecretRegistry, SessionSecretContext } from "../secrets/index.js";
import { BASH_SESSION_STOP_GRACE_MS } from "../agent/context/bashSessionLimits.js";
import { createDockerBashContext } from "./createDockerBashContext.js";
import type { DockerEnvironment } from "./DockerEnvironment.js";

describe("createDockerBashContext", () => {
    it("does not start a prepared exec after the permission mode changes", async () => {
        const permissions = createPermissionContext("full_access");
        let releaseContainer!: () => void;
        const containerReleased = new Promise<void>((resolve) => {
            releaseContainer = resolve;
        });
        let markContainerRequested!: () => void;
        const containerRequested = new Promise<void>((resolve) => {
            markContainerRequested = resolve;
        });
        const start = vi.fn(async () => new PassThrough());
        const container = {
            async inspect() {
                return { Config: { Env: [] } };
            },
            async exec() {
                return {
                    inspect: async () => ({ ExitCode: 0 }),
                    start,
                };
            },
            modem: { demuxStream: vi.fn() },
        } as unknown as Dockerode.Container;
        const environment = {
            config: { workingDirectory: "/workspace" },
            container: async () => {
                markContainerRequested();
                await containerReleased;
                return container;
            },
        } as unknown as DockerEnvironment;
        const context = createDockerBashContext(environment, permissions);

        const pending = context.startSession({ command: "printf should-not-run" });
        await containerRequested;
        permissions.setMode("read_only");
        releaseContainer();

        await expect(pending).rejects.toThrow(
            "Permission mode changed before the command could start.",
        );
        expect(start).not.toHaveBeenCalled();
    });

    it("does not release an exec whose permission changes while Docker starts it", async () => {
        const permissions = createPermissionContext("full_access");
        let releaseStart!: () => void;
        const startReleased = new Promise<void>((resolve) => {
            releaseStart = resolve;
        });
        let markStartRequested!: () => void;
        const startRequested = new Promise<void>((resolve) => {
            markStartRequested = resolve;
        });
        const stream = new PassThrough();
        const write = vi.spyOn(stream, "write");
        const container = {
            async inspect() {
                return { Config: { Env: [] } };
            },
            async exec() {
                return {
                    inspect: async () => ({ ExitCode: 0 }),
                    async start() {
                        markStartRequested();
                        await startReleased;
                        return stream;
                    },
                };
            },
            modem: { demuxStream: vi.fn() },
        } as unknown as Dockerode.Container;
        const environment = {
            config: { workingDirectory: "/workspace" },
            container: async () => container,
        } as unknown as DockerEnvironment;
        const context = createDockerBashContext(environment, permissions);

        const pending = context.startSession({ command: "printf should-not-run" });
        await startRequested;
        permissions.setMode("read_only");
        releaseStart();

        await expect(pending).rejects.toThrow(
            "Permission mode changed before the command could start.",
        );
        expect(write).not.toHaveBeenCalled();
    });

    it("uses distinct pid files for contexts sharing a container", async () => {
        const fake = createFakeDockerEnvironment();
        const first = createDockerBashContext(
            fake.environment,
            createPermissionContext("full_access"),
        );
        const second = createDockerBashContext(
            fake.environment,
            createPermissionContext("full_access"),
        );

        await first.startSession({ command: "sleep 10" });
        await second.startSession({ command: "sleep 10" });

        const pidFiles = fake.foregroundCommands.map((command) => command[4]);
        expect(pidFiles).toHaveLength(2);
        expect(new Set(pidFiles).size).toBe(2);

        for (const stream of fake.foregroundStreams) stream.end();
        await Promise.all([
            first.readSession(1, { waitMs: 1_000 }),
            second.readSession(1, { waitMs: 1_000 }),
        ]);
    });

    it("applies the local backend's two-minute default to foreground runs", async () => {
        const fake = createFakeDockerEnvironment();
        const context = createDockerBashContext(
            fake.environment,
            createPermissionContext("full_access"),
        );
        const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

        try {
            const resultPromise = context.run({ command: "printf done" });
            await vi.waitFor(() => expect(fake.foregroundStreams).toHaveLength(1));

            expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 120_000)).toBe(true);
            fake.foregroundStreams[0]?.end();
            await expect(resultPromise).resolves.toMatchObject({ timedOut: false });
        } finally {
            timeoutSpy.mockRestore();
        }
    });

    it("finishes and reports an error when Docker exec inspection hangs", async () => {
        vi.useFakeTimers();
        try {
            const fake = createFakeDockerEnvironment([], () => new Promise(() => {}));
            const context = createDockerBashContext(
                fake.environment,
                createPermissionContext("full_access"),
            );
            await context.startSession({ command: "finish despite hung inspect" });
            fake.foregroundStreams[0]?.end();

            await vi.advanceTimersByTimeAsync(10_000);

            await expect(context.readSession(1)).resolves.toMatchObject({
                exitCode: null,
                status: "killed",
                stderr: expect.stringContaining("Timed out waiting for Docker command status."),
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps unread output deltas when capped buffers evict older bytes", async () => {
        const fake = createFakeDockerEnvironment();
        const context = createDockerBashContext(
            fake.environment,
            createPermissionContext("full_access"),
        );
        await context.startSession({ command: "stream output", maxOutputBytes: 5 });
        const stream = fake.foregroundStreams[0];
        stream?.write("abcde");

        await vi.waitFor(async () =>
            expect(await context.readSession(1)).toMatchObject({
                stdoutDelta: "ri\n... 10 bytes omitted ...\ncde",
                stdoutDeltaBytes: 15,
                stdoutDeltaOmittedBytes: 10,
            }),
        );
        stream?.write("fg");
        await vi.waitFor(async () =>
            expect(await context.readSession(1)).toMatchObject({ stdoutDelta: "fg" }),
        );

        stream?.end();
        await context.readSession(1, { waitMs: 1_000 });
    });

    it("sends SIGINT without completing the running session", async () => {
        const fake = createFakeDockerEnvironment();
        const context = createDockerBashContext(
            fake.environment,
            createPermissionContext("full_access"),
        );
        await context.startSession({ command: "interactive command" });

        await expect(context.interruptSession?.(1)).resolves.toBe(true);

        expect(fake.controlCommands).toHaveLength(1);
        expect(fake.controlCommands[0]?.join(" ")).toContain("kill -INT");
        await expect(context.readSession(1)).resolves.toMatchObject({ status: "running" });

        fake.foregroundStreams[0]?.end();
        await context.readSession(1, { waitMs: 1_000 });
    });

    it("reports an unobserved background command exit", async () => {
        const fake = createFakeDockerEnvironment();
        const context = createDockerBashContext(
            fake.environment,
            createPermissionContext("full_access"),
        );
        const exits: BashSessionExit[] = [];
        context.setSessionExitListener?.((exit) => exits.push(exit));

        await context.startSession({ command: "background command" });
        fake.foregroundStreams[0]?.end();

        await vi.waitFor(() =>
            expect(exits).toEqual([
                {
                    command: "background command",
                    exitCode: 0,
                    sessionId: 1,
                    status: "completed",
                },
            ]),
        );
    });

    it("does not report an exit a consuming reader is waiting to observe", async () => {
        const fake = createFakeDockerEnvironment();
        const context = createDockerBashContext(
            fake.environment,
            createPermissionContext("full_access"),
        );
        const exits: BashSessionExit[] = [];
        context.setSessionExitListener?.((exit) => exits.push(exit));

        await context.startSession({ command: "observed command" });
        const reading = context.readSession(1, { waitMs: 1_000 });
        fake.foregroundStreams[0]?.end();

        await expect(reading).resolves.toMatchObject({ status: "completed" });
        expect(exits).toEqual([]);
    });

    it("uses the shared graceful-stop interval before forcing a Docker command", async () => {
        const fake = createFakeDockerEnvironment();
        const context = createDockerBashContext(
            fake.environment,
            createPermissionContext("full_access"),
        );
        const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
        try {
            await context.startSession({ command: "background command" });
            await context.killSession(1);

            expect(
                timeoutSpy.mock.calls.some(([, delay]) => delay === BASH_SESSION_STOP_GRACE_MS),
            ).toBe(true);
        } finally {
            timeoutSpy.mockRestore();
        }
    });

    it("handles container lookup failures while aborting a foreground run", async () => {
        const fake = createFakeDockerEnvironment();
        let containerRequests = 0;
        const environment = {
            config: { workingDirectory: "/workspace" },
            container: async () => {
                containerRequests += 1;
                if (containerRequests === 1) return fake.container;
                throw new Error("Docker socket unavailable during abort.");
            },
        } as unknown as DockerEnvironment;
        const context = createDockerBashContext(
            environment,
            createPermissionContext("full_access"),
        );
        const controller = new AbortController();
        const resultPromise = context.run({ command: "sleep 10", signal: controller.signal });
        await vi.waitFor(() => expect(fake.foregroundStreams).toHaveLength(1));

        controller.abort();

        await expect(resultPromise).resolves.toMatchObject({
            stderr: "Docker socket unavailable during abort.",
        });
    });

    it("passes only selected attached bundles through Docker exec", async () => {
        const fake = createFakeDockerEnvironment(["service_token=ambient-secret"]);
        const registry = new SecretRegistry([
            {
                description: "Service credentials",
                environment: {
                    SERVICE_REGION: "docker-region",
                    SERVICE_TOKEN: "docker-secret",
                },
                id: "service",
            },
            {
                description: "Database credentials",
                environment: { DATABASE_URL: "docker-database" },
                id: "database",
            },
        ]);
        const secrets = new SessionSecretContext(registry, ["service"], ["database"]);
        const context = createDockerBashContext(
            fake.environment,
            createPermissionContext("full_access"),
            secrets,
        );

        await context.startSession({ command: "secrets-omitted" });
        fake.foregroundStreams[0]?.end();
        await context.readSession(1, { waitMs: 1_000 });

        await context.startSession({ command: "secrets-empty", secrets: [] });
        fake.foregroundStreams[1]?.end();
        await context.readSession(2, { waitMs: 1_000 });

        await context.startSession({ command: "service-secret", secrets: ["service"] });
        fake.foregroundStreams[2]?.end();
        await context.readSession(3, { waitMs: 1_000 });

        await context.startSession({
            command: "all-selected-secrets",
            secrets: ["service", "database"],
        });

        expect(fake.foregroundEnvironments).toEqual([
            ["SERVICE_REGION=", "SERVICE_TOKEN=", "DATABASE_URL=", "service_token="],
            ["SERVICE_REGION=", "SERVICE_TOKEN=", "DATABASE_URL=", "service_token="],
            [
                "SERVICE_REGION=docker-region",
                "SERVICE_TOKEN=docker-secret",
                "DATABASE_URL=",
                "service_token=",
            ],
            [
                "SERVICE_REGION=docker-region",
                "SERVICE_TOKEN=docker-secret",
                "DATABASE_URL=docker-database",
                "service_token=",
            ],
        ]);
        expect(fake.foregroundCommands[3]).not.toContain("docker-secret");
        expect(fake.foregroundCommands[3]).not.toContain("docker-database");
        fake.foregroundStreams[3]?.end();
        await context.readSession(4, { waitMs: 1_000 });
    });
});

function createFakeDockerEnvironment(
    environmentVariables: readonly string[] = [],
    inspectForeground: () => Promise<{ ExitCode: number | null }> = async () => ({
        ExitCode: 0,
    }),
): {
    container: Dockerode.Container;
    controlCommands: string[][];
    environment: DockerEnvironment;
    foregroundCommands: string[][];
    foregroundEnvironments: string[][];
    foregroundStreams: PassThrough[];
} {
    const controlCommands: string[][] = [];
    const foregroundCommands: string[][] = [];
    const foregroundEnvironments: string[][] = [];
    const foregroundStreams: PassThrough[] = [];
    const container = {
        async inspect() {
            return { Config: { Env: [...environmentVariables] } };
        },
        async exec(options: { AttachStdin?: boolean; Cmd?: string[]; Env?: string[] }) {
            const stream = new PassThrough();
            if (options.AttachStdin === true) {
                foregroundCommands.push(options.Cmd ?? []);
                foregroundEnvironments.push(options.Env ?? []);
                foregroundStreams.push(stream);
            } else {
                controlCommands.push(options.Cmd ?? []);
                queueMicrotask(() => stream.end());
            }
            return {
                inspect:
                    options.AttachStdin === true
                        ? inspectForeground
                        : async () => ({
                              ExitCode: 0,
                          }),
                start: async () => stream,
            };
        },
        modem: {
            demuxStream(
                stream: NodeJS.ReadableStream,
                stdout: NodeJS.WritableStream,
                _stderr: NodeJS.WritableStream,
            ) {
                stream.pipe(stdout);
            },
        },
    } as unknown as Dockerode.Container;
    return {
        container,
        controlCommands,
        environment: {
            config: { workingDirectory: "/workspace" },
            container: async () => container,
        } as unknown as DockerEnvironment,
        foregroundCommands,
        foregroundEnvironments,
        foregroundStreams,
    };
}
