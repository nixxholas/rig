import { Type, type Static } from "@sinclair/typebox";

export const MAX_AGENTS_MD_PATH_LENGTH = 4_096;
export const MAX_AGENTS_MD_DOCUMENT_BYTES = 64 * 1024;
export const MAX_AGENTS_MD_DOCUMENTS = 32;
export const MAX_AGENTS_MD_TOTAL_BYTES = 256 * 1024;
export const MAX_AGENTS_MD_OUTPUT_CHARACTERS = 300_000;

export const agentsMdPathSchema = Type.String({
    minLength: 1,
    maxLength: MAX_AGENTS_MD_PATH_LENGTH,
});
export const agentsMdDocumentSchema = Type.Object(
    {
        path: agentsMdPathSchema,
        text: Type.String({ maxLength: MAX_AGENTS_MD_DOCUMENT_BYTES }),
    },
    { additionalProperties: false },
);
export const agentsMdSnapshotSchema = Type.Object(
    {
        cwd: Type.String({ minLength: 1, maxLength: MAX_AGENTS_MD_PATH_LENGTH }),
        documents: Type.Array(agentsMdDocumentSchema, { maxItems: MAX_AGENTS_MD_DOCUMENTS }),
    },
    { additionalProperties: false },
);
export type AgentsMdDocument = Static<typeof agentsMdDocumentSchema>;
export type AgentsMdSnapshot = Static<typeof agentsMdSnapshotSchema>;