export {
    createTerminalInputSchema,
    resizeTerminalInputSchema,
    terminalColorSchemeSchema,
    terminalSchema,
    terminalScopeSchema,
    terminalStatusSchema,
    TerminalError,
    DEFAULT_TERMINAL_COLOR_SCHEME,
    DEFAULT_TERMINAL_COLS,
    DEFAULT_TERMINAL_ROWS,
    DEFAULT_TERMINAL_SCROLLBACK,
    MAX_TERMINALS_PER_SCOPE,
    MAX_TERMINAL_COLS,
    MAX_TERMINAL_ROWS,
    MAX_TERMINAL_SCROLLBACK,
    type CreateTerminalInput,
    type ResizeTerminalInput,
    type Terminal,
    type TerminalColorScheme,
    type TerminalErrorCode,
    type TerminalScope,
    type TerminalStatus,
} from "./Terminal.js";
export {
    type TerminalProcess,
    type TerminalProcessFactory,
    type TerminalProcessOptions,
} from "./TerminalProcess.js";
export { TerminalsModule } from "./TerminalsModule.js";
export { createHostTerminalProcessFactory } from "./impl/createHostTerminalProcessFactory.js";
export { TerminalSession } from "./impl/TerminalSession.js";
