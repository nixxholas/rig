import { BoundedOutputBuffer } from "../../processes/BoundedOutputBuffer.js";

export interface CappedOutput {
    text: string;
    totalBytes: number;
    omittedBytes: number;
}

export function capOutput(value: string, maxBytes: number | undefined): string {
    return capOutputWithMetadata(value, maxBytes).text;
}

export function capOutputWithMetadata(value: string, maxBytes: number | undefined): CappedOutput {
    const buffer = new BoundedOutputBuffer(maxBytes ?? Buffer.byteLength(value, "utf8"));
    buffer.append(Buffer.from(value, "utf8"));
    return {
        omittedBytes: buffer.omittedBytes,
        text: buffer.snapshot().toString("utf8"),
        totalBytes: buffer.totalBytes,
    };
}
