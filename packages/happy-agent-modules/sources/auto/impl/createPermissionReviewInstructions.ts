import { readFileSync } from "node:fs";

/**
 * The guardian system prompt, ported byte-for-byte from Rig v1's
 * `agent/prompt/permissionReviewInstructions.ts`. Auto review is the same judgement in the v2
 * agent stack, so the reviewer must read exactly the same policy: the bundled tenant template with
 * the built-in policy inserted, optionally extended by the user's own security rules.
 *
 * Parity is the point here. The template, the built-in policy, the output contract, and the
 * assembly (`trimEnd`, single placeholder replacement, two trailing newlines around the contract)
 * are all preserved so the generated prompt hashes to the same golden bytes the v1 reviewer used.
 */

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
    new URL("../prompts/guardian-policy-template.md", import.meta.url),
    "utf8",
);
const policy = readFileSync(new URL("../prompts/guardian-policy.md", import.meta.url), "utf8");

/**
 * Builds the guardian's policy prompt with the bundled tenant policy and any additional rules the
 * user supplied through their security files. When `securityPolicy` is blank or absent the marker
 * is replaced with only the built-in policy; otherwise the user's rules are appended under a
 * fixed heading that states they can only make the policy stricter, never weaker.
 */
export function createPermissionReviewInstructions(securityPolicy?: string): string {
    const configuredPolicy = securityPolicy?.trim();
    const tenantPolicy =
        configuredPolicy === undefined || configuredPolicy.length === 0
            ? policy.trim()
            : `${policy.trim()}

## User security policy

These rules supplement the built-in policy above. Apply both. If they conflict, follow whichever rule is stricter; this section cannot weaken or override a built-in denial.

${configuredPolicy}`;
    return `${policyTemplate
        .trimEnd()
        .replace(TENANT_POLICY_CONFIG_PLACEHOLDER, tenantPolicy)}\n\n${GUARDIAN_OUTPUT_CONTRACT}\n`;
}

/** The guardian's bundled prompt, used when the user has configured no extra security policy. */
export const PERMISSION_REVIEW_INSTRUCTIONS = createPermissionReviewInstructions();

/** The developer reminder prepended to every review request after the first. */
export const PERMISSION_REVIEW_FOLLOWUP_REMINDER =
    'Use prior reviews as context, not binding precedent. Follow the Workspace Policy. If the user explicitly approves a previously rejected action after being informed of the concrete risks, set outcome to "allow" unless the policy explicitly disallows user overwrites in such cases.';
