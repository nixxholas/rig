import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { happyComputeErrorCodeSchema } from "./computeTypes.js";

const happyComputeProviderErrorCodeSchema = Type.Exclude(
    happyComputeErrorCodeSchema,
    Type.Literal("preparing_compute"),
);

const happyComputeProviderErrorInputSchema = Type.Object(
    {
        code: happyComputeProviderErrorCodeSchema,
        message: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);
type HappyComputeProviderErrorInput = Static<typeof happyComputeProviderErrorInputSchema>;

/**
 * A typed failure reported by a compute provider handler.
 *
 * Rig preserves the code, derives retryability itself, and attributes only provider-side codes to
 * provider health.
 */
export class HappyComputeProviderError extends Error {
    readonly code: HappyComputeProviderErrorInput["code"];

    constructor(
        code: HappyComputeProviderErrorInput["code"],
        message: HappyComputeProviderErrorInput["message"],
    ) {
        const input = Value.Decode(happyComputeProviderErrorInputSchema, { code, message });
        super(input.message);
        this.name = "HappyComputeProviderError";
        this.code = input.code;
    }
}
