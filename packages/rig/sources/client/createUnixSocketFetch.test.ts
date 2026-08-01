import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestSocketDirectory } from "../testing/createTestSocketDirectory.js";
import { createUnixSocketFetch } from "./createUnixSocketFetch.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("createUnixSocketFetch", () => {
    it("carries ordinary fetch requests and streaming responses over a Unix socket", async () => {
        const directory = await createTestSocketDirectory();
        const socketPath = join(directory, "server.sock");
        let received = "";
        const server = createServer((request, response) => {
            request.setEncoding("utf8");
            request.on("data", (chunk: string) => {
                received += chunk;
            });
            request.on("end", () => {
                expect(request.method).toBe("POST");
                expect(request.url).toBe("/events/stream?after=7");
                expect(request.headers.authorization).toBe("Bearer secret");
                response.writeHead(202, { "content-type": "text/plain", "x-rig": "connected" });
                response.write("first");
                setImmediate(() => response.end("-second"));
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
        });
        cleanups.push(
            () =>
                new Promise<void>((resolve) =>
                    server.close(() => {
                        void rm(directory, { force: true, recursive: true }).then(() => resolve());
                    }),
                ),
        );

        const request = createUnixSocketFetch(socketPath);
        const response = await request("http://rig.local/events/stream?after=7", {
            body: JSON.stringify({ hello: "world" }),
            headers: { authorization: "Bearer secret" },
            method: "POST",
        });

        expect(response.status).toBe(202);
        expect(response.headers.get("x-rig")).toBe("connected");
        expect(await response.text()).toBe("first-second");
        expect(received).toBe('{"hello":"world"}');
    });
});
