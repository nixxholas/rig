import { Type, type Static } from "@sinclair/typebox";
import { p2pInstanceIdSchema } from "./P2pIdentityProtocol.js";

const exact = { additionalProperties: false } as const;

export const rigProfileIdSchema = Type.String({
    maxLength: 32,
    minLength: 2,
    pattern: "^[a-z][a-z0-9]+$",
});
export type RigProfileId = Static<typeof rigProfileIdSchema>;
export const rigProfileIdentitySchema = Type.Union([rigProfileIdSchema, Type.Null()]);
export type RigProfileIdentity = Static<typeof rigProfileIdentitySchema>;

export const rigProfileNameSchema = Type.String({
    maxLength: 128,
    minLength: 1,
    pattern:
        "^[^\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b\\u200e\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f]+$",
});

export const rigProfilePhotoInputSchema = Type.Object(
    {
        data: Type.String({
            maxLength: 32 * 1024 * 1024,
            minLength: 1,
            pattern: "^[A-Za-z0-9+/]*={0,2}$",
        }),
        mediaType: Type.String({ maxLength: 128, minLength: 1 }),
    },
    exact,
);
export type RigProfilePhotoInput = Static<typeof rigProfilePhotoInputSchema>;

export const rigProfilePhotoSchema = Type.Object(
    {
        bytes: Type.Integer({ maximum: 96 * 1024, minimum: 1 }),
        data: Type.String({
            maxLength: 128 * 1024,
            minLength: 1,
            pattern: "^[A-Za-z0-9+/]*={0,2}$",
        }),
        height: Type.Integer({ maximum: 16_384, minimum: 1 }),
        mediaType: Type.Literal("image/webp"),
        thumbhash: Type.String({ maxLength: 1_024, minLength: 1 }),
        width: Type.Integer({ maximum: 16_384, minimum: 1 }),
    },
    exact,
);
export type RigProfilePhoto = Static<typeof rigProfilePhotoSchema>;

export const rigProfileSchema = Type.Object(
    {
        createdAt: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        id: rigProfileIdSchema,
        name: rigProfileNameSchema,
        parentInstanceId: p2pInstanceIdSchema,
        photo: Type.Optional(rigProfilePhotoSchema),
        updatedAt: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        version: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
    },
    exact,
);
export type RigProfile = Static<typeof rigProfileSchema>;

export const createRigProfileRequestSchema = Type.Object(
    {
        name: rigProfileNameSchema,
        photo: Type.Optional(rigProfilePhotoInputSchema),
    },
    exact,
);
export type CreateRigProfileRequest = Static<typeof createRigProfileRequestSchema>;

export const updateRigProfileRequestSchema = Type.Object(
    {
        name: Type.Optional(rigProfileNameSchema),
        photo: Type.Optional(Type.Union([rigProfilePhotoInputSchema, Type.Null()])),
    },
    { ...exact, minProperties: 1 },
);
export type UpdateRigProfileRequest = Static<typeof updateRigProfileRequestSchema>;

export const replicateRigProfileRequestSchema = Type.Object({ profile: rigProfileSchema }, exact);
export type ReplicateRigProfileRequest = Static<typeof replicateRigProfileRequestSchema>;

export const listRigProfilesResponseSchema = Type.Object(
    { profiles: Type.Array(rigProfileSchema, { maxItems: 128 }) },
    exact,
);
export type ListRigProfilesResponse = Static<typeof listRigProfilesResponseSchema>;

export const rigProfileResponseSchema = Type.Object({ profile: rigProfileSchema }, exact);
export type RigProfileResponse = Static<typeof rigProfileResponseSchema>;

export const rigProfileChangedEventSchema = Type.Object(
    {
        createdAt: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        data: Type.Object(
            {
                profileId: rigProfileIdSchema,
                version: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
            },
            exact,
        ),
        id: Type.String({ maxLength: 256, minLength: 1 }),
        type: Type.Literal("profile_changed"),
    },
    exact,
);
export type RigProfileChangedEvent = Static<typeof rigProfileChangedEventSchema>;
