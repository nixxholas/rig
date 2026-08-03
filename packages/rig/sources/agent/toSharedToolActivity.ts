import type { SharedToolActivity } from "./SharedToolActivity.js";
import type { AnyDefinedTool } from "./types.js";

/**
 * Asks a tool what a replicated transcript may say about one call or result.
 *
 * The summary is derived here, once, while the tool that owns it is still in
 * hand. The projection that publishes a shared entry runs much later, in
 * persistence, against a stored message and no tool array at all — so it can
 * only read what was recorded at this moment. Anything a tool declines to
 * describe stays undescribed rather than being reconstructed from its name.
 *
 * A tool that throws while summarizing loses its summary and its disclosure,
 * because a summary Rig could not produce is not one it can vouch for.
 */
export function toSharedToolActivity(
    tool: AnyDefinedTool,
    summarize: () => string | undefined,
): SharedToolActivity | undefined {
    let summary: string | undefined;
    try {
        summary = summarize();
    } catch {
        return undefined;
    }
    const trimmed = typeof summary === "string" ? summary.trim() : "";
    const activity: SharedToolActivity = {
        ...(trimmed === "" ? {} : { summary: trimmed }),
        ...(tool.sharedOutputDisclosable ? { disclosable: true as const } : {}),
    };
    return activity.summary === undefined && activity.disclosable === undefined
        ? undefined
        : activity;
}
