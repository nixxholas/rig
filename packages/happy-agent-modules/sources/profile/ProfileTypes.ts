import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

const exact = { additionalProperties: false } as const;
/** A lifetime this module is handed. Its shape is its own, so the schema only stands for it. */
export const profileContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: true }),
);
const timestampSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });

export const profileIdSchema = Type.String({
    maxLength: 32,
    minLength: 2,
    pattern: "^[a-z][a-z0-9]+$",
});
export type ProfileId = Static<typeof profileIdSchema>;

/**
 * The installation that owns a profile. Today this is the installation epoch, a UUID; older
 * profiles carry the agent identifier that stood for the machine before epochs existed.
 */
export const instanceIdSchema = Type.String({
    maxLength: 64,
    minLength: 2,
    pattern: "^[A-Za-z0-9][A-Za-z0-9-]*$",
});

export const profileNameSchema = Type.String({
    maxLength: 128,
    minLength: 1,
    // Anything that can rewrite how the rest of a line reads — control characters, bidirectional
    // overrides, invisible separators — is refused: this name is shown to other people, on their
    // machines, next to things they are being asked to trust.
    pattern:
        "^[^\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b\\u200e\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f]+$",
});

export const profileEmailSchema = Type.String({
    maxLength: 254,
    minLength: 3,
    pattern: "^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$",
});

/**
 * The one person behind this installation.
 *
 * `version` counts changes so a copy of this profile that reached someone else can be compared
 * with a later one without trusting a clock, and `parentInstanceId` says which installation is
 * allowed to change it.
 */
export const profileSchema = Type.Object(
    {
        createdAt: timestampSchema,
        email: profileEmailSchema,
        id: profileIdSchema,
        name: profileNameSchema,
        parentInstanceId: instanceIdSchema,
        updatedAt: timestampSchema,
        version: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
    },
    exact,
);
export type Profile = Static<typeof profileSchema>;

export const createProfileInputSchema = Type.Object(
    { email: profileEmailSchema, name: profileNameSchema },
    exact,
);
export type CreateProfileInput = Static<typeof createProfileInputSchema>;

export const updateProfileInputSchema = Type.Object(
    { email: Type.Optional(profileEmailSchema), name: Type.Optional(profileNameSchema) },
    { ...exact, minProperties: 1 },
);
export type UpdateProfileInput = Static<typeof updateProfileInputSchema>;

export const profileChangedEventSchema = Type.Object(
    {
        createdAt: timestampSchema,
        data: Type.Object(
            { profileId: profileIdSchema, version: Type.Integer({ minimum: 1 }) },
            exact,
        ),
        id: Type.String({ maxLength: 256, minLength: 1 }),
        type: Type.Literal("profile_changed"),
    },
    exact,
);
export type ProfileChangedEvent = Static<typeof profileChangedEventSchema>;

/** What `onEvent` registers: told after a change is saved, never inside its transaction. */
export const profileEventListenerSchema = Type.Function(
    [profileContextSchema, profileChangedEventSchema],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);
export type ProfileEventListener = Static<typeof profileEventListenerSchema>;

/** Undoing a registration; calling it twice is harmless. */
export type ProfileUnsubscribe = () => void;
