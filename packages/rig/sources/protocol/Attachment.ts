import { Type, type Static } from "@sinclair/typebox";

const attachmentBase = {
    downloadUrl: Type.Optional(Type.String({ minLength: 1 })),
    id: Type.String({ minLength: 1 }),
    source: Type.String({ minLength: 1 }),
};

export const AttachmentImagePreviewSchema = Type.Object(
    {
        height: Type.Integer({ minimum: 1 }),
        mediaType: Type.Literal("image/png"),
        path: Type.String({ minLength: 1 }),
        thumbhash: Type.String({ minLength: 1 }),
        width: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
);

export const AttachmentSchema = Type.Union([
    Type.Object(
        {
            ...attachmentBase,
            bytes: Type.Integer({ minimum: 0 }),
            height: Type.Integer({ minimum: 1 }),
            kind: Type.Literal("image"),
            mediaType: Type.String({ minLength: 1 }),
            name: Type.String({ minLength: 1 }),
            thumbhash: Type.String({ minLength: 1 }),
            width: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...attachmentBase,
            bytes: Type.Integer({ minimum: 0 }),
            duration: Type.Number({ description: "Duration in seconds.", minimum: 0 }),
            height: Type.Integer({ minimum: 1 }),
            kind: Type.Literal("video"),
            mediaType: Type.Optional(Type.String({ minLength: 1 })),
            name: Type.String({ minLength: 1 }),
            preview: AttachmentImagePreviewSchema,
            width: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...attachmentBase,
            bytes: Type.Integer({ minimum: 0 }),
            duration: Type.Number({ description: "Duration in seconds.", minimum: 0 }),
            kind: Type.Literal("audio"),
            mediaType: Type.Optional(Type.String({ minLength: 1 })),
            name: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...attachmentBase,
            description: Type.Optional(Type.String()),
            image: Type.Optional(Type.String()),
            kind: Type.Literal("url"),
            siteName: Type.Optional(Type.String()),
            title: Type.String(),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...attachmentBase,
            bytes: Type.Integer({ minimum: 0 }),
            kind: Type.Literal("file"),
            mediaType: Type.Optional(Type.String({ minLength: 1 })),
            name: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            description: Type.String({ minLength: 1 }),
            id: Type.String({ minLength: 1 }),
            image: Type.String({ minLength: 1 }),
            kind: Type.Literal("webapp"),
            name: Type.String({ minLength: 1 }),
            path: Type.Optional(Type.String({ minLength: 1 })),
            query: Type.Optional(
                Type.Record(Type.String({ minLength: 1 }), Type.String(), {
                    description: "Query values forwarded when the webapp opens.",
                }),
            ),
            thumbhash: Type.String({ minLength: 1 }),
            webapp: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
    ),
]);

export type AttachmentImagePreview = Static<typeof AttachmentImagePreviewSchema>;
export type Attachment = Static<typeof AttachmentSchema>;
