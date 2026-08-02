import { Type, type Static } from "@sinclair/typebox";

import {
    AttachmentImagePreviewSchema,
    AttachmentSchema,
    type Attachment,
    type AttachmentImagePreview,
} from "../../protocol/Attachment.js";

export const attachmentImagePreviewSchema = AttachmentImagePreviewSchema;
export const attachmentSchema = AttachmentSchema;
export type { Attachment, AttachmentImagePreview };

const attachmentIdSchema = Type.String({
    description: "Pending attachment id. Required when operation is remove.",
    minLength: 1,
});
const attachmentPathSchema = Type.String({
    description: "Local file path, or a relative path within an imported webapp.",
    minLength: 1,
});
const attachmentQuerySchema = Type.Record(Type.String({ minLength: 1 }), Type.String(), {
    description: "Query values forwarded when the webapp opens.",
});
const attachmentUrlSchema = Type.String({
    description: "HTTP(S) link to attach.",
    minLength: 1,
});
const attachmentWebappSchema = Type.String({
    description: "Imported webapp name.",
    minLength: 1,
});

export const attachArgumentsSchema = Type.Object(
    {
        id: Type.Optional(attachmentIdSchema),
        operation: Type.String({
            description: "Whether to add or remove an attachment.",
            enum: ["add", "remove"],
        }),
        path: Type.Optional(attachmentPathSchema),
        query: Type.Optional(attachmentQuerySchema),
        url: Type.Optional(attachmentUrlSchema),
        webapp: Type.Optional(attachmentWebappSchema),
    },
    {
        additionalProperties: false,
        description:
            "Add a local file, HTTP(S) URL, or imported webapp attachment, or remove a pending attachment.",
    },
);

export const attachRuntimeArgumentsSchema = Type.Union(
    [
        Type.Object(
            {
                operation: Type.Literal("add"),
                path: attachmentPathSchema,
            },
            { additionalProperties: false },
        ),
        Type.Object(
            {
                operation: Type.Literal("add"),
                url: attachmentUrlSchema,
            },
            { additionalProperties: false },
        ),
        Type.Object(
            {
                operation: Type.Literal("add"),
                path: Type.Optional(attachmentPathSchema),
                query: Type.Optional(attachmentQuerySchema),
                webapp: attachmentWebappSchema,
            },
            { additionalProperties: false },
        ),
        Type.Object(
            {
                id: attachmentIdSchema,
                operation: Type.Literal("remove"),
            },
            { additionalProperties: false },
        ),
    ],
    {
        description:
            "Add a local file, HTTP(S) URL, or imported webapp attachment, or remove a pending attachment.",
    },
);

export type AttachArguments = Static<typeof attachRuntimeArgumentsSchema>;

export const attachResultSchema = Type.Union([
    Type.Object(
        {
            attachment: attachmentSchema,
            id: Type.String(),
            operation: Type.Literal("add"),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            id: Type.String(),
            operation: Type.Literal("remove"),
            removed: Type.Boolean(),
        },
        { additionalProperties: false },
    ),
]);

export type AttachResult = Static<typeof attachResultSchema>;
