import type { SessionSecretContext } from "./SessionSecretContext.js";

export function createSecretInstructions(context: SessionSecretContext): string | undefined {
    const references = context.references();
    if (references.length === 0) return undefined;
    return [
        "# Secrets",
        "The following secret bundles are attached to this session. Values are unavailable to you directly. Set a shell command's `secrets` argument to the IDs of only the bundles that command needs. Selecting any secret requires reviewed Full-access execution for that exact command. Model-available environment bundles are injected into the selected command; managed credentials may instead activate a scoped proxy without exposing the source credential. Use an empty array when the command needs none.",
        ...references.map(
            (secret) =>
                `- ${JSON.stringify(secret.id)}: ${secret.description}\n  Environment variables: ${secret.environmentVariables.join(", ")}`,
        ),
    ].join("\n");
}
