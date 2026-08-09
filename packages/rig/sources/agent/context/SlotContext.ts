import type {
    CreateSlotEntryRequest,
    SlotEntry,
    SlotEntryFilter,
    UpdateSlotEntryRequest,
} from "../../protocol/SlotProtocol.js";
import type {
    CreateAppletRequest,
    RevertAppletRequest,
    UpdateAppletRequest,
    Applet,
} from "../../protocol/AppletProtocol.js";
import type { FileSystemContext } from "./FileSystemContext.js";

/**
 * How an agent reaches Happy's UI slots and applets. The author session is baked in by whoever
 * builds this context; a tool can never claim another agent's authorship through arguments.
 */
export interface SlotContext {
    createEntry(request: Omit<CreateSlotEntryRequest, "author">): Promise<SlotEntry>;
    createApplet(
        request: Omit<CreateAppletRequest, "authorSessionId">,
        sourceFileSystem?: FileSystemContext,
    ): Promise<Applet>;
    listEntries(filter?: SlotEntryFilter): Promise<readonly SlotEntry[]>;
    listApplets(): Promise<readonly Applet[]>;
    removeEntry(id: string): Promise<SlotEntry>;
    revertApplet(name: string, request: RevertAppletRequest): Promise<Applet>;
    updateEntry(id: string, request: UpdateSlotEntryRequest): Promise<SlotEntry>;
    updateApplet(
        name: string,
        request: UpdateAppletRequest,
        sourceFileSystem?: FileSystemContext,
    ): Promise<Applet>;
}
