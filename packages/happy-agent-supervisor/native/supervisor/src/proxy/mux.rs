//! The multiplexed link the supervisor shares with the host proxy.
//!
//! One pre-connected descriptor carries every stream, so the sandbox needs no route to anything.
//! The frame layer is deliberately small: an existing multiplexer would pull a dependency tree into
//! the one component that must stay auditable, and the only thing being multiplexed is
//! `open_stream(host, port)` plus its bytes. What the protocol does not skip is per-stream credit,
//! because a single workload connection that stops reading would otherwise stall every other
//! stream sharing the descriptor.

use crate::{SupervisorResult, invalid_input};
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

/// Longest authentication token accepted in the handshake.
pub(crate) const MAX_TOKEN_BYTES: usize = 512;

const MAGIC: [u8; 4] = *b"HPX1";
const HANDSHAKE_ACCEPTED: u8 = 0;
const FRAME_HEADER_BYTES: usize = 9;
const MAX_PAYLOAD_BYTES: usize = 65_535;
const MAX_CHUNK_BYTES: usize = 32 * 1024;
const MAX_HOST_BYTES: usize = 255;
const MAX_MESSAGE_BYTES: usize = 512;
const INITIAL_WINDOW_BYTES: u32 = 256 * 1024;
const WINDOW_UPDATE_THRESHOLD_BYTES: u32 = INITIAL_WINDOW_BYTES / 2;
const MAX_CONCURRENT_STREAMS: usize = 256;

const FRAME_OPEN: u8 = 1;
const FRAME_OPENED: u8 = 2;
const FRAME_REFUSED: u8 = 3;
const FRAME_DATA: u8 = 4;
const FRAME_END: u8 = 5;
const FRAME_RESET: u8 = 6;
const FRAME_WINDOW: u8 = 7;

/// Why the host would not open a stream. Each front-end renders these in its own vocabulary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RefusalReason {
    /// The command's policy does not permit this destination.
    Blocked,
    /// The destination name could not be resolved.
    Unresolvable,
    /// The destination resolved but could not be reached.
    Unreachable,
}

impl RefusalReason {
    fn from_code(code: u8) -> Self {
        match code {
            1 => Self::Blocked,
            2 => Self::Unresolvable,
            _ => Self::Unreachable,
        }
    }
}

/// A refused `open_stream`, carrying enough detail for a front-end to answer its client honestly.
#[derive(Clone, Debug)]
pub(crate) struct OpenFailure {
    pub(crate) reason: RefusalReason,
    pub(crate) message: String,
}

impl OpenFailure {
    fn new(reason: RefusalReason, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }
}

pub(crate) struct Mux {
    link: File,
    write_lock: Mutex<()>,
    registry: Mutex<Registry>,
}

struct Registry {
    streams: HashMap<u32, Arc<StreamShared>>,
    next_stream_id: u32,
    closed: bool,
}

struct StreamShared {
    state: Mutex<StreamState>,
    signal: Condvar,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum OpenState {
    Pending,
    Opened,
    Refused,
}

struct StreamState {
    open: OpenState,
    refusal: Option<OpenFailure>,
    inbound: VecDeque<u8>,
    inbound_ended: bool,
    aborted: bool,
    send_ended: bool,
    send_credit: u32,
    unreported_window: u32,
}

impl Mux {
    /// Authenticates on the pre-connected descriptor and starts the reader.
    ///
    /// A handshake that is not accepted returns an error, and the caller refuses to run the
    /// workload at all. There is no path here that degrades into direct network access.
    pub(crate) fn connect(link: File, token: &str) -> SupervisorResult<Arc<Self>> {
        if token.is_empty() || token.len() > MAX_TOKEN_BYTES {
            return Err(invalid_input("outgoing proxy token has an unusable length").into());
        }
        let mux = Arc::new(Self {
            link,
            write_lock: Mutex::new(()),
            registry: Mutex::new(Registry {
                streams: HashMap::new(),
                next_stream_id: 1,
                closed: false,
            }),
        });
        let mut hello = Vec::with_capacity(MAGIC.len() + 2 + token.len());
        hello.extend_from_slice(&MAGIC);
        hello.extend_from_slice(&(token.len() as u16).to_be_bytes());
        hello.extend_from_slice(token.as_bytes());
        mux.write_all(&hello)?;
        let mut reply = [0_u8; MAGIC.len() + 1];
        (&mux.link).read_exact(&mut reply).map_err(|error| {
            std::io::Error::other(format!("outgoing proxy did not answer the handshake: {error}"))
        })?;
        if reply[..MAGIC.len()] != MAGIC {
            return Err(invalid_input("outgoing proxy answered with an unknown protocol").into());
        }
        if reply[MAGIC.len()] != HANDSHAKE_ACCEPTED {
            return Err(
                invalid_input("outgoing proxy refused the command authentication token").into(),
            );
        }
        Ok(mux)
    }

    /// Starts the frame reader.
    ///
    /// This is deliberately separate from the handshake: the workload is forked between the two,
    /// and forking a process that already has threads leaves the child able to wait forever on a
    /// lock whose owner did not survive the fork.
    pub(crate) fn start_reader(self: &Arc<Self>) -> SupervisorResult<()> {
        let reader = Arc::clone(self);
        std::thread::Builder::new()
            .name("supervisor-mux".to_string())
            .spawn(move || reader.read_frames())?;
        Ok(())
    }

    /// Asks the host to connect to `host:port` and waits for its verdict.
    pub(crate) fn open(
        self: &Arc<Self>,
        host: &str,
        port: u16,
    ) -> Result<Arc<MuxStream>, OpenFailure> {
        if host.is_empty() || host.len() > MAX_HOST_BYTES {
            return Err(OpenFailure::new(
                RefusalReason::Blocked,
                "the requested host name is not usable",
            ));
        }
        let shared = Arc::new(StreamShared {
            state: Mutex::new(StreamState {
                open: OpenState::Pending,
                refusal: None,
                inbound: VecDeque::new(),
                inbound_ended: false,
                aborted: false,
                send_ended: false,
                send_credit: INITIAL_WINDOW_BYTES,
                unreported_window: 0,
            }),
            signal: Condvar::new(),
        });
        let id = {
            let mut registry = guard(&self.registry);
            if registry.closed {
                return Err(link_closed());
            }
            if registry.streams.len() >= MAX_CONCURRENT_STREAMS {
                return Err(OpenFailure::new(
                    RefusalReason::Unreachable,
                    "too many concurrent sandbox connections",
                ));
            }
            let Some(next) = registry.next_stream_id.checked_add(1) else {
                return Err(link_closed());
            };
            let id = registry.next_stream_id;
            registry.next_stream_id = next;
            registry.streams.insert(id, Arc::clone(&shared));
            id
        };

        let mut payload = Vec::with_capacity(4 + host.len());
        payload.extend_from_slice(&port.to_be_bytes());
        payload.extend_from_slice(&(host.len() as u16).to_be_bytes());
        payload.extend_from_slice(host.as_bytes());
        if self.write_frame(FRAME_OPEN, id, &payload).is_err() {
            self.fail_link();
            return Err(link_closed());
        }

        let mut state = guard(&shared.state);
        while state.open == OpenState::Pending && !state.aborted {
            state = wait(&shared.signal, state);
        }
        if state.open != OpenState::Opened {
            let failure = state.refusal.clone().unwrap_or_else(link_closed);
            drop(state);
            self.forget(id);
            return Err(failure);
        }
        drop(state);
        Ok(Arc::new(MuxStream {
            mux: Arc::clone(self),
            id,
            shared,
        }))
    }

    fn read_frames(self: Arc<Self>) {
        let mut header = [0_u8; FRAME_HEADER_BYTES];
        let mut payload = vec![0_u8; MAX_PAYLOAD_BYTES];
        loop {
            if (&self.link).read_exact(&mut header).is_err() {
                break;
            }
            let kind = header[0];
            let id = u32::from_be_bytes([header[1], header[2], header[3], header[4]]);
            let length = u32::from_be_bytes([header[5], header[6], header[7], header[8]]) as usize;
            if length > MAX_PAYLOAD_BYTES {
                break;
            }
            if (&self.link).read_exact(&mut payload[..length]).is_err() {
                break;
            }
            if !self.apply_frame(kind, id, &payload[..length]) {
                break;
            }
        }
        self.fail_link();
    }

    fn apply_frame(&self, kind: u8, id: u32, payload: &[u8]) -> bool {
        let Some(shared) = self.lookup(id) else {
            // A frame for a stream this side already forgot is normal: the two directions close
            // independently. Nothing else in the link is affected by ignoring it.
            return true;
        };
        let mut state = guard(&shared.state);
        match kind {
            FRAME_OPENED => {
                if state.open == OpenState::Pending {
                    state.open = OpenState::Opened;
                }
            }
            FRAME_REFUSED => {
                if state.open == OpenState::Pending {
                    state.open = OpenState::Refused;
                    let code = payload.first().copied().unwrap_or(0);
                    let message = String::from_utf8_lossy(
                        &payload[1.min(payload.len())..payload.len().min(MAX_MESSAGE_BYTES)],
                    )
                    .into_owned();
                    state.refusal = Some(OpenFailure::new(
                        RefusalReason::from_code(code),
                        if message.is_empty() {
                            "the host proxy refused the connection".to_string()
                        } else {
                            message
                        },
                    ));
                }
            }
            FRAME_DATA => {
                // Data past the window the host was granted is a protocol violation, and the only
                // safe response on a trusted link is to stop believing it.
                if state.inbound.len() + payload.len() > INITIAL_WINDOW_BYTES as usize {
                    return false;
                }
                state.inbound.extend(payload.iter().copied());
            }
            FRAME_END => state.inbound_ended = true,
            FRAME_RESET => state.aborted = true,
            FRAME_WINDOW => {
                let granted = u32::from_be_bytes([
                    payload.first().copied().unwrap_or(0),
                    payload.get(1).copied().unwrap_or(0),
                    payload.get(2).copied().unwrap_or(0),
                    payload.get(3).copied().unwrap_or(0),
                ]);
                state.send_credit = state.send_credit.saturating_add(granted);
            }
            _ => return false,
        }
        shared.signal.notify_all();
        true
    }

    fn lookup(&self, id: u32) -> Option<Arc<StreamShared>> {
        guard(&self.registry).streams.get(&id).map(Arc::clone)
    }

    fn forget(&self, id: u32) {
        guard(&self.registry).streams.remove(&id);
    }

    fn fail_link(&self) {
        let streams = {
            let mut registry = guard(&self.registry);
            registry.closed = true;
            std::mem::take(&mut registry.streams)
        };
        for shared in streams.values() {
            let mut state = guard(&shared.state);
            state.aborted = true;
            state.inbound_ended = true;
            if state.open == OpenState::Pending {
                state.open = OpenState::Refused;
                state.refusal = Some(link_closed());
            }
            shared.signal.notify_all();
        }
    }

    fn write_frame(&self, kind: u8, id: u32, payload: &[u8]) -> std::io::Result<()> {
        let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + payload.len());
        frame.push(kind);
        frame.extend_from_slice(&id.to_be_bytes());
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(payload);
        self.write_all(&frame)
    }

    fn write_all(&self, bytes: &[u8]) -> std::io::Result<()> {
        let _serialized = guard(&self.write_lock);
        (&self.link).write_all(bytes)
    }
}

/// One workload connection carried over the shared link.
pub(crate) struct MuxStream {
    mux: Arc<Mux>,
    id: u32,
    shared: Arc<StreamShared>,
}

impl MuxStream {
    /// Sends bytes upstream, waiting for credit rather than buffering without bound.
    pub(crate) fn send(&self, bytes: &[u8]) -> std::io::Result<()> {
        let mut offset = 0;
        while offset < bytes.len() {
            let allowed = {
                let mut state = guard(&self.shared.state);
                while state.send_credit == 0 && !state.aborted {
                    state = wait(&self.shared.signal, state);
                }
                if state.aborted {
                    return Err(std::io::Error::from(std::io::ErrorKind::ConnectionReset));
                }
                let allowed = (bytes.len() - offset)
                    .min(MAX_CHUNK_BYTES)
                    .min(state.send_credit as usize);
                state.send_credit -= allowed as u32;
                allowed
            };
            self.mux
                .write_frame(FRAME_DATA, self.id, &bytes[offset..offset + allowed])?;
            offset += allowed;
        }
        Ok(())
    }

    /// Reads bytes the host sent, returning zero once the destination is finished.
    pub(crate) fn receive(&self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let (copied, consumed_total) = {
            let mut state = guard(&self.shared.state);
            while state.inbound.is_empty() && !state.inbound_ended && !state.aborted {
                state = wait(&self.shared.signal, state);
            }
            if state.inbound.is_empty() {
                if state.aborted && !state.inbound_ended {
                    return Err(std::io::Error::from(std::io::ErrorKind::ConnectionReset));
                }
                return Ok(0);
            }
            let copied = {
                let (front, back) = state.inbound.as_slices();
                let from_front = front.len().min(buffer.len());
                buffer[..from_front].copy_from_slice(&front[..from_front]);
                let from_back = back.len().min(buffer.len() - from_front);
                buffer[from_front..from_front + from_back].copy_from_slice(&back[..from_back]);
                from_front + from_back
            };
            state.inbound.drain(..copied);
            state.unreported_window = state.unreported_window.saturating_add(copied as u32);
            // Announcing every byte would double the frame count for no gain, so credit is
            // returned in halves of the window, which keeps a full window in flight.
            let consumed_total = if state.unreported_window >= WINDOW_UPDATE_THRESHOLD_BYTES
                || (state.inbound.is_empty() && state.unreported_window > 0)
            {
                std::mem::take(&mut state.unreported_window)
            } else {
                0
            };
            (copied, consumed_total)
        };
        if consumed_total > 0 {
            let _ = self
                .mux
                .write_frame(FRAME_WINDOW, self.id, &consumed_total.to_be_bytes());
        }
        Ok(copied)
    }

    /// Signals that the workload sent everything it is going to send.
    pub(crate) fn end_send(&self) {
        let already_ended = {
            let mut state = guard(&self.shared.state);
            let already_ended = state.send_ended;
            state.send_ended = true;
            already_ended
        };
        if !already_ended {
            let _ = self.mux.write_frame(FRAME_END, self.id, &[]);
        }
    }

    fn abort(&self) {
        let mut state = guard(&self.shared.state);
        state.aborted = true;
        self.shared.signal.notify_all();
    }
}

impl Drop for MuxStream {
    fn drop(&mut self) {
        let needs_reset = {
            let state = guard(&self.shared.state);
            !(state.send_ended && state.inbound_ended)
        };
        if needs_reset {
            let _ = self.mux.write_frame(FRAME_RESET, self.id, &[]);
        }
        self.abort();
        self.mux.forget(self.id);
    }
}

fn link_closed() -> OpenFailure {
    OpenFailure::new(
        RefusalReason::Unreachable,
        "the sandbox proxy link is not available",
    )
}

/// Poisoning cannot occur in a release build, which aborts on panic, and a poisoned lock in a debug
/// build still describes the state accurately enough to keep failing closed.
fn guard<T>(lock: &Mutex<T>) -> MutexGuard<'_, T> {
    match lock.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn wait<'a, T>(signal: &Condvar, state: MutexGuard<'a, T>) -> MutexGuard<'a, T> {
    match signal.wait(state) {
        Ok(state) => state,
        Err(poisoned) => poisoned.into_inner(),
    }
}
