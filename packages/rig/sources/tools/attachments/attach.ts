import { extname } from "node:path";

import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { AgentContext } from "../../agent/context/AgentContext.js";
import { defineTool } from "../../agent/types.js";
import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import { AttachmentContext } from "./AttachmentContext.js";
import { assertShareableLocalPath } from "./assertShareableLocalPath.js";
import {
    attachArgumentsSchema,
    attachRuntimeArgumentsSchema,
    attachResultSchema,
    type AttachArguments,
} from "./attachmentSchemas.js";
import {
    MAX_ATTACHMENT_FILE_BYTES,
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
        label: "Attach file, applet, or link",
        description:
            "Prepare a local file, imported applet, or HTTP(S) link for the application to show with your final answer. Local files must be inside the active workspace or Rig's generated-media directory; paths elsewhere are rejected in every permission mode. In managed Docker sessions, generated media is mounted read-only at /happy/generated and only Rig tools write its host-side files. Adding returns an attachment id; use operation remove with that id if you decide not to show it. Attachments remain pending until this turn finishes normally, and are not visible if the turn is aborted or fails.",
        arguments: attachArgumentsSchema,
        returnType: attachResultSchema,
        steerable: true,
        interruptionMessage: "Attachment preparation was interrupted by new input.",
        requiresAutoOrFullAccess: true,
        describeAutoPermissionAction: describeAttachAction,
        shouldReviewInAutoMode: async (args) => {
            return args.operation === "add" && args.url !== undefined;
        },
        shouldRunInFullAccessInAutoMode: async (args) => {
            return args.operation === "add" && args.url !== undefined;
        },
        execute: async (rawArguments, context, execution) => {
            const args = parseAttachArguments(rawArguments);
            const attachments = requireAttachmentContext(context);
            if (args.operation === "remove") {
                return {
                    id: args.id,
                    operation: "remove" as const,
                    removed: attachments.remove(args.id),
                };
            }
            if ("applet" in args) {
                const attachment = await attachments.add(appletSourceKey(args), (id) =>
                    prepareAppletAttachment(args, id, context),
                );
                return { attachment, id: attachment.id, operation: "add" as const };
            }
            if (!("url" in args)) await assertShareableLocalPath(args.path, context);
            const source = await resolve(args, context);
            if (source.kind === "file") await assertShareableLocalPath(source.path, context);
            const attachment = await attachments.add(source.source, async (id) => {
                const preparedSource =
                    source.kind === "file"
                        ? await snapshotLocalAttachmentSource(source, id, context, attachments)
                        : source;
                const prepared = await prepare(preparedSource, id, context, {
                    ...dependencies,
                    ...(execution.signal === undefined ? {} : { signal: execution.signal }),
                });
                if (preparedSource.kind !== "file") return prepared;
                const scope = attachments.scope();
                return {
                    ...prepared,
                    ...(scope === undefined
                        ? {}
                        : {
                              downloadUrl: `/sessions/${encodeURIComponent(scope.sessionId)}/attachments/${encodeURIComponent(id)}/download`,
                              ...(prepared.kind === "video"
                                  ? {
                                        preview: {
                                            ...prepared.preview,
                                            downloadUrl: `/sessions/${encodeURIComponent(scope.sessionId)}/attachments/${encodeURIComponent(id)}/preview`,
                                        },
                                    }
                                  : {}),
                          }),
                };
            });
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

async function snapshotLocalAttachmentSource(
    source: Extract<
        Awaited<ReturnType<typeof resolveAttachmentSource>>,
        {
            kind: "file";
        }
    >,
    id: string,
    context: AgentContext,
    attachments: AttachmentContext,
): Promise<Extract<Awaited<ReturnType<typeof resolveAttachmentSource>>, { kind: "file" }>> {
    const generated = context.generatedMedia;
    if (generated === undefined) return source;
    const bytes = await context.fs.readFileBuffer(source.path, {
        maxBytes: MAX_ATTACHMENT_FILE_BYTES,
        noFollow: true,
    });
    const sourceExtension = extname(source.name);
    const written = await generated.write(bytes, {
        extension: /^\.[A-Za-z0-9]{1,10}$/u.test(sourceExtension) ? sourceExtension : ".bin",
        preferredName: source.name,
    });
    attachments.registerCleanup(id, () => generated.remove(written.hostPath));
    return {
        ...source,
        hostPath: written.hostPath,
        path: written.path,
        size: bytes.byteLength,
        source: written.location,
    };
}

function requireAttachmentContext(context: AgentContext): AttachmentContext {
    if (context.attachments === undefined) {
        throw new Error("Attachments are unavailable for this agent run.");
    }
    return context.attachments;
}

function describeAttachAction(args: Static<typeof attachArgumentsSchema>): string {
    if (args.operation === "remove") {
        return args.id === undefined
            ? "removing a pending attachment"
            : `removing pending attachment ${quoteVisibleExact(args.id)}`;
    }
    if (args.url !== undefined) {
        return `fetching URL metadata from ${quoteVisibleExact(args.url)}, verifying the domain with Anthropic's web safety service, and preparing it as a final-message attachment. Access: external network requests`;
    }
    if (args.applet !== undefined) {
        return `preparing the imported applet ${quoteVisibleExact(args.applet)} as a final-message attachment`;
    }
    return args.path === undefined
        ? "preparing a final-message attachment"
        : `reading ${quoteVisibleExact(args.path)} and preparing it as a final-message attachment`;
}

function parseAttachArguments(args: Static<typeof attachArgumentsSchema>): AttachArguments {
    if (Value.Check(attachRuntimeArgumentsSchema, args)) return args;
    const first = Value.Errors(attachRuntimeArgumentsSchema, args).First();
    throw new Error(
        first === undefined
            ? "Invalid attach arguments."
            : `Invalid attach arguments: ${first.message}`,
    );
}

function appletSourceKey(args: Extract<AttachArguments, { applet: string }>): string {
    return `applet\u0000${args.applet}\u0000${args.path ?? ""}\u0000${JSON.stringify(args.query ?? {})}`;
}

async function prepareAppletAttachment(
    args: Extract<AttachArguments, { applet: string }>,
    id: string,
    context: AgentContext,
) {
    const applet = context.slots?.listApplets().find((candidate) => candidate.name === args.applet);
    if (applet === undefined) {
        throw new Error(`No applet named ${JSON.stringify(args.applet)} exists.`);
    }
    return {
        description: applet.description,
        id,
        image: applet.iconUrl,
        kind: "applet" as const,
        name: applet.name,
        ...(args.path === undefined ? {} : { path: args.path }),
        ...(args.query === undefined ? {} : { query: args.query }),
        thumbhash: applet.iconThumbhash,
        applet: applet.name,
    };
}
