import { readFileSync } from "node:fs";

const TENANT_POLICY_CONFIG_PLACEHOLDER = "{{ tenant_policy_config }}";

const GUARDIAN_OUTPUT_CONTRACT = `You may use read-only tool checks to gather any additional context you need before deciding. When you are ready to answer, your final message must be strict JSON.

For low-risk actions, give the final answer directly: {"outcome":"allow"}.

For anything else, use this JSON schema:
{
  "risk_level": "low" | "medium" | "high" | "critical",
  "user_authorization": "unknown" | "low" | "medium" | "high",
  "outcome": "allow" | "deny",
  "rationale": string
}`;

const policyTemplate = readFileSync(
    new URL("./guardian-policy-template.md", import.meta.url),
    "utf8",
);
const policy = readFileSync(new URL("./guardian-policy.md", import.meta.url), "utf8");

/**
 * Codex Guardian's bundled policy prompt, assembled exactly as Codex does from its policy template,
 * default tenant policy, and output contract.
 */
export const PERMISSION_REVIEW_INSTRUCTIONS = `${policyTemplate
    .trimEnd()
    .replace(TENANT_POLICY_CONFIG_PLACEHOLDER, policy.trim())}\n\n${GUARDIAN_OUTPUT_CONTRACT}\n`;

/** Codex Guardian's developer reminder for every review after the first. */
export const PERMISSION_REVIEW_FOLLOWUP_REMINDER =
    'Use prior reviews as context, not binding precedent. Follow the Workspace Policy. If the user explicitly approves a previously rejected action after being informed of the concrete risks, set outcome to "allow" unless the policy explicitly disallows user overwrites in such cases.';
