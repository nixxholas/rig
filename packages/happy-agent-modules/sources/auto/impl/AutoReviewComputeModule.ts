import type {
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

/**
 * The private review system's inspection-only compute surface.
 *
 * Rig v1 exposed its reviewer a fixed, read-only slice of its coding tools — the file readers, the
 * directory and search tools, and the shell tools — so a review could gather evidence about local
 * state before deciding, exactly as Codex's guardian does. This module is the v2 equivalent: it
 * contributes that same fixed set and nothing else. There is no `write_file`, `edit_file`,
 * `delete_file`, or `move_file`, so a review can look but never change the workspace, and every
 * private send selects `read_only`, so the shell tools stay inside the sandbox that is the real
 * enforcement boundary for redirection and subprocesses.
 *
 * Deviation from the specification (deliberate, decided with the parent task): the read-only tools
 * are *injected* rather than constructed here. `AutoModule` imports no compute tool internals, so
 * the host supplies the reviewer array through `AutoModule`'s options, built from the real
 * `ComputeModule.reviewerTools`. The builder is called with the reviewer's own scope, so the vendor
 * of the reviewer's model route decides which fixed read-only array it receives — a Claude review
 * gets Claude's tools, a Codex review Codex's — exactly as Rig v1 gave its review side agent its own
 * provider's tools. This module only guarantees the array is presented unchanged and that nothing
 * widens it.
 */
export class AutoReviewComputeModule implements AgentModule {
    readonly name = "autoReviewCompute";

    /** Builds the reviewer's fixed read-only tools for the reviewer's own vendor, supplied by the host. */
    readonly #reviewerTools: (scope: AgentModuleScope) => readonly AnyAgentTool[];

    constructor(reviewerTools: (scope: AgentModuleScope) => readonly AnyAgentTool[]) {
        this.#reviewerTools = reviewerTools;
    }

    readonly #hooks: AgentModuleHooks = {
        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] =>
            this.#reviewerTools(scope),
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;
}
