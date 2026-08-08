import { Type, type Static } from "@sinclair/typebox";

export const PROJECT_GIT_SECRET_ID = "project-git";

const secretIdSchema = Type.String({
    maxLength: 128,
    minLength: 1,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
});
const environmentVariableValueSchema = Type.String({
    pattern: "^[^\\u0000]*$",
});

export const environmentSecretRegistrationSchema = Type.Object(
    {
        description: Type.String({ minLength: 1 }),
        environment: Type.Record(
            Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
            environmentVariableValueSchema,
            { additionalProperties: false, minProperties: 1 },
        ),
        id: secretIdSchema,
    },
    { additionalProperties: false },
);

export const environmentSecretUpdateSchema = Type.Object(
    {
        description: Type.Optional(Type.String({ minLength: 1 })),
        environment: Type.Optional(
            Type.Record(
                Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
                Type.Union([environmentVariableValueSchema, Type.Null()]),
                { additionalProperties: false, minProperties: 1 },
            ),
        ),
    },
    { additionalProperties: false, minProperties: 1 },
);

export const specialSecretKindSchema = Type.Union([Type.Literal("github")]);

export const githubSecretRegistrationSchema = Type.Object(
    {
        kind: Type.Literal("github"),
        token: Type.String({
            maxLength: 65_536,
            minLength: 1,
            pattern: "^[^\\u0000]+$",
        }),
    },
    { additionalProperties: false },
);

export const secretRegistrationSchema = Type.Union([
    environmentSecretRegistrationSchema,
    githubSecretRegistrationSchema,
]);

export type EnvironmentSecretRegistration = Static<typeof environmentSecretRegistrationSchema>;
export type EnvironmentSecretUpdate = Static<typeof environmentSecretUpdateSchema>;
export type GitHubSecretRegistration = Static<typeof githubSecretRegistrationSchema>;
export type SpecialSecretKind = Static<typeof specialSecretKindSchema>;
export type SpecialSecretRegistration = GitHubSecretRegistration;
export type SecretRegistration = Static<typeof secretRegistrationSchema>;

export type RigSecret = SecretRegistration;

export type SecretAttachmentScope = "project" | "session";

export interface SecretReference {
    availableToModel?: boolean;
    description: string;
    environmentVariables: readonly string[];
    id: string;
    kind?: SpecialSecretKind;
}
