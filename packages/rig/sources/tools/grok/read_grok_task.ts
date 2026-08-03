import type { AgentContext, BashSessionSnapshot, ManagedSubagent } from "../../agent/index.js";
import { findManagedSubagent } from "../../agent/context/findManagedSubagent.js";
import type { GrokTaskResult } from "./grokTaskResultSchema.js";

export async function readGrokTask(options: {
    context: AgentContext;
    /** Check on a task without collecting output the model has not seen. */
    peek?: boolean;
    taskId: string;
    timeoutMs?: number;
}): Promise<GrokTaskResult> {
    const terminalId = Number(options.taskId);
    if (Number.isInteger(terminalId) && terminalId >= 0) {
        const snapshot = await options.context.bash.readSession(terminalId, {
            ...(options.peek === true ? { peek: true } : {}),
            waitMs: Math.max(0, options.timeoutMs ?? 0),
        });
        if (snapshot === undefined) {
            return { status: "not_found", task_id: options.taskId };
        }
        return fromTerminalSnapshot(snapshot);
    }

    const subagent =
        options.context.subagents === undefined
            ? undefined
            : findManagedSubagent(options.context.subagents, options.taskId);
    return subagent === undefined
        ? { status: "not_found", task_id: options.taskId }
        : fromManagedSubagent(subagent);
}

function fromTerminalSnapshot(snapshot: BashSessionSnapshot): GrokTaskResult {
    // Only what arrived since the last read; the model already has the rest.
    const output = [snapshot.stdoutDelta, snapshot.stderrDelta].filter(Boolean).join("\n");
    return {
        task_id: String(snapshot.sessionId),
        status:
            snapshot.status === "running"
                ? "running"
                : snapshot.status === "killed"
                  ? "cancelled"
                  : snapshot.exitCode === 0
                    ? "completed"
                    : "failed",
        ...(snapshot.exitCode === null ? {} : { exit_code: snapshot.exitCode }),
        ...(output.length === 0 ? {} : { output }),
    };
}

function fromManagedSubagent(subagent: ManagedSubagent): GrokTaskResult {
    return {
        agent_id: subagent.agentId,
        path: subagent.path,
        status: subagent.status,
        output:
            subagent.status === "running"
                ? subagent.description
                : "The subagent result is delivered to the parent transcript when it completes.",
    };
}
