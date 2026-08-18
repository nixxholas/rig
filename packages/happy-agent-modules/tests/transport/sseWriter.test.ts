import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createSseWriter } from "../../sources/transport/sseWriter.js";
import { describe, expect, it } from "vitest";

describe("Happy Agent SSE writer", () => {
    it("waits for drain and preserves whole-frame order", () => {
        const request = new EventEmitter() as IncomingMessage;
        const response = new FakeResponse([false, true, true]);
        const writer = createSseWriter(request, response.asServerResponse());

        expect(writer.write("one\n\n")).toBe(true);
        expect(writer.write("two\n\n")).toBe(true);
        expect(writer.write("three\n\n")).toBe(true);
        expect(response.writes).toEqual(["one\n\n"]);

        response.emit("drain");
        expect(response.writes).toEqual(["one\n\n", "two\n\n", "three\n\n"]);
        writer.close();
    });

    it("disconnects instead of growing its pending queue without drain", async () => {
        const request = new EventEmitter() as IncomingMessage;
        const response = new FakeResponse([false]);
        const writer = createSseWriter(request, response.asServerResponse(), {
            maxBufferedBytes: 8,
        });

        expect(writer.write("blocked\n\n")).toBe(true);
        expect(writer.write("1234")).toBe(true);
        expect(writer.write("56789")).toBe(false);
        await writer.done;
        expect(writer.closed).toBe(true);
        expect(response.destroyed).toBe(true);

        response.emit("drain");
        expect(response.writes).toEqual(["blocked\n\n"]);
    });
});

class FakeResponse extends EventEmitter {
    destroyed = false;
    headersSent = true;
    writableEnded = false;
    writableLength = 0;
    readonly writes: string[] = [];
    readonly #results: boolean[];

    constructor(results: boolean[]) {
        super();
        this.#results = [...results];
    }

    asServerResponse(): ServerResponse {
        return this as unknown as ServerResponse;
    }

    write(frame: string): boolean {
        this.writes.push(frame);
        this.writableLength = Buffer.byteLength(frame);
        return this.#results.shift() ?? true;
    }

    end(): void {
        this.writableEnded = true;
        this.emit("finish");
    }

    destroy(): void {
        this.destroyed = true;
        this.emit("close");
    }
}
