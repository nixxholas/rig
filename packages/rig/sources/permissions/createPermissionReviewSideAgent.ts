import { Agent } from "../agent/Agent.js";
import type { AgentContext } from "../agent/context/AgentContext.js";
import {
    PERMISSION_REVIEW_FOLLOWUP_REMINDER,
    PERMISSION_REVIEW_INSTRUCTIONS,
} from "../agent/prompt/permissionReviewInstructions.js";
import type { AnyDefinedTool, Message } from "../agent/types.js";
import type { Model, Provider } from "@slopus/rig-execution";
import type { PermissionReviewAgent } from "./PermissionReviewAgent.js";

/**
 * Builds the sister agent that reviews Auto permission decisions.
 *
 * The caller supplies a context whose filesystem and shell are already bound to their own
 * read-only permissions, so the reviewer cannot change the workspace and cannot be widened by the
 * agent it reviews. Its permission mode is never Auto, which is what stops a review from
 * recursing into another review.
 *
 * The reviewer keeps its history across reviews, matching Codex's guardian. What it learned about
 * the workspace while judging one action stays useful for the next, so later reviews are both
 * cheaper and better informed.
 */
export function createPermissionReviewSideAgent(options: {
    context: AgentContext;
    id: string;
    model: Model;
    provider: Provider;
    startDate?: string;
    tools: readonly AnyDefinedTool[];
}): PermissionReviewAgent {
    if (options.context.permissions?.mode === "auto") {
        throw new Error("The permission review agent must not run in Auto mode.");
    }
    const agent = new Agent({
        context: options.context,
        id: options.id,
        modelId: options.model.id,
        printToConsole: false,
        // AGENTS.md is repository content, so it is evidence for the reviewer at most, never
        // instructions to it.
        projectInstructions: "exclude",
        provider: options.provider,
        ...(options.startDate === undefined ? {} : { startDate: options.startDate }),
        systemPrompt: PERMISSION_REVIEW_INSTRUCTIONS,
        tools: options.tools,
    });
    let reviewed = false;
    return {
        async review(request) {
            const prompt = reviewed
                ? `${PERMISSION_REVIEW_FOLLOWUP_REMINDER}\n\n${request.prompt}`
                : request.prompt;
            reviewed = true;
            const result = await agent.send(
                prompt,
                request.signal === undefined ? {} : { signal: request.signal },
            );
            return finalText(result.messages);
        },
        async close() {
            await agent.close();
        },
    };
}

function finalText(messages: readonly Message[]): string {
    const last = [...messages].reverse().find((message) => message.role === "agent");
    if (last === undefined) return "";
    return last.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}
