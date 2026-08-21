import { afterEach, describe, expect, it, vi } from "vitest";

import {
    decryptHappyPayload,
    encryptHappyPayload,
    HappyMachineClient,
} from "../../sources/happy/index.js";
import type {
    HappyConnectionConfiguration,
    HappyMachineRpcHandler,
    HappySocket,
} from "../../sources/happy/index.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

const KEY = Buffer.alloc(32, 9).toString("base64");
const CONFIGURATION: HappyConnectionConfiguration = {
    credentials: {
        encryption: { secret: new Uint8Array(Buffer.from(KEY, "base64")), type: "legacy" },
        token: "token",
    },
    credentialsPath: "/tmp/happy/access.key",
    happyHome: "/tmp/happy",
    imported: false,
    machineId: "machine-1",
    serverUrl: "https://api.happy.example",
};

function encode(value: unknown): string {
    return Buffer.from(
        encryptHappyPayload(new Uint8Array(Buffer.from(KEY, "base64")), "legacy", value),
    ).toString("base64");
}

function decode(value: string): unknown {
    return decryptHappyPayload(
        new Uint8Array(Buffer.from(KEY, "base64")),
        "legacy",
        new Uint8Array(Buffer.from(value, "base64")),
    );
}

class FakeSocket implements HappySocket {
    connected = true;
    readonly emitted: { event: string; value: unknown }[] = [];
    readonly #listeners = new Map<string, (...values: any[]) => void>();

    connect(): void {
        this.#listeners.get("connect")?.();
    }

    disconnect(): void {
        this.connected = false;
    }

    emit(event: string, ...values: unknown[]): void {
        this.emitted.push({ event, value: values[0] });
        const callback = values[1];
        if (typeof callback === "function") {
            (callback as (response: unknown) => void)({ result: "success", version: 1 });
        }
    }

    on(event: string, listener: (...values: any[]) => void): void {
        this.#listeners.set(event, listener);
    }

    async rpc(method: string, params: unknown): Promise<unknown> {
        const listener = this.#listeners.get("rpc-request");
        if (listener === undefined) throw new Error("The machine registered no RPC listener.");
        return await new Promise((resolve) => {
            listener({ method, params: encode(params) }, (response: string) =>
                resolve(decode(response)),
            );
        });
    }

    registrations(): unknown[] {
        return this.emitted
            .filter((event) => event.event === "rpc-register")
            .map((event) => event.value);
    }
}

function fakeFetch(): typeof fetch {
    return (async () =>
        Response.json({ machine: { daemonStateVersion: 0, metadataVersion: 0 } })) as typeof fetch;
}

function client(
    socket: FakeSocket,
    rpcHandlers: readonly HappyMachineRpcHandler[] = [],
): HappyMachineClient {
    return new HappyMachineClient({
        configuration: CONFIGURATION,
        context: store.context,
        fetch: fakeFetch(),
        models: () => [
            {
                defaultEffort: "medium",
                effortLevels: ["low", "medium", "high"],
                id: "gpt-5.6-sol",
                name: "GPT-5.6 Sol",
                providerId: "codex",
                serviceTiers: [],
            },
        ],
        operations: { spawnSession: async () => ({ agentId: "agent-1" }) },
        remoteSessionId: async () => undefined,
        rpcHandlers,
        socketFactory: () => socket,
        version: "1.2.3",
    });
}

let store: ModuleDatabase;

afterEach(() => {
    store.close();
});

describe("HappyMachineClient", () => {
    it("keeps the legacy session RPC as the only registration without extensions", async () => {
        store = moduleDatabase([], "happy-machine-client-legacy");
        const socket = new FakeSocket();
        const machine = client(socket);
        machine.start();

        await vi.waitFor(() => {
            expect(socket.registrations()).toEqual([{ method: "machine-1:spawn-happy-session" }]);
        });

        machine.close();
    });

    it("relays optional local extensions over Happy's existing encrypted machine RPC", async () => {
        store = moduleDatabase([], "happy-machine-client-duty");
        const socket = new FakeSocket();
        const calls: unknown[] = [];
        const machine = client(socket, [
            {
                method: "duty-status",
                handle: async (_ctx, params) => {
                    calls.push(params);
                    return { state: "active" };
                },
            },
        ]);
        machine.start();

        await vi.waitFor(() => {
            expect(socket.registrations()).toEqual([
                { method: "machine-1:spawn-happy-session" },
                { method: "machine-1:duty-status" },
            ]);
        });
        await expect(
            socket.rpc("machine-1:duty-status", { agentId: "remote-session-1" }),
        ).resolves.toEqual({
            state: "active",
        });
        expect(calls).toEqual([{ agentId: "remote-session-1" }]);
        await expect(socket.rpc("machine-1:unknown", {})).resolves.toMatchObject({ type: "error" });

        machine.close();
    });
});
