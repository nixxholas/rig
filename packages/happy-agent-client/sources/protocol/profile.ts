/** The profile: one installation is one person, and this is what they said about themselves. */

import { type Static, Type } from "@sinclair/typebox";

import { mutationIdSchema, Nullable, resourceVersionSchema, timestampSchema } from "./common.js";

/** The photo's ThumbHash placeholder; the bytes come from `GET /v0/profile/photo`. */
export const profilePhotoSchema = Type.Object({ thumbhash: Type.String() });
export type ProfilePhoto = Static<typeof profilePhotoSchema>;

/** The profile object. Every field is optional and starts out `null`. */
export const profileSchema = Type.Object({
    email: Nullable(Type.String()),
    name: Nullable(Type.String()),
    photo: Nullable(profilePhotoSchema),
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
});
export type Profile = Static<typeof profileSchema>;

/** `GET`, `PATCH /v0/profile`, and the photo routes all answer with this. */
export const profileResponseSchema = Type.Object({ profile: profileSchema });
export type ProfileResponse = Static<typeof profileResponseSchema>;

/** `PATCH /v0/profile` — any subset; a field set to `null` is cleared. */
export const profileUpdateRequestSchema = Type.Object({
    email: Type.Optional(Nullable(Type.String())),
    /** Echoed verbatim in the events this mutation produces. */
    mutationId: Type.Optional(mutationIdSchema),
    name: Type.Optional(Nullable(Type.String())),
});
export type ProfileUpdateRequest = Static<typeof profileUpdateRequestSchema>;
