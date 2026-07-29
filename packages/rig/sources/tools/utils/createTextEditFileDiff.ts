import type { FileDiff } from "../../agent/ToolResultPresentation.js";
import {
    BoundedFileDiffCollector,
    MAX_FILE_DIFF_PRESENTATION_LINE_CHARACTERS,
    MAX_FILE_DIFF_PRESENTATION_LINES,
} from "./BoundedFileDiffCollector.js";
import type { MutableFileDiff } from "./editFileTypes.js";
import { splitLines } from "./path.js";

interface TextReplacement {
    readonly start: number;
    readonly oldText: string;
    readonly newText: string;
}

export function createTextEditFileDiff(
    path: string,
    content: string,
    replacements: readonly TextReplacement[],
): MutableFileDiff {
    let added = 0;
    let deleted = 0;
    let omittedLines = 0;
    let priorLineDelta = 0;
    let retainedLines = 0;
    let scannedOffset = 0;
    let oldStart = 1;
    const hunks: MutableFileDiff["hunks"] = [];

    for (const replacement of replacements) {
        const oldLines = splitReplacementLines(replacement.oldText);
        const newLines = splitReplacementLines(replacement.newText);
        added += newLines.length;
        deleted += oldLines.length;
        oldStart += countNewlines(content, scannedOffset, replacement.start);
        scannedOffset = replacement.start;

        const lines: MutableFileDiff["hunks"][number]["lines"] = [];
        for (const [kind, texts] of [
            ["delete", oldLines],
            ["add", newLines],
        ] as const) {
            for (const text of texts) {
                if (retainedLines < MAX_FILE_DIFF_PRESENTATION_LINES) {
                    lines.push({ kind, text: truncatePresentationText(text) });
                    retainedLines += 1;
                } else {
                    omittedLines += 1;
                }
            }
        }
        if (lines.length > 0) {
            hunks.push({ lines, newStart: oldStart + priorLineDelta, oldStart });
        }
        priorLineDelta += newLines.length - oldLines.length;
    }

    return {
        hunks,
        kind: "update",
        ...(omittedLines === 0 ? {} : { added, deleted, omittedLines }),
        path: truncatePresentationText(path),
    };
}

export function createWholeFileDiff(
    path: string,
    previousContent: string | undefined,
    nextContent: string,
): MutableFileDiff {
    if (previousContent !== undefined) {
        return createTextEditFileDiff(path, previousContent, [
            { start: 0, oldText: previousContent, newText: nextContent },
        ]);
    }

    const collector = new BoundedFileDiffCollector();
    collector.addWholeFile(path, "add", splitReplacementLines(nextContent));
    const bounded = collector.finish().files[0];
    if (bounded === undefined) return { hunks: [], kind: "add", path };
    return mutableFileDiff(bounded);
}

function splitReplacementLines(text: string): string[] {
    const lines = splitLines(text);
    if (lines.at(-1) === "" && /(?:\r\n|\r|\n)$/u.test(text)) lines.pop();
    return lines;
}

function mutableFileDiff(diff: FileDiff): MutableFileDiff {
    return {
        ...diff,
        hunks: diff.hunks.map((hunk) => ({
            ...hunk,
            lines: hunk.lines.map((line) => ({ ...line })),
        })),
    };
}

function countNewlines(content: string, start: number, end: number): number {
    let count = 0;
    for (let index = start; index < end; index++) {
        if (content[index] === "\n") count += 1;
    }
    return count;
}

function truncatePresentationText(text: string): string {
    let characterCount = 0;
    let end = 0;
    for (const character of text) {
        if (characterCount === MAX_FILE_DIFF_PRESENTATION_LINE_CHARACTERS) break;
        characterCount += 1;
        end += character.length;
    }
    return end === text.length ? text : text.slice(0, end);
}
