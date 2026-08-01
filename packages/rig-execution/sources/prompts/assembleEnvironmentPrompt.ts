import type { ExecutorModelProfile } from "@/ExecutorModelProfile.js";
import type { ExecutorEnvironment } from "@/prompts/ExecutorEnvironment.js";

export function assembleEnvironmentPrompt(options: {
    environment: ExecutorEnvironment;
    profiles: readonly ExecutorModelProfile[];
}): string {
    const { environment } = options;
    return [
        "# Environment",
        `- Primary working directory: ${environment.primaryWorkingDirectory}`,
        `- Platform: ${environment.platform}`,
        `- Shell: ${environment.shell}`,
        `- OS version: ${environment.osVersion}`,
        "- Scratch directory: `.context/` in the working directory. Strongly prefer it for temporary files, throwaway scripts, and notes or instructions for other agents; keep it gitignored (add the entry if missing) unless there is a real reason not to, and never commit it.",
        "",
        "## Available models",
        ...options.profiles.map(
            (profile) =>
                `- ${profile.name} — model ID: \`${profile.id}\`; provider ID: \`${profile.providerId}\``,
        ),
    ].join("\n");
}
