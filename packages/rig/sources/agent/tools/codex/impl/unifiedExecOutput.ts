import { Type, type Static } from "@sinclair/typebox";

import type { BashSessionSnapshot } from "../../../index.js";
import { BoundedOutputBuffer } from "../../../../processes/index.js";

export const CODEX_EXEC_CAPTURE_MAX_BYTES = 1024 * 1024;

export const unifiedExecOutputSchema = Type.Object({
    chunk_id: Type.Optional(Type.String()),
    command: Type.Optional(Type.String()),
    exit_code: Type.Optional(Type.Number()),
    original_token_count: Type.Optional(Type.Number()),
    output: Type.String(),
    session_id: Type.Optional(Type.Number()),
    wall_time_seconds: Type.Number(),
});

export type UnifiedExecOutput = Static<typeof unifiedExecOutputSchema>;

export function formatUnifiedExecOutput(result: UnifiedExecOutput): string {
    const sections: string[] = [];
    if (result.chunk_id !== undefined) sections.push(`Chunk ID: ${result.chunk_id}`);
    sections.push(`Wall time: ${result.wall_time_seconds.toFixed(4)} seconds`);
    if (result.exit_code !== undefined) {
        sections.push(`Process exited with code ${result.exit_code}`);
    }
    if (result.session_id !== undefined) {
        sections.push(`Process running with session ID ${result.session_id}`);
    }
    if (result.original_token_count !== undefined) {
        sections.push(`Original token count: ${result.original_token_count}`);
    }
    sections.push("Output:", result.output);
    return sections.join("\n");
}

export function createUnifiedExecOutput(
    snapshot: BashSessionSnapshot,
    wallTimeSeconds: number,
    maxOutputTokens = 10_000,
): UnifiedExecOutput {
    const capturedOutput = new BoundedOutputBuffer(CODEX_EXEC_CAPTURE_MAX_BYTES);
    if (snapshot.stdoutDelta.length > 0) {
        capturedOutput.append(Buffer.from(snapshot.stdoutDelta, "utf8"));
    }
    if (snapshot.stderrDelta.length > 0) {
        if (capturedOutput.totalBytes > 0) capturedOutput.append(Buffer.from("\n", "utf8"));
        capturedOutput.append(Buffer.from(snapshot.stderrDelta, "utf8"));
    }
    const rawOutput = capturedOutput.snapshot().toString("utf8");
    const originalBytes =
        (snapshot.stdoutDeltaBytes ?? Buffer.byteLength(snapshot.stdoutDelta, "utf8")) +
        (snapshot.stderrDeltaBytes ?? Buffer.byteLength(snapshot.stderrDelta, "utf8"));
    const maxCharacters = Math.max(4_000, maxOutputTokens * 4);
    const output = truncateUnifiedExecOutput(
        rawOutput,
        maxCharacters,
        Math.ceil(originalBytes / 4),
    );
    return {
        command: snapshot.command,
        ...(snapshot.status === "running" ? { session_id: snapshot.sessionId } : {}),
        ...(snapshot.status !== "running" && snapshot.exitCode !== null
            ? { exit_code: snapshot.exitCode }
            : {}),
        original_token_count: Math.ceil(originalBytes / 4),
        output,
        wall_time_seconds: wallTimeSeconds,
    };
}

function truncateUnifiedExecOutput(
    value: string,
    maxCharacters: number,
    originalTokenCount: number,
): string {
    if (value.length <= maxCharacters) return value;
    const notice = `Warning: truncated output (original token count: ${String(originalTokenCount)})`;
    const lineCount = value.length === 0 ? 0 : value.split("\n").length;
    const prefix = `${notice}\nTotal output lines: ${String(lineCount)}\n\n`;
    const marker = "\n… output truncated …\n";
    const remaining = Math.max(0, maxCharacters - prefix.length - marker.length);
    const headLength = Math.ceil(remaining / 2);
    const tailLength = Math.max(0, remaining - headLength);
    return `${prefix}${value.slice(0, headLength)}${marker}${tailLength > 0 ? value.slice(-tailLength) : ""}`;
}
