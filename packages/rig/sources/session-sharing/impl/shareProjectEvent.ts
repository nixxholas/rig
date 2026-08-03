import type { SessionEvent } from "../../protocol/index.js";
import type { SharedToolOutput } from "../SharedToolOutput.js";
import { shareProjectMessage } from "./shareProjectMessage.js";
import { shareProjectToolCall, shareProjectToolResult } from "./shareProjectToolBlock.js";
import {
    shareExplanation,
    shareFlag,
    shareInteger,
    sharePick,
    shareRecord,
    shareText,
    shareTextList,
} from "./shareReadValue.js";

/**
 * One session event, rebuilt field by field for a friend.
 *
 * Events are where the transcript's lifecycle lives — turns starting and
 * finishing, steering, permission decisions, failures — and they are also where
 * payload hides: a reset carries the whole transcript, a finished shell command
 * carries its output, a permission review carries the reviewer's own reasoning.
 *
 * An event type with no case here is not replicated at all. That is the
 * fail-closed default and it is what a new event type gets until somebody
 * decides what it means to hand it to another person.
 */
export function shareProjectEvent(
    event: SessionEvent,
    toolOutput: SharedToolOutput,
): Record<string, unknown> | undefined {
    const data = shareRecord(event.data) ?? {};
    const payload = shareProjectEventData(event.type, data, toolOutput);
    return payload === undefined ? undefined : { type: event.type, data: payload };
}

function shareProjectEventData(
    type: SessionEvent["type"],
    data: Record<string, unknown>,
    toolOutput: SharedToolOutput,
): Record<string, unknown> | undefined {
    switch (type) {
        case "abort_requested":
            return {
                ...sharePick(data, ["runId"], shareText),
                ...(data.continuePendingSteering === true ? { continuePendingSteering: true } : {}),
            };

        case "agent_event": {
            const inner = shareProjectAgentLoopEvent(shareRecord(data.event), toolOutput);
            return inner === undefined
                ? undefined
                : { event: inner, ...sharePick(data, ["runId"], shareText) };
        }

        case "agent_message": {
            const message = shareProjectMessage(data.message, toolOutput);
            return message === undefined
                ? undefined
                : { message, ...sharePick(data, ["runId"], shareText) };
        }

        case "external_tool_call_requested":
        case "external_tool_call_resolved": {
            // An external tool runs outside Rig entirely, so neither its
            // arguments nor its result is ours to describe or to disclose.
            const call = shareRecord(data.call);
            if (call === undefined) return undefined;
            const definition = shareRecord(call.definition);
            return {
                call: {
                    ...sharePick(call, ["id", "runId", "status", "toolCallId"], shareText),
                    ...sharePick(call, ["createdAt", "toolCallIndex"], shareInteger),
                    ...(definition === undefined
                        ? {}
                        : { definition: sharePick(definition, ["name"], shareText) }),
                },
            };
        }

        case "goal_changed": {
            const goal = shareRecord(data.goal);
            return {
                goal:
                    goal === undefined
                        ? null
                        : {
                              ...sharePick(goal, ["objective", "status"], shareText),
                              ...sharePick(goal, ["createdAt", "updatedAt"], shareInteger),
                          },
            };
        }

        case "message_submitted": {
            const message = shareProjectMessage(data.message, toolOutput);
            return message === undefined
                ? undefined
                : {
                      message,
                      ...sharePick(data, ["delivery", "displayText", "runId", "source"], shareText),
                  };
        }

        case "run_error":
            return {
                ...sharePick(data, ["runId"], shareText),
                ...sharePick(data, ["errorMessage"], shareExplanation),
                ...sharePick(data, ["modelLocked"], shareFlag),
                ...(data.startupInterruption === true ? { startupInterruption: true } : {}),
            };

        case "run_finished":
            // `attachments` name files on the owner's disk rather than
            // describing what the turn did.
            return {
                ...sharePick(data, ["agentRunId", "runId", "stopReason"], shareText),
                ...sharePick(data, ["errorMessage"], shareExplanation),
                ...sharePick(data, ["modelLocked"], shareFlag),
            };

        case "run_started":
            return sharePick(data, ["kind", "runId"], shareText);

        case "session_archived":
            return sharePick(data, ["archived"], shareFlag);

        case "session_reset":
        case "session_rewound":
            // The snapshot is the agent's private state, and the transcript
            // window is the whole conversation again; only the messages travel,
            // and only through the same projection every message goes through.
            return {
                ...sharePick(data, ["messageId"], shareText),
                transcript: shareProjectTranscriptWindow(data.transcript, toolOutput),
            };

        case "session_workspace_archived":
            return sharePick(data, ["workspaceId"], shareText);

        case "shell_command_finished":
            // The output of a command the user ran belongs to no tool
            // definition, so nothing can vouch for disclosing it.
            return {
                ...sharePick(data, ["command", "commandId"], shareText),
                ...sharePick(data, ["exitCode"], shareInteger),
                ...sharePick(data, ["timedOut"], shareFlag),
                ...(data.exitCode === null ? { exitCode: null } : {}),
            };

        case "shell_command_started":
            return sharePick(data, ["command", "commandId"], shareText);

        case "steering_applied":
            return {
                messageIds: shareTextList(data.messageIds) ?? [],
                ...sharePick(data, ["runId"], shareText),
            };

        case "subagents_suspended":
            return sharePick(data, ["displayText"], shareText);

        case "system_notice": {
            const message = shareProjectMessage(data.message, toolOutput);
            return message === undefined ? undefined : { message };
        }

        case "user_input_detached":
            return sharePick(data, ["reason", "requestId"], shareText);

        case "user_input_requested":
            return {
                ...sharePick(data, ["requestId"], shareText),
                ...sharePick(data, ["autoResolutionMs"], shareInteger),
                questions: shareProjectQuestions(data.questions),
            };

        case "user_input_resolved": {
            const answers = shareRecord(data.answers);
            return {
                ...sharePick(data, ["requestId", "status"], shareText),
                ...(answers === undefined
                    ? {}
                    : { answers: sharePick(answers, Object.keys(answers), shareTextList) }),
            };
        }

        case "workflow_changed": {
            // `code` is the workflow's own source, `log` and `output` are what
            // it produced, and none of the three is a description of the run.
            const update = shareRecord(data.update);
            if (update === undefined) return undefined;
            return {
                update: {
                    ...sharePick(
                        update,
                        ["description", "error", "name", "phase", "runId", "status", "taskId"],
                        shareText,
                    ),
                    ...sharePick(update, ["agentCount", "finishedAt", "startedAt"], shareInteger),
                },
            };
        }

        default:
            return undefined;
    }
}

function shareProjectAgentLoopEvent(
    event: Record<string, unknown> | undefined,
    toolOutput: SharedToolOutput,
): Record<string, unknown> | undefined {
    if (event === undefined) return undefined;
    const type = shareText(event.type);

    switch (type) {
        case "context_compaction_started":
        case "context_compaction_finished":
        case "context_compacted":
            return {
                type,
                ...sharePick(event, ["compactionId", "reason", "status"], shareText),
                ...sharePick(event, ["errorMessage"], shareExplanation),
                ...sharePick(
                    event,
                    [
                        "compactedMessageCount",
                        "elapsedMs",
                        "estimatedTokensAfter",
                        "estimatedTokensBefore",
                    ],
                    shareInteger,
                ),
            };

        case "inference_iteration_start":
            return {
                type,
                ...sharePick(event, ["messageId"], shareText),
                ...sharePick(event, ["iteration"], shareInteger),
            };

        case "steering_applied":
            return { type, messageIds: shareTextList(event.messageIds) ?? [] };

        case "tool_execution_start": {
            const toolCall = shareRecord(event.toolCall);
            if (toolCall === undefined) return undefined;
            const projected = shareProjectToolCall(toolCall, toolOutput);
            return projected === undefined ? undefined : { type, toolCall: projected };
        }

        case "tool_execution_end": {
            const result = shareRecord(event.result);
            if (result === undefined) return undefined;
            const projected = shareProjectToolResult(result, toolOutput);
            return projected === undefined ? undefined : { type, result: projected };
        }

        // A review's `action` is built out of the tool's raw arguments — the
        // keystrokes being sent, the whole command and the owner's absolute
        // working directory, the URL being fetched — and its `reason` is prose
        // written by a reviewer that had just read all of it. Neither was
        // written for a third party. The tool call beside these events already
        // carries the sentence its own definition wrote, which is what tells a
        // friend what was being attempted.
        case "permission_review_started":
            return { type, ...sharePick(event, ["toolCallId", "toolName"], shareText) };

        case "permission_review":
            return {
                type,
                ...sharePick(
                    event,
                    ["decision", "risk", "toolCallId", "userAuthorization"],
                    shareText,
                ),
            };

        case "temporary_full_access_started":
            return {
                type,
                ...sharePick(event, ["risk", "toolCallId", "userAuthorization"], shareText),
            };

        case "permission_denial_limit_reached":
            return { type };

        case "background_process_exited":
            return {
                type,
                ...sharePick(event, ["command", "status"], shareText),
                ...sharePick(event, ["exitCode", "processId"], shareInteger),
                ...(event.exitCode === null ? { exitCode: null } : {}),
            };

        case "background_processes_stopped":
            return { type, ...sharePick(event, ["count"], shareInteger) };

        case "background_processes_changed":
            // The count is the fact; the per-process snapshots carry the
            // commands and their captured output.
            return { type, ...sharePick(event, ["running"], shareInteger) };

        default:
            // Live progress and status labels are the tool's own words about
            // work still in flight, so they never become durable history here.
            return undefined;
    }
}

function shareProjectTranscriptWindow(
    value: unknown,
    toolOutput: SharedToolOutput,
): Record<string, unknown> {
    const window = shareRecord(value);
    const messages = Array.isArray(window?.messages) ? window.messages : [];
    return {
        complete: window?.complete === true,
        messages: messages.flatMap((message) => {
            const projected = shareProjectMessage(message, toolOutput);
            return projected === undefined ? [] : [projected];
        }),
    };
}

function shareProjectQuestions(value: unknown): readonly Record<string, unknown>[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        const question = shareRecord(entry);
        if (question === undefined) return [];
        const options = Array.isArray(question.options) ? question.options : [];
        return [
            {
                ...sharePick(question, ["header", "question"], shareText),
                ...(question.multiSelect === undefined
                    ? {}
                    : { multiSelect: question.multiSelect === true }),
                options: options.flatMap((item) => {
                    const option = shareRecord(item);
                    return option === undefined
                        ? []
                        : [sharePick(option, ["description", "label"], shareText)];
                }),
            },
        ];
    });
}
