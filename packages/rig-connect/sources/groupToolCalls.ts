import type { ChatElement, ToolCallElement } from "./ChatElement.js";

/**
 * Marks runs of tool calls that belong together.
 *
 * The model issues several calls at once far more often than one, and a UI
 * should draw that burst as a single unit rather than a column of unrelated
 * rows. Adjacency within a turn is what makes them one unit, so the grouping is
 * derived from the list rather than remembered.
 *
 * Only a call whose group actually changed gets a new reference, and the array
 * itself is returned unchanged when nothing did, so grouping never invalidates a
 * consumer's rendering on its own.
 */
export function groupToolCalls(elements: readonly ChatElement[]): readonly ChatElement[] {
    const groupIds = new Map<string, string | undefined>();
    let run: ToolCallElement[] = [];
    const flush = (): void => {
        const groupId = run.length > 1 ? run[0]?.id : undefined;
        for (const element of run) groupIds.set(element.id, groupId);
        run = [];
    };

    for (const element of elements) {
        if (element.kind !== "tool_call") {
            flush();
            continue;
        }
        if (run.length > 0 && run[0]?.turnId !== element.turnId) flush();
        run.push(element);
    }
    flush();

    let changed = false;
    const grouped = elements.map((element) => {
        if (element.kind !== "tool_call") return element;
        const groupId = groupIds.get(element.id);
        if (element.groupId === groupId) return element;
        changed = true;
        if (groupId === undefined) {
            const { groupId: _ungrouped, ...rest } = element;
            return rest;
        }
        return { ...element, groupId };
    });
    return changed ? grouped : elements;
}
