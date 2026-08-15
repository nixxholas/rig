import type { BashContext, BashSessionSnapshot } from "../../agent/index.js";
import { BoundedOutputBuffer } from "../../processes/index.js";

const PROGRESS_POLL_MS = 100;
const MAX_PROGRESS_DISPLAY_CHARACTERS = 2_000;

export async function readSessionWithProgress(options: {
    bash: BashContext;
    onProgress?: (display: string) => void;
    sessionId: number;
    signal?: AbortSignal;
    maxOutputBytes?: number;
    waitMs?: number;
}): Promise<BashSessionSnapshot | undefined> {
    const deadline = options.waitMs === undefined ? undefined : Date.now() + options.waitMs;
    let stderrDelta = "";
    let stdoutDelta = "";
    let stderrDeltaBytes = 0;
    let stderrDeltaOmittedBytes = 0;
    let stdoutDeltaBytes = 0;
    let stdoutDeltaOmittedBytes = 0;
    let lastProgressDisplay = "";
    let snapshot: BashSessionSnapshot | undefined;
    const boundedStdout =
        options.maxOutputBytes === undefined
            ? undefined
            : new BoundedOutputBuffer(options.maxOutputBytes);
    const boundedStderr =
        options.maxOutputBytes === undefined
            ? undefined
            : new BoundedOutputBuffer(options.maxOutputBytes);

    do {
        const remaining =
            deadline === undefined ? PROGRESS_POLL_MS : Math.max(0, deadline - Date.now());
        snapshot = await options.bash.readSession(options.sessionId, {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            waitMs: Math.min(PROGRESS_POLL_MS, remaining),
        });
        if (snapshot === undefined) return undefined;
        stdoutDeltaBytes +=
            snapshot.stdoutDeltaBytes ?? Buffer.byteLength(snapshot.stdoutDelta, "utf8");
        stderrDeltaBytes +=
            snapshot.stderrDeltaBytes ?? Buffer.byteLength(snapshot.stderrDelta, "utf8");
        stdoutDeltaOmittedBytes += snapshot.stdoutDeltaOmittedBytes ?? 0;
        stderrDeltaOmittedBytes += snapshot.stderrDeltaOmittedBytes ?? 0;
        if (boundedStdout === undefined) {
            stdoutDelta += snapshot.stdoutDelta;
        } else {
            boundedStdout.append(Buffer.from(snapshot.stdoutDelta, "utf8"));
            stdoutDelta = boundedStdout.snapshot().toString("utf8");
        }
        if (boundedStderr === undefined) {
            stderrDelta += snapshot.stderrDelta;
        } else {
            boundedStderr.append(Buffer.from(snapshot.stderrDelta, "utf8"));
            stderrDelta = boundedStderr.snapshot().toString("utf8");
        }
        const progress = [stdoutDelta, stderrDelta].filter(Boolean).join("\n");
        const progressDisplay = progress.slice(0, MAX_PROGRESS_DISPLAY_CHARACTERS);
        if (progressDisplay.length > 0 && progressDisplay !== lastProgressDisplay) {
            lastProgressDisplay = progressDisplay;
            options.onProgress?.(progressDisplay);
        }
        if (
            snapshot.status !== "running" ||
            options.signal?.aborted ||
            (deadline !== undefined && remaining === 0)
        ) {
            break;
        }
    } while (deadline === undefined || Date.now() < deadline);

    return snapshot === undefined
        ? undefined
        : {
              ...snapshot,
              stderrDelta,
              stderrDeltaBytes,
              stderrDeltaOmittedBytes: stderrDeltaOmittedBytes + (boundedStderr?.omittedBytes ?? 0),
              stdoutDelta,
              stdoutDeltaBytes,
              stdoutDeltaOmittedBytes: stdoutDeltaOmittedBytes + (boundedStdout?.omittedBytes ?? 0),
          };
}
