import { afterEach, describe, expect, it, vi } from "vitest";

import type { InMemorySession } from "../../session/InMemorySession.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { HappySessionClient } from "../HappySessionClient.js";
import type { HappySyncRepository, HappySessionState } from "../HappySyncRepository.js";

describe("HappySessionClient idle synchronization", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("does not poll the repository or network after a successful idle sync", async () => {
        vi.useFakeTimers();
        const ctx = createTestRootContext().named("happy-idle-client");
        const state: HappySessionState = {
            credentialFingerprint: "account",
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: "dataKey",
            lastRemoteSeq: 0,
            remoteSessionId: "remote-1",
            sessionId: "session-1",
            tag: "rig:session-1",
        };
        const getSession = vi.fn(async () => state);
        const pending = vi.fn(async () => []);
        const repository = {
            acknowledge: vi.fn(),
            getSession,
            pending,
            setRemoteSession: vi.fn(),
            updateLastRemoteSeq: vi.fn(),
        } as unknown as HappySyncRepository;
        const request = vi.fn<typeof fetch>(async (input, init) =>
            String(input).endsWith("/v1/sessions") && init?.method === "POST"
                ? Response.json({
                      session: { id: "remote-1", metadataVersion: 0 },
                  })
                : Response.json({ hasMore: false, messages: [] }),
        );
        const socket = new IdleSocket();
        const client = new HappySessionClient({
            configuration: {
                credentials: {
                    encryption: {
                        machineKey: new Uint8Array(32).fill(10),
                        publicKey: new Uint8Array(32).fill(9),
                        type: "dataKey",
                    },
                    token: "token",
                },
                credentialsPath: "/rig/happy/access.key",
                happyHome: "/rig/happy",
                imported: false,
                serverUrl: "https://happy.test",
            },
            fetch: request,
            repository,
            session: idleSession(),
            socketFactory: () => socket,
        });

        client.start(ctx);
        for (let index = 0; index < 20; index += 1) await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(request).toHaveBeenCalled();
        const completedCounts = {
            getSession: getSession.mock.calls.length,
            pending: pending.mock.calls.length,
            request: request.mock.calls.length,
        };

        await vi.advanceTimersByTimeAsync(60_000);
        for (let index = 0; index < 10; index += 1) await Promise.resolve();

        expect({
            getSession: getSession.mock.calls.length,
            pending: pending.mock.calls.length,
            request: request.mock.calls.length,
        }).toEqual(completedCounts);
        await client.close(ctx);
    });
});

class IdleSocket {
    connected = true;

    connect(): void {}
    disconnect(): void {}

    emit(event: string, ...values: unknown[]): void {
        const callback = values.find((value) => typeof value === "function") as
            | ((answer: unknown) => void)
            | undefined;
        if (event === "update-metadata") callback?.({ result: "success", version: 1 });
    }

    on(): void {}
}

function idleSession(): InMemorySession {
    const snapshot = {
        agent: { type: "primary" },
        backgroundProcesses: [],
        cwd: "/workspace",
        effort: "high",
        mcpServers: [],
        modelId: "gpt-test",
        modelLocked: false,
        models: [],
        pendingUserInputs: [],
        permissionMode: "auto",
        providerId: "codex",
        scope: { kind: "unsorted" },
        skills: [],
        snapshot: { tools: [] },
        status: "idle",
        tasks: [],
        title: "Idle session",
        workflows: [],
    };
    return {
        activity: () => ({ kind: "idle", label: "Idle", since: 0 }),
        clientSnapshot: () => snapshot,
        events: { messageSubmission: () => undefined },
        id: "session-1",
    } as unknown as InMemorySession;
}
