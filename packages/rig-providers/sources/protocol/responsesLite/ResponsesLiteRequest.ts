import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";

export type ResponsesLiteRequest = ResponseCreateParamsStreaming & {
    client_metadata?: Record<string, unknown>;
    generate?: boolean;
};