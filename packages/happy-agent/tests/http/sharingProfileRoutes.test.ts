import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";

import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import {
    listRigProfilesResponseSchema,
    rigProfileResponseSchema,
} from "../../../rig/sources/protocol/ProfileProtocol.js";
import {
    AgentProviders,
    startHappyAgentDaemon,
    type AgentModel,
    type HappyAgentDaemon,
} from "../../sources/index.js";

type HttpCall = (
    method: "DELETE" | "GET" | "PATCH" | "POST",
    path: string,
    body?: unknown,
) => Promise<{ readonly status: number; readonly body: Record<string, never> }>;

const running = new Set<{ readonly daemon: HappyAgentDaemon; readonly directory: string }>();

afterEach(async () => {
    await Promise.all(
        [...running].map(async ({ daemon, directory }) => {
            await daemon.close().catch(() => undefined);
            await rm(directory, { force: true, recursive: true });
        }),
    );
    running.clear();
});

describe("the person this installation belongs to", () => {
    it("has nobody until one is named, and then exactly one", async () => {
        const { call } = await startTestDaemon();

        const empty = await call("GET", "/v0/profiles");
        expect(empty.status).toBe(200);
        expect(empty.body).toEqual({ profiles: [] });
        expect(Value.Check(listRigProfilesResponseSchema, empty.body)).toBe(true);

        const created = await call("POST", "/v0/profiles", {
            email: "ada@example.com",
            name: "Ada Lovelace",
        });
        expect(created.status).toBe(201);
        expect(Value.Check(rigProfileResponseSchema, created.body)).toBe(true);
        expect(created.body).toMatchObject({
            profile: { email: "ada@example.com", name: "Ada Lovelace", version: 1 },
        });

        const listed = await call("GET", "/v0/profiles");
        expect(Value.Check(listRigProfilesResponseSchema, listed.body)).toBe(true);
        expect(listed.body).toEqual({ profiles: [profile(created.body)] });

        const second = await call("POST", "/v0/profiles", {
            email: "grace@example.com",
            name: "Grace Hopper",
        });
        expect(second.status).toBe(409);
        expect(second.body).toEqual({ error: "This installation already has a profile." });
    });

    it("versions every change and refuses a profile it does not have", async () => {
        const { call } = await startTestDaemon();
        const created = await call("POST", "/v0/profiles", {
            email: "ada@example.com",
            name: "Ada Lovelace",
        });
        const id = profile(created.body).id;

        const renamed = await call("PATCH", `/v0/profiles/${id}`, { name: "Ada King" });
        expect(renamed.status).toBe(200);
        expect(Value.Check(rigProfileResponseSchema, renamed.body)).toBe(true);
        expect(profile(renamed.body)).toMatchObject({ name: "Ada King", version: 2 });

        const read = await call("GET", `/v0/profiles/${id}`);
        expect(profile(read.body)).toMatchObject({ name: "Ada King", version: 2 });

        await expect(call("PATCH", "/v0/profiles/nobody", { name: "Nobody" })).resolves.toEqual({
            body: { error: "Rig profile not found." },
            status: 404,
        });
        await expect(call("GET", "/v0/profiles/nobody")).resolves.toEqual({
            body: { error: "Rig profile not found." },
            status: 404,
        });
    });

    it("refuses a name or an address it cannot use", async () => {
        const { call } = await startTestDaemon();

        for (const body of [
            { email: "not-an-address", name: "Ada Lovelace" },
            { email: "ada@example.com", name: "" },
            { email: "ada@example.com", name: "Ada\u202eLovelace" },
        ]) {
            const answer = await call("POST", "/v0/profiles", body);
            expect(answer.status).toBe(400);
        }
        await expect(call("GET", "/v0/profiles")).resolves.toMatchObject({
            body: { profiles: [] },
        });
    });
});

describe("sharing while the configuration leaves it off", () => {
    it("says so on every route rather than pretending to be empty", async () => {
        const { call } = await startTestDaemon();
        const unavailable = { body: { error: "Sharing is unavailable." }, status: 503 };
        const identity = "A".repeat(43);

        await expect(call("GET", "/v0/sharing")).resolves.toEqual(unavailable);
        await expect(call("DELETE", "/v0/sharing")).resolves.toEqual(unavailable);
        await expect(call("POST", "/v0/sharing/invitations")).resolves.toEqual(unavailable);
        await expect(
            call("POST", "/v0/sharing/contact-requests", { invitation: identity }),
        ).resolves.toEqual(unavailable);
        await expect(
            call("POST", "/v0/sharing/contact-requests/anything/accept"),
        ).resolves.toEqual(unavailable);
        await expect(call("DELETE", "/v0/sharing/contact-requests/anything")).resolves.toEqual(
            unavailable,
        );
        await expect(call("DELETE", `/v0/sharing/contacts/${identity}`)).resolves.toEqual(
            unavailable,
        );
    });

    it("still refuses a method no sharing route serves", async () => {
        const { call } = await startTestDaemon();

        await expect(call("PATCH", "/v0/sharing")).resolves.toMatchObject({ status: 405 });
    });
});

function profile(body: Record<string, never>): {
    readonly id: string;
    readonly name: string;
    readonly version: number;
} {
    const value = (body as { readonly profile?: unknown }).profile;
    if (value === null || typeof value !== "object") {
        throw new Error("The Happy agent answered without a profile.");
    }
    return value as { readonly id: string; readonly name: string; readonly version: number };
}

async function startTestDaemon(): Promise<{ readonly call: HttpCall }> {
    const scratch = resolve(import.meta.dirname, "../../../../.context");
    await mkdir(scratch, { recursive: true });
    const directory = await realpath(await mkdtemp(join(scratch, "ha-sharing-")));
    const providers = new AgentProviders();
    providers.add("scripted", scriptedProvider(), "gym");
    const models: readonly AgentModel[] = [
        {
            defaultEffort: "medium",
            effortLevels: ["low", "medium", "high"],
            id: "scripted-model",
            name: "Scripted Model",
            providerId: "scripted",
        },
    ];
    const daemon = await startHappyAgentDaemon({
        happyHome: join(directory, ".happy"),
        inference: { models, providers },
        version: "sharing-route-test",
    });
    running.add({ daemon, directory });
    const token = (await readFile(daemon.tokenPath, "utf8")).trim();
    return { call: createCall(daemon.socketPath, token) };
}

function createCall(socketPath: string, token: string): HttpCall {
    return async (method, path, body) =>
        await new Promise((settle, reject) => {
            const payload =
                body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
            const request = httpRequest(
                {
                    headers: {
                        accept: "application/json",
                        authorization: `Bearer ${token}`,
                        ...(payload === undefined
                            ? {}
                            : {
                                  "content-length": String(payload.byteLength),
                                  "content-type": "application/json",
                              }),
                    },
                    method,
                    path,
                    socketPath,
                },
                (response) => {
                    const chunks: Buffer[] = [];
                    response.on("data", (chunk: Buffer) => chunks.push(chunk));
                    response.on("error", reject);
                    response.on("end", () => {
                        const text = Buffer.concat(chunks).toString("utf8");
                        settle({
                            body: (text.length === 0
                                ? {}
                                : JSON.parse(text)) as Record<string, never>,
                            status: response.statusCode ?? 500,
                        });
                    });
                },
            );
            request.on("error", reject);
            if (payload !== undefined) request.write(payload);
            request.end();
        });
}

function scriptedProvider(): Parameters<AgentProviders["add"]>[1] {
    return {
        inputTypes: ["text"],
        name: "scripted",
        outputTypes: ["text"],
        session: async (id: string) => ({
            id,
            compact: async () => {
                throw new Error("Compaction is unavailable in this test.");
            },
            destroy: () => undefined,
            run: () =>
                (async function* () {
                    yield { type: "done", state: "normal" } as const;
                })(),
        }),
    } as never;
}
