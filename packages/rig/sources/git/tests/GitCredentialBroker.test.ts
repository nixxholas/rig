import { request } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GitCredentialBroker } from "../GitCredentialBroker.js";

const creator = {
    instanceId: "aremoteinstance0000000001",
    profileId: "aprofile000000000000000006",
};

describe("GitCredentialBroker", () => {
    const brokers: GitCredentialBroker[] = [];

    afterEach(() => {
        for (const broker of brokers.splice(0)) broker.close();
    });

    it("keeps the real token in the broker while scoping its capability to one repository", async () => {
        const forward = vi.fn(async (input) => {
            input.response.writeHead(200, {
                "content-type": "application/x-git-upload-pack-result",
            });
            input.response.end("forwarded");
        });
        const broker = new GitCredentialBroker({ forward });
        brokers.push(broker);
        const authentication = await broker.register({
            creator,
            projectId: "aproject000000000000000001",
            repository: "slopus/rig",
            token: "github-secret-token",
        });
        const environment = JSON.stringify(authentication.environment);
        const prefix = (authentication.environment.GIT_CONFIG_KEY_1 ?? "")
            .replace("url.", "")
            .replace(".insteadOf", "");

        expect(environment).not.toContain("github-secret-token");
        expect(await send(`${prefix}/info/refs?service=git-upload-pack`)).toEqual({
            body: "forwarded",
            status: 200,
        });
        expect(forward).toHaveBeenCalledWith(
            expect.objectContaining({
                method: "GET",
                path: "/slopus/rig.git/info/refs?service=git-upload-pack",
                repository: "slopus/rig",
                token: "github-secret-token",
            }),
        );
        expect(
            await send(
                `${prefix.replace("/slopus/rig.git", "/someone/else.git")}/info/refs?service=git-upload-pack`,
            ),
        ).toEqual({
            body: "Git repository not found.",
            status: 404,
        });
        expect(
            broker.authentication("aproject000000000000000001", {
                ...creator,
                profileId: "aanotherprofile000000000001",
            }),
        ).toBeUndefined();

        const commandAuthentication = broker.authentication("aproject000000000000000001", creator);
        if (commandAuthentication === undefined) {
            throw new Error("Expected command-scoped Git authentication.");
        }
        const firstLease = commandAuthentication.activate();
        const commandPrefix = (firstLease.environment.GIT_CONFIG_KEY_1 ?? "")
            .replace("url.", "")
            .replace(".insteadOf", "");
        firstLease.release();
        expect(await send(`${commandPrefix}/info/refs?service=git-upload-pack`)).toEqual({
            body: "Git repository not found.",
            status: 404,
        });
        const secondLease = commandAuthentication.activate();
        const secondPrefix = (secondLease.environment.GIT_CONFIG_KEY_1 ?? "")
            .replace("url.", "")
            .replace(".insteadOf", "");
        expect(await send(`${secondPrefix}/info/refs?service=git-upload-pack`)).toEqual({
            body: "forwarded",
            status: 200,
        });
        expect(await send(`${commandPrefix}/info/refs?service=git-upload-pack`)).toEqual({
            body: "Git repository not found.",
            status: 404,
        });
        secondLease.release();
        expect(await send(`${secondPrefix}/info/refs?service=git-upload-pack`)).toEqual({
            body: "Git repository not found.",
            status: 404,
        });
    });

    it("rotates the in-memory token without changing the shell capability", async () => {
        const forward = vi.fn(async (input) => {
            input.response.end("ok");
        });
        const broker = new GitCredentialBroker({ forward });
        brokers.push(broker);
        const first = await broker.register({
            creator,
            projectId: "aproject000000000000000002",
            repository: "slopus/rig",
            token: "first-token",
        });
        const commandAuthentication = broker.authentication("aproject000000000000000002", creator);
        if (commandAuthentication === undefined) {
            throw new Error("Expected command-scoped Git authentication.");
        }
        const commandLease = commandAuthentication.activate();
        const commandPrefix = (commandLease.environment.GIT_CONFIG_KEY_1 ?? "")
            .replace("url.", "")
            .replace(".insteadOf", "");
        const second = await broker.register({
            creator,
            projectId: "aproject000000000000000002",
            repository: "slopus/rig",
            token: "second-token",
        });
        const prefix = (second.environment.GIT_CONFIG_KEY_1 ?? "")
            .replace("url.", "")
            .replace(".insteadOf", "");

        expect(second).toEqual(first);
        await send(`${prefix}/git-receive-pack`, "POST");
        expect(forward).toHaveBeenLastCalledWith(
            expect.objectContaining({ token: "second-token" }),
        );
        await send(`${commandPrefix}/git-receive-pack`, "POST");
        expect(forward).toHaveBeenLastCalledWith(
            expect.objectContaining({ token: "second-token" }),
        );
        commandLease.release();
        expect(await send(`${commandPrefix}/git-receive-pack`, "POST")).toEqual({
            body: "Git repository not found.",
            status: 404,
        });
    });

    it("revokes one project's in-memory credential and capability", async () => {
        const forward = vi.fn(async (input) => {
            input.response.end("ok");
        });
        const broker = new GitCredentialBroker({ forward });
        brokers.push(broker);
        const projectId = "aproject000000000000000004";
        const authentication = await broker.register({
            creator,
            projectId,
            repository: "slopus/rig",
            token: "revoked-token",
        });
        const prefix = (authentication.environment.GIT_CONFIG_KEY_1 ?? "")
            .replace("url.", "")
            .replace(".insteadOf", "");

        broker.revoke(projectId);

        expect(broker.authentication(projectId, creator)).toBeUndefined();
        expect(await send(`${prefix}/info/refs?service=git-upload-pack`)).toEqual({
            body: "Git repository not found.",
            status: 404,
        });
        expect(forward).not.toHaveBeenCalled();
    });

    it("drops every capability when the daemon-owned broker closes", async () => {
        const broker = new GitCredentialBroker();
        brokers.push(broker);
        const authentication = await broker.register({
            creator,
            projectId: "aproject000000000000000003",
            repository: "slopus/rig",
            token: "memory-only-token",
        });

        broker.close();

        expect(broker.authentication("aproject000000000000000003", creator)).toBeUndefined();
        await expect(
            broker.register({
                creator,
                projectId: "aproject000000000000000003",
                repository: "slopus/rig",
                token: "memory-only-token",
            }),
        ).rejects.toThrow("broker is closed");
        await expect(
            send(`http://127.0.0.1:${String(authentication.loopbackPort)}/unreachable`),
        ).rejects.toThrow();
    });
});

async function send(
    url: string,
    method: "GET" | "POST" = "GET",
): Promise<{ body: string; status: number }> {
    return await new Promise((resolve, reject) => {
        const outgoing = request(url, { method }, (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("end", () =>
                resolve({
                    body: Buffer.concat(chunks).toString("utf8"),
                    status: response.statusCode ?? 0,
                }),
            );
        });
        outgoing.once("error", reject);
        outgoing.end();
    });
}
