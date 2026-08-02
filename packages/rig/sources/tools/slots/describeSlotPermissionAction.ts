import { quoteVisibleExact } from "../../permissions/quoteVisibleExact.js";
import type {
    CreateSlotEntryRequest,
    SlotAction,
    SlotContent,
    SlotName,
    UpdateSlotEntryRequest,
} from "../../protocol/SlotProtocol.js";

type SlotCreateArgs = Omit<CreateSlotEntryRequest, "author">;

export function describeSlotCreatePermissionAction(args: SlotCreateArgs): string {
    return `create ${describeContent(args.content)} in the ${describeSlot(args.slot)} slot for ${describeScope(args)}, described as ${quoteVisibleExact(args.description)}, to ${quoteVisibleExact(args.purpose)}`;
}

export function describeSlotUpdatePermissionAction(
    id: string,
    request: UpdateSlotEntryRequest,
): string {
    const changes: string[] = [];
    if (request.slot !== undefined) {
        changes.push(`move it to the ${describeSlot(request.slot)} slot`);
    }
    if (request.content !== undefined) {
        changes.push(`replace its content with ${describeContent(request.content)}`);
    }
    if (request.description !== undefined) {
        changes.push(`set its description to ${quoteVisibleExact(request.description)}`);
    }
    if (request.purpose !== undefined) {
        changes.push(`set its purpose to ${quoteVisibleExact(request.purpose)}`);
    }
    return `update Happy UI slot entry ${quoteVisibleExact(id)}: ${changes.join("; ") || "make no field changes"}`;
}

export function describeSlotRemovePermissionAction(id: string): string {
    return `remove Happy UI slot entry ${quoteVisibleExact(id)}`;
}

function describeSlot(slot: SlotName): string {
    switch (slot) {
        case "status-line":
            return "status line";
        case "above-composer":
            return "area above the composer";
        case "title":
            return "workspace or project title";
        case "sidebar":
            return "sidebar";
    }
}

function describeScope(args: SlotCreateArgs): string {
    switch (args.scope) {
        case "everywhere":
            return "every project, workspace, and session";
        case "project":
            return `project ${quoteVisibleExact(args.projectId ?? "(missing project ID)")}`;
        case "workspace":
            return `workspace ${quoteVisibleExact(args.workspaceId ?? "(missing workspace ID)")}`;
        case "session":
            return `session ${quoteVisibleExact(args.sessionId ?? "(missing session ID)")}`;
    }
}

function describeContent(content: SlotContent): string {
    switch (content.type) {
        case "text":
            return `text ${quoteVisibleExact(content.markdown)}`;
        case "button":
            return `a button labeled ${quoteVisibleExact(content.label)} that will ${describeAction(content.action)}`;
    }
}

function describeAction(action: SlotAction): string {
    switch (action.type) {
        case "send-current-chat":
            return `send ${quoteVisibleExact(action.message)} to the current chat`;
        case "open-webapp": {
            const destination = [
                `open the webapp ${quoteVisibleExact(action.webapp)}`,
                ...(action.path === undefined ? [] : [`at path ${quoteVisibleExact(action.path)}`]),
                ...(action.query === undefined
                    ? []
                    : [
                          Object.entries(action.query).length === 0
                              ? "with no query parameters"
                              : `with query parameters ${Object.entries(action.query)
                                    .map(
                                        ([key, value]) =>
                                            `${quoteVisibleExact(key)} set to ${quoteVisibleExact(value)}`,
                                    )
                                    .join(", ")}`,
                      ]),
            ];
            return destination.join(" ");
        }
        case "send-chat":
            return `send ${quoteVisibleExact(action.message)} to chat ${quoteVisibleExact(action.sessionId)}`;
        case "draft-chat":
            return `draft ${quoteVisibleExact(action.message)} in chat ${quoteVisibleExact(action.sessionId)}`;
        case "new-chat": {
            const details = [
                action.workspaceId === undefined
                    ? undefined
                    : `in workspace ${quoteVisibleExact(action.workspaceId)}`,
                action.projectId === undefined
                    ? undefined
                    : `in project ${quoteVisibleExact(action.projectId)}`,
                action.model === undefined
                    ? undefined
                    : `using model ${quoteVisibleExact(action.model)}`,
                action.provider === undefined
                    ? undefined
                    : `using provider ${quoteVisibleExact(action.provider)}`,
                action.effort === undefined
                    ? undefined
                    : `at effort ${quoteVisibleExact(action.effort)}`,
                action.serviceTier === undefined ? undefined : "with priority service",
                action.readOnly === true ? "in Read only" : undefined,
                action.title === undefined
                    ? undefined
                    : `titled ${quoteVisibleExact(action.title)}`,
                action.prompt === undefined
                    ? undefined
                    : `with prompt ${quoteVisibleExact(action.prompt)}`,
            ].filter((detail): detail is string => detail !== undefined);
            return `start a new chat${details.length === 0 ? "" : ` ${details.join(", ")}`}`;
        }
    }
}
