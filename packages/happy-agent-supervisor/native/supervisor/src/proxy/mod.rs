//! The outgoing proxy the workload sees as ordinary loopback proxy endpoints.
//!
//! Everything here is plaintext protocol translation onto one pre-connected descriptor. The host
//! proxy on the other end owns the policy, the name resolution, the certificate authority, and any
//! TLS termination; the supervisor holds no key material and opens no socket to a destination.

mod bridge;
mod http;
mod mux;
mod socks;

pub(crate) use mux::MAX_TOKEN_BYTES;

use crate::exec::EnvironmentOverride;
use crate::policy::{OutgoingProxyPolicy, ProxyFrontEnd};
use crate::{SupervisorResult, invalid_input};
use mux::Mux;
use std::ffi::OsString;
use std::fs::File;
use std::net::TcpListener;
use std::os::fd::FromRawFd;
use std::sync::Arc;

/// Listeners bound and authenticated, but not yet serving.
///
/// Binding has to finish before the seccomp filter that denies `bind` and `listen` is installed,
/// and serving has to start after the workload is forked, so those two moments are separate.
pub(crate) struct OutgoingProxy {
    mux: Arc<Mux>,
    http: Option<TcpListener>,
    socks: Option<TcpListener>,
    environment: Vec<EnvironmentOverride>,
}

/// Binds the requested front-ends on loopback and authenticates the command's token.
///
/// A refused or unreachable host proxy is an error, which stops the whole invocation. The workload
/// never falls back to reaching the network directly.
pub(crate) fn prepare(policy: &OutgoingProxyPolicy) -> SupervisorResult<OutgoingProxy> {
    let http = bind_front_end(policy, ProxyFrontEnd::Http)?;
    let socks = bind_front_end(policy, ProxyFrontEnd::Socks5)?;
    let link = take_upstream_descriptor(policy.upstream_fd)?;
    let mux = Mux::connect(link, &policy.token)?;
    let environment = proxy_environment(policy, http.as_ref(), socks.as_ref())?;
    Ok(OutgoingProxy {
        mux,
        http,
        socks,
        environment,
    })
}

impl OutgoingProxy {
    /// The proxy variables the workload is executed with.
    pub(crate) fn environment(&self) -> &[EnvironmentOverride] {
        &self.environment
    }

    /// The loopback ports the workload is allowed to reach, for platforms whose policy is written
    /// in terms of addresses rather than namespaces.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(crate) fn front_end_ports(&self) -> SupervisorResult<Vec<u16>> {
        let mut ports = Vec::new();
        for listener in [self.http.as_ref(), self.socks.as_ref()].into_iter().flatten() {
            ports.push(listener.local_addr()?.port());
        }
        Ok(ports)
    }

    /// Starts one accept loop per bound front-end. Each loop owns its listener until the process
    /// ends with the workload.
    pub(crate) fn serve(self) -> SupervisorResult<()> {
        self.mux.start_reader()?;
        if let Some(listener) = self.http {
            let mux = Arc::clone(&self.mux);
            spawn_accept_loop("supervisor-proxy-http", listener, move |stream| {
                http::serve(&mux, stream);
            })?;
        }
        if let Some(listener) = self.socks {
            let mux = Arc::clone(&self.mux);
            spawn_accept_loop("supervisor-proxy-socks", listener, move |stream| {
                socks::serve(&mux, stream);
            })?;
        }
        Ok(())
    }
}

fn spawn_accept_loop(
    name: &str,
    listener: TcpListener,
    handle: impl Fn(std::net::TcpStream) + Send + Sync + 'static,
) -> SupervisorResult<()> {
    let handle = Arc::new(handle);
    let connection_name = format!("{name}-connection");
    std::thread::Builder::new()
        .name(name.to_string())
        .spawn(move || {
            loop {
                let Ok((stream, _)) = listener.accept() else {
                    // A listener that stops accepting cannot be repaired from inside the sandbox,
                    // and every front-end refusing is the safe end state.
                    return;
                };
                let handle = Arc::clone(&handle);
                let spawned = std::thread::Builder::new()
                    .name(connection_name.clone())
                    .spawn(move || handle(stream));
                if spawned.is_err() {
                    return;
                }
            }
        })?;
    Ok(())
}

fn bind_front_end(
    policy: &OutgoingProxyPolicy,
    front_end: ProxyFrontEnd,
) -> SupervisorResult<Option<TcpListener>> {
    if !policy.exposes(front_end) {
        return Ok(None);
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
        std::io::Error::other(format!("bind the sandbox proxy front-end: {error}"))
    })?;
    Ok(Some(listener))
}

/// Takes ownership of the descriptor Rig connected, and keeps it out of the workload's hands.
fn take_upstream_descriptor(descriptor: i32) -> SupervisorResult<File> {
    // The descriptor is inherited across `exec` unless this is set, and the workload must not be
    // able to speak the link protocol itself or desynchronise it.
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
    if flags < 0 {
        return Err(std::io::Error::other(format!(
            "the outgoing proxy descriptor {descriptor} is not open: {}",
            std::io::Error::last_os_error()
        ))
        .into());
    }
    if unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(std::io::Error::other(format!(
            "close the outgoing proxy descriptor on exec: {}",
            std::io::Error::last_os_error()
        ))
        .into());
    }
    // The invocation contract transfers ownership of the descriptor to the supervisor.
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

/// Every proxy variable the workload could act on, whether or not this policy offers a front-end
/// for it. A front-end that was not requested must arrive unset rather than inherited.
const HTTP_PROXY_VARIABLES: &[&str] = &["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"];
const SOCKS_PROXY_VARIABLES: &[&str] = &["ALL_PROXY", "all_proxy"];

fn proxy_environment(
    policy: &OutgoingProxyPolicy,
    http: Option<&TcpListener>,
    socks: Option<&TcpListener>,
) -> SupervisorResult<Vec<EnvironmentOverride>> {
    let mut environment = Vec::new();
    let http_url = match http {
        Some(listener) => Some(format!("http://127.0.0.1:{}", listener.local_addr()?.port())),
        None => None,
    };
    for name in HTTP_PROXY_VARIABLES {
        environment.push((
            OsString::from(name),
            http_url.as_ref().map(OsString::from),
        ));
    }
    environment.push((
        OsString::from("NODE_USE_ENV_PROXY"),
        http_url.as_ref().map(|_| OsString::from("1")),
    ));
    // `socks5h` keeps name resolution on the host side of the link.
    let socks_url = match socks {
        Some(listener) => Some(format!(
            "socks5h://127.0.0.1:{}",
            listener.local_addr()?.port()
        )),
        None => None,
    };
    for name in SOCKS_PROXY_VARIABLES {
        environment.push((
            OsString::from(name),
            socks_url.as_ref().map(OsString::from),
        ));
    }
    // An inherited exemption list would carve a hole straight through the policy, so it is always
    // replaced rather than left alone.
    for name in ["NO_PROXY", "no_proxy"] {
        environment.push((OsString::from(name), Some(OsString::new())));
    }
    if let Some(tls) = &policy.tls_termination {
        let path = tls.certificate_authority_file.as_os_str();
        if !tls.certificate_authority_file.exists() {
            return Err(invalid_input(format!(
                "the certificate authority for TLS termination does not exist: {}",
                tls.certificate_authority_file.display()
            ))
            .into());
        }
        for name in ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"] {
            environment.push((OsString::from(name), Some(path.to_os_string())));
        }
    }
    Ok(environment)
}
