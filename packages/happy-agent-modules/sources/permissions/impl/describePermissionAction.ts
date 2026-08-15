import type { AnyAgentTool } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

/**
 * What a reviewer is deciding on, in words.
 *
 * A tool that can ask for a review owes a description of the exact action and the boundary it
 * crosses, because a decision made about "the tool ran" is not a decision about anything. When one
 * is missing or fails to produce a description, the call is still described — as far as it can be
 * from outside the tool — rather than put to the reviewer as nothing at all.
 */
export function describePermissionAction(tool: AnyAgentTool, args: unknown, ctx: Context): string {
    const name = tool.namespace === undefined ? tool.name : `${tool.namespace}/${tool.name}`;
    try {
        const described = tool.describeAutoPermissionAction?.(args, ctx);
        if (described !== undefined && described.trim().length > 0) return described;
    } catch {
        // A tool that cannot describe its own action still has to be decided about.
    }
    return `Run the tool "${name}" with the arguments ${JSON.stringify(args) ?? "it was given"}.`;
}
