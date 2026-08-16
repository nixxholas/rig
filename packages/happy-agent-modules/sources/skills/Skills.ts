import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

export const MAX_SKILL_NAME_LENGTH = 128;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1_024;
export const MAX_SKILL_LOCATION_LENGTH = 4_096;
export const MAX_SKILL_SOURCE_LENGTH = 256;
export const MAX_SKILL_DOCUMENT_BYTES = 256 * 1024;
export const MAX_SKILL_COUNT = 256;
export const MAX_SKILL_OUTPUT_CHARACTERS = 100_000;
export const MAX_SKILL_ROOT_COUNT = 64;
export const MAX_DURABLE_SKILL_COUNT_PER_ROOT = MAX_SKILL_COUNT;

const noLineBreaks = "^[^\\u0000\\r\\n]+$";

export const skillNameSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SKILL_NAME_LENGTH,
    pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
});
export const skillDescriptionSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SKILL_DESCRIPTION_LENGTH,
});
export const skillLocationSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SKILL_LOCATION_LENGTH,
});
export const skillSourceSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SKILL_SOURCE_LENGTH,
    pattern: noLineBreaks,
});
export const durableSkillSchema = Type.Object(
    {
        description: skillDescriptionSchema,
        name: skillNameSchema,
    },
    { additionalProperties: false },
);
export const skillEntrySchema = Type.Object(
    {
        description: skillDescriptionSchema,
        location: skillLocationSchema,
        name: skillNameSchema,
        source: skillSourceSchema,
    },
    { additionalProperties: false },
);
export const skillDocumentSchema = Type.Object(
    {
        content: Type.String({ minLength: 1, maxLength: MAX_SKILL_DOCUMENT_BYTES }),
        location: skillLocationSchema,
        name: skillNameSchema,
    },
    { additionalProperties: false },
);
export const skillListInputSchema = Type.Object(
    {
        cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 10, pattern: "^[0-9]+$" })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SKILL_COUNT })),
        query: Type.Optional(Type.String({ maxLength: MAX_SKILL_NAME_LENGTH })),
    },
    { additionalProperties: false },
);
export const skillReadInputSchema = Type.Object(
    { name: skillNameSchema },
    { additionalProperties: false },
);
const contextSchema = Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true }));
const agentIdSchema = Type.String({ minLength: 1, maxLength: 256 });
export const durableSkillReaderSchema = Type.Unsafe<
    (ctx: Context, agentId: string, name: string) => Promise<string>
>(
    Type.Function(
        [contextSchema, agentIdSchema, skillNameSchema],
        Type.Promise(Type.String({ maxLength: MAX_SKILL_DOCUMENT_BYTES })),
    ),
);
const filesystemSkillRootSchema = Type.Object(
    {
        kind: Type.Union([Type.Literal("builtin"), Type.Literal("plugin")]),
        path: skillLocationSchema,
    },
    { additionalProperties: false },
);
const durableSkillRootSchema = Type.Object(
    {
        kind: Type.Literal("durable"),
        read: durableSkillReaderSchema,
        skills: Type.Array(durableSkillSchema, {
            maxItems: MAX_DURABLE_SKILL_COUNT_PER_ROOT,
        }),
    },
    { additionalProperties: false },
);
export const skillRootSchema = Type.Union([filesystemSkillRootSchema, durableSkillRootSchema]);
export const skillRootsSchema = Type.Array(skillRootSchema, {
    maxItems: MAX_SKILL_ROOT_COUNT,
});
export const skillListResultSchema = Type.Object(
    {
        nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        skills: Type.Array(skillEntrySchema, { maxItems: MAX_SKILL_COUNT }),
    },
    { additionalProperties: false },
);
export type SkillEntry = Static<typeof skillEntrySchema>;
export type SkillDocument = Static<typeof skillDocumentSchema>;
export type DurableSkill = Static<typeof durableSkillSchema>;
export type DurableSkillReader = Static<typeof durableSkillReaderSchema>;
export type SkillListInput = Static<typeof skillListInputSchema>;
export type SkillReadInput = Static<typeof skillReadInputSchema>;
export type SkillRoot = Static<typeof skillRootSchema>;
export type SkillListResult = Static<typeof skillListResultSchema>;
