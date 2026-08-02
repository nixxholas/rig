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

export const attachArgumentsSchema = Type.Union(
    [
        Type.Object(
            {
                operation: Type.Literal("add"),
                path: Type.String({ minLength: 1 }),
            },
            { additionalProperties: false },
        ),
        Type.Object(
            {
                operation: Type.Literal("add"),
                url: Type.String({ minLength: 1 }),
            },
            { additionalProperties: false },
        ),
        Type.Object(
            {
                id: Type.String({ minLength: 1 }),
                operation: Type.Literal("remove"),
            },
            { additionalProperties: false },
        ),
    ],
    { description: "Add a local file or HTTP(S) URL attachment, or remove a pending attachment." },
);

export type AttachArguments = Static<typeof attachArgumentsSchema>;

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
