/**
 * Whether Codex Cloud can deliver an encrypted native agent message to this model.
 *
 * This is intentionally separate from `isCodexV2CollaborationModel`: Luna speaks the v1 tool
 * surface when it is the parent, but Codex v2 parents can still spawn it as an encrypted leaf.
 */
export function isCodexEncryptedAgentTransportModel(modelId: string): boolean {
    return (
        modelId === "openai/gpt-5.6-sol" ||
        modelId === "openai/gpt-5.6-terra" ||
        modelId === "openai/gpt-5.6-luna" ||
        modelId === "openai/gym"
    );
}
