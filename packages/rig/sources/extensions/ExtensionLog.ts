import { createWriteStream, type WriteStream } from "node:fs";

const DEFAULT_MAX_EXTENSION_LOG_BYTES = 1024 * 1024;
const TRUNCATION_NOTICE = Buffer.from(
    "\n[Rig stopped recording this extension after 1 MiB of output.]\n",
);

export class ExtensionLog {
    readonly path: string;

    readonly #maximumBytes: number;
    readonly #stream: WriteStream;
    #bytesWritten = 0;
    #failed = false;
    #truncated = false;

    constructor(options: { maximumBytes?: number; path: string }) {
        this.path = options.path;
        this.#maximumBytes = options.maximumBytes ?? DEFAULT_MAX_EXTENSION_LOG_BYTES;
        this.#stream = createWriteStream(options.path, { flags: "wx", mode: 0o600 });
        this.#stream.on("error", () => {
            this.#failed = true;
        });
    }

    append(source: "stderr" | "stdout", chunk: Buffer): void {
        if (this.#failed || this.#truncated || chunk.length === 0) return;
        const prefix = Buffer.from(`[${source}] `);
        const available = this.#maximumBytes - this.#bytesWritten;
        if (available <= prefix.length) {
            this.#truncate();
            return;
        }
        const content = chunk.subarray(0, Math.max(0, available - prefix.length));
        const output = Buffer.concat([prefix, content]);
        this.#bytesWritten += output.length;
        this.#stream.write(output);
        if (content.length < chunk.length) this.#truncate();
    }

    close(): Promise<void> {
        if (this.#stream.closed || this.#stream.destroyed) return Promise.resolve();
        return new Promise<void>((resolve) => {
            this.#stream.once("close", resolve);
            this.#stream.end(resolve);
        });
    }

    #truncate(): void {
        if (this.#truncated) return;
        this.#truncated = true;
        const available = this.#maximumBytes - this.#bytesWritten;
        if (available <= 0) return;
        const notice = TRUNCATION_NOTICE.subarray(0, available);
        this.#bytesWritten += notice.length;
        this.#stream.write(notice);
    }
}
