import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { SessionMessage } from "@slopus/happy-providers";

import {
    reasoningOf,
    textOf,
    toolCallsOf,
    type RealGymInference,
    type RealGymSession,
    type RealGymTrace,
} from "./RealGymTrace.js";

/** Write the report and answer with the path, so a run can print where it landed. */
export async function writeRealGymReport(
    path: string,
    traces: readonly RealGymTrace[],
): Promise<string> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, renderRealGymReport(traces), "utf8");
    return path;
}

/** One self-contained page: a summary of every scenario, then its complete trace. */
export function renderRealGymReport(traces: readonly RealGymTrace[]): string {
    const generated = new Date().toISOString();
    return [
        "<!doctype html>",
        '<html lang="en">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        "<title>Real gym report</title>",
        `<style>${STYLE}</style>`,
        "</head>",
        "<body>",
        "<h1>Real gym report</h1>",
        `<p class="meta">Live inference through the real agent collection, its modules, and each vendor's own sign-in — generated ${escape(generated)}.</p>`,
        renderSummary(traces),
        ...traces.map((trace, index) => renderTrace(trace, index)),
        "</body>",
        "</html>",
    ].join("\n");
}

function renderSummary(traces: readonly RealGymTrace[]): string {
    if (traces.length === 0) {
        return '<p class="empty">No scenario ran. Sign in to Codex or Claude Code and run the suite again.</p>';
    }
    const rows = traces.map((trace, index) =>
        [
            "<tr>",
            `<td><a href="#scenario-${index}">${escape(trace.scenario)}</a></td>`,
            `<td>${escape(trace.vendor)}</td>`,
            `<td><code>${escape(trace.model)}</code></td>`,
            `<td>${status(trace)}</td>`,
            `<td>${escape(duration(trace.startedAtMs, trace.finishedAtMs))}</td>`,
            `<td>${trace.inferences.length}</td>`,
            `<td>${countToolCalls(trace)}</td>`,
            `<td>${escape(totalTokens(trace))}</td>`,
            "</tr>",
        ].join(""),
    );
    return [
        "<table class='summary'>",
        "<thead><tr><th>Scenario</th><th>Vendor</th><th>Model</th><th>Outcome</th><th>Duration</th><th>Inferences</th><th>Tool calls</th><th>Tokens</th></tr></thead>",
        "<tbody>",
        ...rows,
        "</tbody>",
        "</table>",
    ].join("\n");
}

function renderTrace(trace: RealGymTrace, index: number): string {
    return [
        `<section class="scenario" id="scenario-${index}">`,
        `<h2>${escape(trace.scenario)} ${status(trace)}</h2>`,
        '<p class="meta">',
        `${escape(trace.vendor)} · <code>${escape(trace.model)}</code> · credential <code>${escape(trace.credential)}</code> · agent <code>${escape(trace.agentId)}</code> · ${escape(duration(trace.startedAtMs, trace.finishedAtMs))} · ${escape(totalTokens(trace))} tokens`,
        "</p>",
        ...(trace.failure === undefined ? [] : [`<p class="failure">${escape(trace.failure)}</p>`]),
        ...(trace.prompt === undefined ? [] : [`<h3>Asked</h3><pre>${escape(trace.prompt)}</pre>`]),
        ...(trace.response === undefined || trace.response.length === 0
            ? []
            : [`<h3>Answered</h3><pre>${escape(trace.response)}</pre>`]),
        renderConfiguration(trace),
        ...trace.sessions.map((session, position) => renderSession(session, position)),
        ...trace.inferences.map((inference, position) => renderInference(inference, position)),
        renderTranscript(trace),
        "</section>",
    ].join("\n");
}

function renderConfiguration(trace: RealGymTrace): string {
    return [
        "<h3>Agent</h3>",
        "<table class='facts'>",
        row("Modules", trace.modules.map((name) => `<code>${escape(name)}</code>`).join(" ")),
        row(
            "Models offered",
            trace.models.map((id) => `<code>${escape(id)}</code>`).join(" ") || "none",
        ),
        row("Working directory", `<code>${escape(trace.environment.workingDirectory)}</code>`),
        row(
            "Platform",
            `${escape(trace.environment.platform)} ${escape(trace.environment.osVersion)}`,
        ),
        row("Shell", `<code>${escape(trace.environment.shell)}</code>`),
        "</table>",
    ].join("\n");
}

function renderSession(session: RealGymSession, position: number): string {
    return [
        "<details class='session'>",
        `<summary>Session ${position + 1} — system prompt (${session.instructions.length.toLocaleString("en-US")} characters) and ${session.tools.length} tools</summary>`,
        "<h4>Tools the model was shown</h4>",
        session.tools.length === 0
            ? "<p class='meta'>None.</p>"
            : [
                  "<table class='tools'>",
                  "<thead><tr><th>Tool</th><th>Description</th><th>Parameters</th></tr></thead>",
                  "<tbody>",
                  ...session.tools.map((tool) =>
                      [
                          "<tr>",
                          `<td><code>${escape(tool.name)}</code></td>`,
                          `<td>${escape(tool.description ?? "")}</td>`,
                          `<td><pre class="detail">${escape(JSON.stringify(tool.parameters))}</pre></td>`,
                          "</tr>",
                      ].join(""),
                  ),
                  "</tbody>",
                  "</table>",
              ].join("\n"),
        "<h4>Assembled system prompt</h4>",
        `<pre class="prompt">${escape(session.instructions)}</pre>`,
        "</details>",
    ].join("\n");
}

function renderInference(inference: RealGymInference, position: number): string {
    const text = textOf(inference);
    const reasoning = reasoningOf(inference);
    const calls = toolCallsOf(inference);
    return [
        '<details class="inference" open>',
        `<summary>Inference ${position + 1} — ${escape(describeInference(inference))}</summary>`,
        ...(reasoning.length === 0 ? [] : [`<h4>Reasoning</h4><pre>${escape(reasoning)}</pre>`]),
        ...(text.length === 0 ? [] : [`<h4>Text received</h4><pre>${escape(text)}</pre>`]),
        ...(calls.length === 0
            ? []
            : [
                  "<h4>Tools called</h4>",
                  "<table class='tools'><thead><tr><th>Tool</th><th>Arguments</th></tr></thead><tbody>",
                  ...calls.map(
                      (call) =>
                          `<tr><td><code>${escape(call.name)}</code></td><td><pre class="detail">${escape(call.args)}</pre></td></tr>`,
                  ),
                  "</tbody></table>",
              ]),
        ...(inference.failure === undefined
            ? []
            : [`<p class="failure">${escape(inference.failure)}</p>`]),
        "<details><summary>Conversation sent</summary>",
        ...inference.messages.map((message) => renderMessage(message)),
        "</details>",
        "<details><summary>Event stream</summary>",
        "<table class='events'>",
        "<thead><tr><th>At</th><th>Event</th><th>Detail</th></tr></thead>",
        "<tbody>",
        ...inference.events.map(({ atMs, event }) =>
            [
                "<tr>",
                `<td class="at">${atMs} ms</td>`,
                `<td><code>${escape(event.type)}</code></td>`,
                `<td><pre class="detail">${escape(detailOf(event))}</pre></td>`,
                "</tr>",
            ].join(""),
        ),
        "</tbody>",
        "</table>",
        "</details>",
        "</details>",
    ].join("\n");
}

function renderTranscript(trace: RealGymTrace): string {
    if (trace.transcript.length === 0) return "";
    return [
        "<details class='transcript'>",
        `<summary>Durable transcript — ${trace.transcript.length} messages, as a restart would rebuild it</summary>`,
        ...trace.transcript.map((message) => renderMessage(message)),
        "</details>",
    ].join("\n");
}

function renderMessage(message: SessionMessage): string {
    const { role, ...rest } = message;
    return `<div class="message"><span class="role">${escape(role)}</span><pre>${escape(JSON.stringify(rest, null, 2))}</pre></div>`;
}

function describeInference(inference: RealGymInference): string {
    const parts = [
        duration(inference.startedAtMs, inference.finishedAtMs),
        inference.tokens === undefined
            ? "unmeasured"
            : `${inference.tokens.input} in / ${inference.tokens.output} out`,
    ];
    if (inference.doneState !== undefined) parts.push(inference.doneState);
    if (inference.effort !== undefined) parts.push(`effort ${inference.effort}`);
    if (inference.failure !== undefined) parts.push("failed");
    return parts.join(" · ");
}

/** Everything about an event other than its type, so nothing streamed is hidden. */
function detailOf(event: { readonly type: string }): string {
    const { type: _type, ...rest } = event as Record<string, unknown> & { type: string };
    return Object.keys(rest).length === 0 ? "" : JSON.stringify(rest);
}

function row(label: string, value: string): string {
    return `<tr><th>${escape(label)}</th><td>${value}</td></tr>`;
}

function status(trace: RealGymTrace): string {
    return `<span class="status ${trace.outcome}">${escape(trace.outcome)}</span>`;
}

function countToolCalls(trace: RealGymTrace): number {
    return trace.inferences.reduce((total, inference) => total + toolCallsOf(inference).length, 0);
}

function totalTokens(trace: RealGymTrace): string {
    const measured = trace.inferences.filter((inference) => inference.tokens !== undefined);
    if (measured.length === 0) return "unmeasured";
    const input = measured.reduce((sum, one) => sum + (one.tokens?.input ?? 0), 0);
    const output = measured.reduce((sum, one) => sum + (one.tokens?.output ?? 0), 0);
    return `${input} in / ${output} out`;
}

function duration(startedAtMs: number, finishedAtMs: number | undefined): string {
    if (finishedAtMs === undefined) return "unfinished";
    return `${((finishedAtMs - startedAtMs) / 1000).toFixed(2)} s`;
}

function escape(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

const STYLE = `
:root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 15%, transparent); }
body { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0 auto; padding: 32px 24px 64px; max-width: 1100px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 0 0 4px; }
h3 { font-size: 13px; margin: 18px 0 6px; text-transform: uppercase; letter-spacing: .06em; opacity: .7; }
h4 { font-size: 13px; margin: 14px 0 4px; opacity: .7; }
.meta { opacity: .7; margin: 0 0 20px; }
.empty { opacity: .7; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
pre { white-space: pre-wrap; word-break: break-word; margin: 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; }
pre.prompt { max-height: 420px; overflow: auto; }
table { border-collapse: collapse; width: 100%; margin: 0 0 20px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; opacity: .7; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
.facts th { width: 180px; text-transform: none; letter-spacing: 0; font-size: 13px; }
.summary td:first-child { font-weight: 600; }
.scenario { border-top: 1px solid var(--line); padding-top: 24px; margin-top: 24px; }
.status { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); }
.status.passed { color: #12813f; border-color: #12813f66; }
.status.failed { color: #b3261e; border-color: #b3261e66; }
.failure { color: #b3261e; }
.message { margin: 0 0 8px; }
.message .role { display: inline-block; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; opacity: .7; margin-bottom: 2px; }
details { margin: 0 0 12px; }
summary { cursor: pointer; }
.inference, .session, .transcript { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.inference > summary, .session > summary, .transcript > summary { font-weight: 600; }
.events td.at { white-space: nowrap; opacity: .6; }
.events .detail, .tools .detail { border: 0; padding: 0; }
`;
