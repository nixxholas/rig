import { Type, type Static } from "@sinclair/typebox";
import { agentMetadataSchema, agentPermissionModeSchema } from "@slopus/happy-agent-base";

const textBlockSchema = Type.Object(
    {
        text: Type.String({ maxLength: 1_000_000 }),
        type: Type.Literal("text"),
    },
    { additionalProperties: false },
);

const imageBlockSchema = Type.Object(
    {
        data: Type.String({ maxLength: 12_000_000 }),
        mimeType: Type.String({ minLength: 1, maxLength: 256 }),
        type: Type.Literal("image"),
    },
    { additionalProperties: false },
);

export const messageRequestSchema = Type.Object(
    {
        await: Type.Optional(Type.Boolean()),
        content: Type.Union([
            Type.String({ minLength: 1, maxLength: 1_000_000 }),
            Type.Array(Type.Union([textBlockSchema, imageBlockSchema]), {
                minItems: 1,
                maxItems: 256,
            }),
        ]),
        effort: Type.Optional(
            Type.Union([
                Type.Literal("off"),
                Type.Literal("minimal"),
                Type.Literal("low"),
                Type.Literal("medium"),
                Type.Literal("high"),
                Type.Literal("xhigh"),
                Type.Literal("max"),
            ]),
        ),
        id: Type.Optional(
            Type.String({
                minLength: 2,
                maxLength: 32,
                pattern: "^[a-z][a-z0-9]+$",
            }),
        ),
        model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        permissionMode: Type.Optional(agentPermissionModeSchema),
        provider: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        serviceTier: Type.Optional(Type.Literal("priority")),
    },
    { additionalProperties: false },
);

export const metadataRequestSchema = agentMetadataSchema;

export const awaitRequestSchema = Type.Object(
    {
        await: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

export type MessageRequest = Static<typeof messageRequestSchema>;
export type MetadataRequest = Static<typeof metadataRequestSchema>;
export type AwaitRequest = Static<typeof awaitRequestSchema>;
