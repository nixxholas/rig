import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;

export const onboardingVersionSchema = Type.Integer({
    maximum: Number.MAX_SAFE_INTEGER,
    minimum: 0,
});
export type OnboardingVersion = Static<typeof onboardingVersionSchema>;

export const onboardingStateSchema = Type.Object(
    {
        completedVersion: onboardingVersionSchema,
    },
    exact,
);
export type OnboardingState = Static<typeof onboardingStateSchema>;
