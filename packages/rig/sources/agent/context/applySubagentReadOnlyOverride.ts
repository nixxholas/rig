import type { SubagentContext } from "./SubagentContext.js";

export async function applySubagentReadOnlyOverride(
    subagents: SubagentContext,
    target: string,
    readOnly: boolean | undefined,
): Promise<void> {
    if (readOnly === undefined) return;
    if (subagents.setReadOnly === undefined) {
        throw new Error("Subagent permission switching is unavailable in this session.");
    }
    await subagents.setReadOnly(target, readOnly);
}
