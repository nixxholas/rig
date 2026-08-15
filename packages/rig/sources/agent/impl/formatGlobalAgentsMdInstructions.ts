export function formatGlobalAgentsMdInstructions(text: string): string {
    return `# Global AGENTS.md instructions

These instructions come from the person using Rig and apply to every project.

<INSTRUCTIONS>
${text}
</INSTRUCTIONS>`;
}
