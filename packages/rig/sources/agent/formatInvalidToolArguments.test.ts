import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { formatInvalidToolArguments } from "./formatInvalidToolArguments.js";

describe("formatInvalidToolArguments", () => {
    it("reports every invalid field with its path and constraint", () => {
        const schema = Type.Object(
            {
                command: Type.String(),
                timeout: Type.Optional(Type.Number({ maximum: 600_000, minimum: 0 })),
            },
            { additionalProperties: false },
        );

        expect(
            formatInvalidToolArguments("Bash", schema, {
                command: 42,
                extra: true,
                timeout: 900_000,
            }),
        ).toBe(
            [
                "Invalid arguments for tool 'Bash':",
                "- extra: Unexpected property",
                "- command: Expected string",
                "- timeout: Expected number to be less or equal to 600000",
            ].join("\n"),
        );
    });
});
