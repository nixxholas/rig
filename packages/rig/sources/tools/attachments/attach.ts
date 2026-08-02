import type { AgentContext } from "../../agent/context/AgentContext.js";
import { defineTool } from "../../agent/types.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import { shouldReviewPathInAutoMode } from "../../permissions/shouldReviewPathInAutoMode.js";
import { AttachmentContext } from "./AttachmentContext.js";
import {
    attachArgumentsSchema,
    attachResultSchema,
    type AttachArguments,
} from "./attachmentSchemas.js";
import {
    prepareAttachment,
    resolveAttachmentSource,
    type AttachmentPreparationDependencies,
} from "./prepareAttachment.js";

export interface AttachToolDependencies extends AttachmentPreparationDependencies {
    prepare?: typeof prepareAttachment;
    resolve?: typeof resolveAttachmentSource;
}

export function createAttachTool(dependencies: AttachToolDependencies = {}) {
    const resolve = dependencies.resolve ?? resolveAttachmentSource;
    const prepare = dependencies.prepare ?? prepareAttachment;
    return defineTool({
        name: "attach",
        label: "Attach file or link",
        description:
            "Prepare a local file or HTTP(S) link for the application to show with your final answer. Adding returns an attachment id; use operation remove with that id if you decide not to show it. Attachments remain pending until this turn finishes normally, and are not visible if the turn is aborted or fails.",
        arguments: attachArgumentsSchema,
        returnType: attachResultSchema,
        steerable: true,
        interruptionMessage: "Attachment preparation was interrupted by new input.",
        requiresAutoOrFullAccess: true,
        describeAutoPermissionAction: describeAttachAction,
        shouldReviewInAutoMode: async (args, context) => {
            if (args.operation === "remove") return false;
            return (
                "url" in args ||
                (await shouldReviewPathInAutoMode(args.path, context, { write: false }))
            );
        },
        shouldRunInFullAccessInAutoMode: async (args, context) => {
            if (args.operation === "remove") return false;
            return (
                "url" in args ||
                (await shouldReviewPathInAutoMode(args.path, context, { write: false }))
            );
        },
        execute: async (args, context, execution) => {
            const attachments = requireAttachmentContext(context);
            if (args.operation === "remove") {
                return {
                    id: args.id,
                    operation: "remove" as const,
                    removed: attachments.remove(args.id),
                };
            }
            const source = await resolve(args, context);
            const attachment = await attachments.add(source.source, (id) =>
                prepare(source, id, context, {
                    ...dependencies,
                    ...(execution.signal === undefined ? {} : { signal: execution.signal }),
                }),
            );
            return { attachment, id: attachment.id, operation: "add" as const };
        },
        toLLM: (result) => [
            {
                type: "text",
                text:
                    result.operation === "add"
                        ? `Prepared pending attachment ${result.id}. It is included only if this turn completes normally.`
                        : result.removed
                          ? `Removed pending attachment ${result.id}.`
                          : `No pending attachment exists with id ${result.id}.`,
            },
        ],
        toUI: (result) =>
            result.operation === "add"
                ? `Prepared attachment ${result.id}`
                : result.removed
                  ? `Removed attachment ${result.id}`
                  : `No attachment found for ${result.id}`,
        locks: ["attachments"],
    });
}

export const attachTool = createAttachTool();

function requireAttachmentContext(context: AgentContext): AttachmentContext {
    if (context.attachments === undefined) {
        throw new Error("Attachments are unavailable for this agent run.");
    }
    return context.attachments;
}

function describeAttachAction(args: AttachArguments): string {
    if (args.operation === "remove") {
        return `removing pending attachment ${quoteVisibleExact(args.id)}`;
    }
    if ("url" in args) {
        return `fetching URL metadata from ${quoteVisibleExact(args.url)}, verifying the domain with Anthropic's web safety service, and preparing it as a final-message attachment. Access: external network requests`;
    }
    return `reading ${quoteVisibleExact(args.path)} and preparing it as a final-message attachment`;
}
