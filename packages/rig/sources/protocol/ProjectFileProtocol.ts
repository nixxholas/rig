import { Type, type Static } from "@sinclair/typebox";

export interface FileSearchResult {
    fileName: string;
    path: string;
}

export interface SearchFilesResponse {
    files: readonly FileSearchResult[];
}

export interface ListProjectFilePathsResponse {
    /** Every file in the checkout, relative to it, with POSIX separators, sorted. */
    paths: readonly string[];
    /** True when the checkout holds more files than `paths` carries, so a client can say so. */
    truncated: boolean;
}

export interface ReadProjectFileResponse {
    /** Base64-encoded file bytes. */
    content: string;
    /** SHA-256 of the returned bytes, used to guard a later write. */
    hash: string;
}

export interface ReadProjectFileRevisionResponse {
    /** Base64-encoded file bytes at that revision, or `null` when the revision has no such file. */
    content: string | null;
    /** SHA-256 of the returned bytes, or `null` when the revision has no such file. */
    hash: string | null;
}

export const writeProjectFileRequestSchema = Type.Object(
    {
        /** Base64-encoded replacement bytes. */
        content: Type.String(),
        /** `null` creates a new file; a hash replaces exactly the version that was read. */
        expectedHash: Type.Union([Type.String(), Type.Null()]),
        path: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);

export type WriteProjectFileRequest = Static<typeof writeProjectFileRequestSchema>;

export interface WriteProjectFileResponse {
    hash: string;
}
