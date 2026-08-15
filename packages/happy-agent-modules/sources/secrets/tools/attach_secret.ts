import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    secretAttachReferenceResultSchema,
    secretIdSchema,
    secretScopeRefSchema,
} from "../Secret.js";
import type { SecretsModule } from "../SecretsModule.js";

const attachSecretInputSchema = Type.Object(
    {
        scopeRef: secretScopeRefSchema,
        secretId: secretIdSchema,
    },
    { additionalProperties: false },
);

type AttachSecretInput = Static<typeof attachSecretInputSchema>;

const attachSecretResultSchema = secretAttachReferenceResultSchema;

type AttachSecretResult = Static<typeof attachSecretResultSchema>;

/** Attach a reference to an opaque scope; the result remains metadata-only. */
export function attachSecretTool(secrets: SecretsModule, actingAgentId: string) {
    return {
        ...defineAgentTool({
            name: "attach_secret",
            description:
                "Attach a registered secret reference to an opaque host scope. This changes availability only; it never returns the secret value.",
            parameters: attachSecretInputSchema,
            returnType: attachSecretResultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input: AttachSecretInput, call): Promise<AttachSecretResult> => {
                return await call.kv.transaction(ctx, async (_kv, txCtx) => {
                    const result = await secrets.attachWithReference(
                        txCtx,
                        actingAgentId,
                        input,
                    );
                    return await call.commit(txCtx, result);
                });
            },
            toLLM: ({ attachment, secret }) => [
                {
                    type: "text" as const,
                    text: secrets.formatAttachmentForModel(attachment.scopeRef, secret),
                },
            ],
        }),
    };
}
