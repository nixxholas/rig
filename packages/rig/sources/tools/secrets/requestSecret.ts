import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import { SecretRequestAttachmentSchema } from "../../protocol/Attachment.js";
import { environmentVariableNameSchema, secretIdSchema } from "../../secrets/types.js";

const requestSecretArgumentsSchema = Type.Object(
    {
        description: Type.String({
            description: "The description to save on the new or updated secret.",
            minLength: 1,
        }),
        environment_variables: Type.Array(environmentVariableNameSchema, {
            description: "Exact environment variable names whose values the user must provide.",
            minItems: 1,
            uniqueItems: true,
        }),
        instructions: Type.String({
            description:
                "Everything the user needs to know to obtain and enter the requested values.",
            minLength: 1,
        }),
        operation: Type.Union([Type.Literal("create"), Type.Literal("update")], {
            description: "Whether the client should create a new secret or update an existing one.",
        }),
        secret_id: secretIdSchema,
    },
    {
        additionalProperties: false,
        description:
            "Request that the user create or update a secret through the client without exposing its values to the model or transcript.",
    },
);

const requestSecretResultSchema = Type.Object(
    {
        attachment: SecretRequestAttachmentSchema,
        id: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);

export const requestSecretTool = defineTool({
    name: "request_secret",
    label: "Request secret",
    description:
        "Ask the user to create or update a named secret in the client. Provide only the secret ID, required environment variable names, saved description, and complete setup instructions. Never ask the user to put secret values in chat, tool arguments, files, or command output. The request appears with your final answer only when this turn completes normally.",
    arguments: requestSecretArgumentsSchema,
    returnType: requestSecretResultSchema,
    execute: async (args, context) => {
        const attachments = context.attachments;
        if (attachments === undefined) {
            throw new Error("Attachments are unavailable for this agent run.");
        }
        const source = JSON.stringify([
            "secret_request",
            args.operation,
            args.secret_id,
            args.environment_variables,
            args.description,
            args.instructions,
        ]);
        const attachment = await attachments.add(source, async (id) => ({
            description: args.description,
            environmentVariables: args.environment_variables,
            id,
            instructions: args.instructions,
            kind: "secret_request" as const,
            operation: args.operation,
            secretId: args.secret_id,
        }));
        if (attachment.kind !== "secret_request") {
            throw new Error("The pending attachment conflicts with this secret request.");
        }
        return { attachment, id: attachment.id };
    },
    toLLM: (result) => [
        {
            type: "text",
            text: `Prepared a pending ${result.attachment.operation} request for secret ${JSON.stringify(result.attachment.secretId)}. It is included only if this turn completes normally. Never ask the user to send the values in chat.`,
        },
    ],
    toUI: (result) =>
        `Requested ${result.attachment.operation} for secret ${result.attachment.secretId}`,
    shouldReviewInAutoMode: () => false,
    locks: ["attachments"],
});
