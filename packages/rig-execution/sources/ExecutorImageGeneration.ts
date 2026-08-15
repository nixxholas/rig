export interface ExecutorImageGeneration {
    generate(request: {
        images?: readonly string[];
        prompt: string;
        signal?: AbortSignal;
        turnId: string;
    }): Promise<{ base64: string; mediaType: "image/png" }>;
}

/** A definitive account-side refusal for which trying another configured account is safe. */
export class ExecutorImageGenerationUnavailableError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ExecutorImageGenerationUnavailableError";
    }
}
