import { createHash } from "node:crypto";

/** Identifies project instruction content so later turns can detect edits on disk. */
export function createAgentsMdFingerprint(instructions: string): string {
    return createHash("sha256").update(instructions, "utf8").digest("hex");
}
