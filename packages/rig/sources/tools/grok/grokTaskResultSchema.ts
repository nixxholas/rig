import { Type, type Static } from "@sinclair/typebox";

export const grokTaskResultSchema = Type.Union([
    Type.Object(
        {
            task_id: Type.String(),
            status: Type.String(),
            exit_code: Type.Optional(Type.Number()),
            output: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            agent_id: Type.String(),
            path: Type.String(),
            status: Type.String(),
            output: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
    ),
]);

export type GrokTaskResult = Static<typeof grokTaskResultSchema>;
