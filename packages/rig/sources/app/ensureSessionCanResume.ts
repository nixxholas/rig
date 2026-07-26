import type { ProtocolSession } from "../protocol/index.js";
import { RigUserError } from "../RigUserError.js";

export function ensureSessionCanResume(session: ProtocolSession): void {
    if (session.agent.type === "subagent") {
        throw new RigUserError("Subagent histories are read-only.", {
            hint: "Open the parent session to see this work.",
        });
    }
}
