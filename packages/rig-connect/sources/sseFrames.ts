export interface SseFrame {
    data: unknown;
    name: string | undefined;
    /** The frame's `id:` line, when it carried one. */
    id: string | undefined;
}

/**
 * Reads Server-Sent Events out of a byte stream.
 *
 * Framing is handled here rather than at each call site because the details are
 * easy to get subtly wrong: a line may end with a carriage return, a newline, or
 * both, and a stream that ends without a trailing blank line still delivered a
 * whole final frame.
 */
export async function* readSseFrames(body: ReadableStream<BufferSource>): AsyncGenerator<SseFrame> {
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                const last = parseFrame(normalizeLineEndings(buffer));
                if (last !== undefined) yield last;
                return;
            }
            buffer = normalizeFrameBuffer(buffer + value);
            for (;;) {
                const boundary = buffer.indexOf("\n\n");
                if (boundary < 0) break;
                const raw = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const frame = parseFrame(raw);
                if (frame !== undefined) yield frame;
            }
        }
    } finally {
        reader.cancel().catch(() => undefined);
    }
}

/**
 * Rewrites a partly-read buffer so frames are separated by one blank line.
 *
 * A trailing carriage return is held back because the next chunk may begin with
 * the newline that completes it.
 */
function normalizeFrameBuffer(buffer: string): string {
    if (!buffer.endsWith("\r")) return normalizeLineEndings(buffer);
    return `${normalizeLineEndings(buffer.slice(0, -1))}\r`;
}

function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n?/g, "\n");
}

function parseFrame(raw: string): SseFrame | undefined {
    if (raw.length === 0 || raw.startsWith(":")) return undefined;
    const lines = raw.split("\n");
    const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart());
    if (data.length === 0) return undefined;
    return {
        data: JSON.parse(data.join("\n")),
        id: lines
            .find((line) => line.startsWith("id:"))
            ?.slice("id:".length)
            .trim(),
        name: lines
            .find((line) => line.startsWith("event:"))
            ?.slice("event:".length)
            .trim(),
    };
}
