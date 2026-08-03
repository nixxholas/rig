import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;
const identifierSchema = Type.String({ maxLength: 256, minLength: 1 });

export const friendAuthorSchema = Type.Object(
    {
        displayName: Type.String({ maxLength: 512, minLength: 1 }),
        grantEpoch: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
        kind: Type.Literal("friend"),
        murmurPeerId: identifierSchema,
        shareId: identifierSchema,
        shareMemberId: identifierSchema,
    },
    exact,
);
export type FriendAuthor = Static<typeof friendAuthorSchema>;

export const userMessageAuthorshipSchema = Type.Union([
    Type.Object(
        {
            friendAuthor: Type.Optional(Type.Never()),
            kind: Type.Literal("owner"),
        },
        exact,
    ),
    Type.Object(
        {
            friendAuthor: friendAuthorSchema,
            kind: Type.Literal("friend"),
        },
        exact,
    ),
]);
export type UserMessageAuthorship = Static<typeof userMessageAuthorshipSchema>;
