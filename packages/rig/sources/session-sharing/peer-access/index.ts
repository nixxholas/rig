export { PeerCapabilityContext } from "./PeerCapabilityContext.js";
export type {
    PeerCapabilityContextOptions,
    PeerCapabilityHandle,
    PeerCapabilityRequest,
    ResolvedPeerGrant,
} from "./PeerCapabilityContext.js";
export { resolvePeerCapabilityCeiling } from "./resolvePeerCapabilityCeiling.js";
export {
    describePeerActivityEntry,
    describePeerCapabilitiesActivePhrase,
    describePeerCapabilities,
    describePeerCapability,
    describePeerCapabilityDetail,
    describePeerCapabilityGrantWarning,
} from "./describePeerCapability.js";
export {
    handlePeerTerminalControl,
    PEER_TERMINAL_ATTACH_CONTROL_ID,
    peerTerminalAttachPayloadSchema,
} from "./handlePeerTerminalControl.js";
export type {
    PeerTerminalAttachPayload,
    PeerTerminalControlOptions,
    PeerTerminalControlResult,
} from "./handlePeerTerminalControl.js";
export { resolveOfferablePeerCapabilities } from "./resolveOfferablePeerCapabilities.js";
export type { OfferablePeerCapability } from "./resolveOfferablePeerCapabilities.js";
export {
    MAX_PEER_ATTACHED_TERMINALS,
    peerTerminalEffectiveMode,
    PeerTerminalViewerService,
} from "./PeerTerminalViewerService.js";
export type {
    PeerTerminalAttachRequest,
    PeerTerminalAttachResult,
    PeerTerminalViewerOptions,
} from "./PeerTerminalViewerService.js";
export {
    canProjectOfferPeerTerminals,
    isPeerTerminalConfined,
    PEER_TERMINAL_NEEDS_CONTAINER,
    PEER_TERMINAL_NEEDS_SOLE_MEMBER,
} from "./impl/peerTerminalConfinement.js";
export { createPeerChannelSocket } from "./impl/createPeerChannelSocket.js";
export type { PeerChannelSocketOptions } from "./impl/createPeerChannelSocket.js";
export {
    decodePeerControl,
    decodePeerFrame,
    encodePeerControl,
    encodePeerFrame,
    PEER_FRAME_CONTROL,
    PEER_FRAME_TERMINAL,
} from "./impl/peerChannelFrame.js";
export type { PeerControl, PeerFrame, PeerFrameKind } from "./impl/peerChannelFrame.js";
export { PEER_CAPABILITIES } from "./types.js";
export type {
    PeerAction,
    PeerActionOutcome,
    PeerActivityEntry,
    PeerCapability,
    PeerCapabilityAllowance,
    PeerCapabilityDecision,
    PeerCapabilityDenial,
    PeerCapabilityGrant,
    PeerCapabilityState,
} from "./types.js";
export {
    peerActionOutcomeSchema,
    peerActionSchema,
    peerActivityEntrySchema,
    peerCapabilityGrantSchema,
    peerCapabilitySchema,
    peerCapabilityStateSchema,
} from "./types.js";
