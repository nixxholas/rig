import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const MAX_REPORTED_ERRORS = 8;

export function formatInvalidToolArguments(
    toolName: string,
    schema: TSchema,
    argumentsValue: unknown,
): string {
    const errors = [...Value.Errors(schema, argumentsValue)];
    const shown = errors.slice(0, MAX_REPORTED_ERRORS).map((error) => {
        const path = formatPath(error.path);
        return `- ${path}: ${error.message}`;
    });
    const omitted = errors.length - shown.length;
    if (omitted > 0) shown.push(`- ${omitted} more validation error${omitted === 1 ? "" : "s"}`);

    return `Invalid arguments for tool '${toolName}':\n${shown.join("\n")}`;
}

function formatPath(path: string): string {
    if (path === "") return "arguments";
    return path
        .split("/")
        .slice(1)
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
        .join(".");
}
