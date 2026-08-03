/**
 * What a replicated transcript is allowed to say about one tool call.
 *
 * A shared session crosses a privacy boundary: the friend watching it is on
 * another machine, and Murmur cannot take back what a member already received.
 * So a tool call replicates as a description of the action and its outcome
 * rather than as the payload the agent saw.
 *
 * Each tool owns this the way it owns `shouldReviewInAutoMode`. A tool that
 * says nothing here is not a mistake and is not a gap to be patched centrally:
 * it simply has no summary the product can vouch for, and its raw call and
 * result are never replicated. That is what keeps the boundary correct as tools
 * are added, including tools Rig does not write, such as MCP and plugin tools.
 */
export interface SharedToolActivity {
    /**
     * One human-readable sentence describing what the agent did or how it went.
     *
     * It never carries what came back: not file contents, not command output,
     * not search results, not a fetched page. Naming the file, the command, or
     * the query is the point of the sentence; quoting the answer is not.
     *
     * Naming is not free either. A path, a URL, or a command line can itself be
     * the sensitive thing, and a command can run to thousands of characters
     * carrying a whole file with it. A sentence that names something unbounded
     * abbreviates it and says so.
     */
    readonly summary?: string;
    /**
     * The owner may deliberately replicate this tool's raw call and result.
     *
     * Absent means never, and absent is the default for every tool. Disclosure
     * is opt-in per tool and then opt-in per share, so a tool whose result is
     * sensitive by nature cannot be disclosed by an owner clicking through.
     */
    readonly disclosable?: true;
}
