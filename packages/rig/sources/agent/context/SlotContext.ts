import type {
    CreateSlotEntryRequest,
    SlotEntry,
    SlotEntryFilter,
    UpdateSlotEntryRequest,
} from "../../protocol/SlotProtocol.js";
import type {
    CreateWebappRequest,
    RevertWebappRequest,
    UpdateWebappRequest,
    Webapp,
} from "../../protocol/WebappProtocol.js";
import type { FileSystemContext } from "./FileSystemContext.js";

/**
 * How an agent reaches Happy's UI slots and webapps. The author session is baked in by whoever
 * builds this context; a tool can never claim another agent's authorship through arguments.
 */
export interface SlotContext {
    createEntry(request: Omit<CreateSlotEntryRequest, "authorSessionId">): SlotEntry;
    createWebapp(
        request: Omit<CreateWebappRequest, "authorSessionId">,
        sourceFileSystem?: FileSystemContext,
    ): Promise<Webapp>;
    listEntries(filter?: SlotEntryFilter): readonly SlotEntry[];
    listWebapps(): readonly Webapp[];
    removeEntry(id: string): SlotEntry;
    revertWebapp(name: string, request: RevertWebappRequest): Webapp;
    updateEntry(id: string, request: UpdateSlotEntryRequest): SlotEntry;
    updateWebapp(
        name: string,
        request: UpdateWebappRequest,
        sourceFileSystem?: FileSystemContext,
    ): Promise<Webapp>;
}
