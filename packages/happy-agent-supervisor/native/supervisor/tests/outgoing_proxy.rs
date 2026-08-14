//! End-to-end behaviour of the outgoing proxy, with a real host on the other end of a real
//! descriptor. The test process plays Rig: it connects the link before the supervisor starts,
//! authenticates the command's token, and applies that command's policy per connection.

use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::os::fd::{IntoRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tempfile::TempDir;

const SUPERVISOR: &str = env!("CARGO_BIN_EXE_happy-agent-supervisor");
const TOKEN: &str = "command-scoped-token-0123456789";
const ALLOWED_HOST: &str = "allowed.invalid";
const DENIED_HOST: &str = "denied.invalid";

const MAGIC: [u8; 4] = *b"HPX1";
const FRAME_OPEN: u8 = 1;
const FRAME_OPENED: u8 = 2;
const FRAME_REFUSED: u8 = 3;
const FRAME_DATA: u8 = 4;
const FRAME_END: u8 = 5;
const FRAME_RESET: u8 = 6;
const FRAME_WINDOW: u8 = 7;
const REFUSED_BLOCKED: u8 = 1;
const INITIAL_WINDOW_BYTES: u32 = 256 * 1024;
const RUN_TIMEOUT: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------------------------
// The host proxy. One long-lived server would resolve a token to one command's policy; this test
// is one command, so the policy is fixed and the token check is the same fail-closed check.
// ---------------------------------------------------------------------------------------------

#[derive(Clone)]
struct HostPolicy {
    token: String,
    allowed_host: String,
    origin: SocketAddr,
}

struct Link {
    reader: UnixStream,
    writer: Mutex<UnixStream>,
}

struct HostStream {
    socket: TcpStream,
    credit: Arc<(Mutex<u32>, Condvar)>,
}

/// Authenticates the token and then serves streams under `policy`.
///
/// A token that does not authenticate gets a refusal and the link is dropped, which is the only
/// answer the supervisor turns into "no network at all".
fn serve_host(link: UnixStream, policy: HostPolicy, opened: Arc<AtomicU64>) {
    let mut reader = match link.try_clone() {
        Ok(reader) => reader,
        Err(_) => return,
    };
    let mut hello = [0_u8; 6];
    if reader.read_exact(&mut hello).is_err() || hello[..4] != MAGIC {
        return;
    }
    let length = u16::from_be_bytes([hello[4], hello[5]]) as usize;
    let mut token = vec![0_u8; length];
    if reader.read_exact(&mut token).is_err() {
        return;
    }
    let mut writer = match link.try_clone() {
        Ok(writer) => writer,
        Err(_) => return,
    };
    if token != policy.token.as_bytes() {
        let mut refusal = MAGIC.to_vec();
        refusal.push(1);
        let _ = writer.write_all(&refusal);
        let _ = writer.flush();
        let _ = link.shutdown(Shutdown::Both);
        return;
    }
    let mut acceptance = MAGIC.to_vec();
    acceptance.push(0);
    if writer.write_all(&acceptance).is_err() {
        return;
    }

    let link = Arc::new(Link {
        reader: match link.try_clone() {
            Ok(reader) => reader,
            Err(_) => return,
        },
        writer: Mutex::new(writer),
    });
    let mut streams: HashMap<u32, HostStream> = HashMap::new();
    let mut header = [0_u8; 9];
    loop {
        if (&link.reader).read_exact(&mut header).is_err() {
            break;
        }
        let kind = header[0];
        let id = u32::from_be_bytes([header[1], header[2], header[3], header[4]]);
        let length = u32::from_be_bytes([header[5], header[6], header[7], header[8]]) as usize;
        let mut payload = vec![0_u8; length];
        if (&link.reader).read_exact(&mut payload).is_err() {
            break;
        }
        match kind {
            FRAME_OPEN => {
                let port = u16::from_be_bytes([payload[0], payload[1]]);
                let host_length = u16::from_be_bytes([payload[2], payload[3]]) as usize;
                let host = String::from_utf8_lossy(&payload[4..4 + host_length]).into_owned();
                if host != policy.allowed_host {
                    let mut refusal = vec![REFUSED_BLOCKED];
                    refusal.extend_from_slice(
                        format!("{host}:{port} is not in this command's allow list").as_bytes(),
                    );
                    write_frame(&link, FRAME_REFUSED, id, &refusal);
                    continue;
                }
                let Ok(socket) = TcpStream::connect(policy.origin) else {
                    write_frame(&link, FRAME_REFUSED, id, &[3]);
                    continue;
                };
                opened.fetch_add(1, Ordering::SeqCst);
                write_frame(&link, FRAME_OPENED, id, &[]);
                let credit = Arc::new((Mutex::new(INITIAL_WINDOW_BYTES), Condvar::new()));
                let Ok(download) = socket.try_clone() else {
                    break;
                };
                streams.insert(
                    id,
                    HostStream {
                        socket: match socket.try_clone() {
                            Ok(socket) => socket,
                            Err(_) => break,
                        },
                        credit: Arc::clone(&credit),
                    },
                );
                let link = Arc::clone(&link);
                std::thread::spawn(move || forward_destination(download, link, id, credit));
            }
            FRAME_DATA => {
                if let Some(stream) = streams.get_mut(&id) {
                    if (&stream.socket).write_all(&payload).is_err() {
                        streams.remove(&id);
                        continue;
                    }
                    write_frame(&link, FRAME_WINDOW, id, &(payload.len() as u32).to_be_bytes());
                }
            }
            FRAME_END => {
                if let Some(stream) = streams.get(&id) {
                    let _ = stream.socket.shutdown(Shutdown::Write);
                }
            }
            FRAME_RESET => {
                if let Some(stream) = streams.remove(&id) {
                    let _ = stream.socket.shutdown(Shutdown::Both);
                }
            }
            FRAME_WINDOW => {
                if let Some(stream) = streams.get(&id) {
                    let granted =
                        u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]);
                    let (credit, signal) = &*stream.credit;
                    let mut available = credit.lock().unwrap_or_else(|error| error.into_inner());
                    *available = available.saturating_add(granted);
                    signal.notify_all();
                }
            }
            _ => break,
        }
    }
    for stream in streams.values() {
        let _ = stream.socket.shutdown(Shutdown::Both);
    }
}

/// Sends destination bytes back, never exceeding the credit the supervisor granted.
fn forward_destination(
    mut socket: TcpStream,
    link: Arc<Link>,
    id: u32,
    credit: Arc<(Mutex<u32>, Condvar)>,
) {
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = match socket.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        let mut sent = 0;
        while sent < read {
            let allowed = {
                let (available, signal) = &*credit;
                let mut available =
                    available.lock().unwrap_or_else(|error| error.into_inner());
                while *available == 0 {
                    available = signal
                        .wait(available)
                        .unwrap_or_else(|error| error.into_inner());
                }
                let allowed = (read - sent).min(*available as usize);
                *available -= allowed as u32;
                allowed
            };
            write_frame(&link, FRAME_DATA, id, &buffer[sent..sent + allowed]);
            sent += allowed;
        }
    }
    write_frame(&link, FRAME_END, id, &[]);
}

fn write_frame(link: &Link, kind: u8, id: u32, payload: &[u8]) {
    let mut frame = Vec::with_capacity(9 + payload.len());
    frame.push(kind);
    frame.extend_from_slice(&id.to_be_bytes());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    let mut writer = link.writer.lock().unwrap_or_else(|error| error.into_inner());
    let _ = writer.write_all(&frame);
    let _ = writer.flush();
}

// ---------------------------------------------------------------------------------------------
// The origin the host proxy connects to on the command's behalf.
// ---------------------------------------------------------------------------------------------

fn start_origin() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0")
        .unwrap_or_else(|error| panic!("bind origin listener: {error}"));
    let address = listener
        .local_addr()
        .unwrap_or_else(|error| panic!("origin address: {error}"));
    std::thread::spawn(move || {
        for connection in listener.incoming() {
            let Ok(mut connection) = connection else {
                return;
            };
            std::thread::spawn(move || {
                // The origin answers one request and echoes anything else, which covers both the
                // forwarded plaintext path and the opaque tunnel paths.
                let mut first = [0_u8; 4];
                if connection.read_exact(&mut first).is_err() {
                    return;
                }
                if &first == b"GET " {
                    let mut discard = [0_u8; 4096];
                    let _ = connection.read(&mut discard);
                    let _ = connection.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\norigin-ok",
                    );
                    let _ = connection.shutdown(Shutdown::Write);
                    return;
                }
                let _ = connection.write_all(&first);
                let mut buffer = [0_u8; 32 * 1024];
                loop {
                    match connection.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => {
                            if connection.write_all(&buffer[..read]).is_err() {
                                break;
                            }
                        }
                    }
                }
                let _ = connection.shutdown(Shutdown::Write);
            });
        }
    });
    address
}

// ---------------------------------------------------------------------------------------------
// Running the supervisor with the link already connected.
// ---------------------------------------------------------------------------------------------

struct ProxiedRun {
    output: Output,
    opened_streams: u64,
}

fn run_workload(operation: &str, token_the_host_expects: &str, front_ends: &[&str]) -> ProxiedRun {
    let workspace =
        tempfile::tempdir().unwrap_or_else(|error| panic!("temporary workspace: {error}"));
    let origin = start_origin();
    let (host_end, supervisor_end) =
        UnixStream::pair().unwrap_or_else(|error| panic!("create the proxy link: {error}"));
    let opened = Arc::new(AtomicU64::new(0));
    let host_opened = Arc::clone(&opened);
    let policy = HostPolicy {
        token: token_the_host_expects.to_string(),
        allowed_host: ALLOWED_HOST.to_string(),
        origin,
    };
    let host = std::thread::spawn(move || serve_host(host_end, policy, host_opened));

    let output = supervise(
        &workspace,
        supervisor_end,
        front_ends,
        operation,
        &[("SUPERVISOR_TEST_ORIGIN", origin.to_string())],
    );
    let _ = host.join();
    ProxiedRun {
        output,
        opened_streams: opened.load(Ordering::SeqCst),
    }
}

fn supervise(
    workspace: &TempDir,
    supervisor_end: UnixStream,
    front_ends: &[&str],
    operation: &str,
    environment: &[(&str, String)],
) -> Output {
    let policy_path = workspace.path().join("policy.json");
    std::fs::write(
        &policy_path,
        serde_json::to_vec(&json!({
            "mode": "workspace_write",
            "network": {
                "egress": true,
                "allowedHosts": [ALLOWED_HOST],
                "localBinding": false,
                "outgoingProxy": {
                    "upstreamFd": 3,
                    "token": TOKEN,
                    "frontEnds": front_ends
                }
            }
        }))
        .unwrap_or_else(|error| panic!("serialize policy: {error}")),
    )
    .unwrap_or_else(|error| panic!("write policy: {error}"));

    let mut command = Command::new(SUPERVISOR);
    command
        .current_dir(workspace.path())
        .arg("--policy-file")
        .arg(&policy_path)
        .arg("--")
        .arg(std::env::current_exe().unwrap_or_else(|error| panic!("current test binary: {error}")))
        .args(["--exact", "proxy_workload_process", "--nocapture"])
        .env("SUPERVISOR_TEST_PROXY_WORKLOAD", operation)
        .stdin(Stdio::null());
    for (key, value) in environment {
        command.env(key, value);
    }
    let link = supervisor_end.into_raw_fd();
    unsafe {
        command.pre_exec(move || {
            // Rig hands over the descriptor it already connected. Nothing inside the sandbox ever
            // has to find the proxy by address.
            if libc::dup2(link, 3) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let output = run_bounded(command);
    close_fd(link);
    output
}

/// Runs the supervisor with a deadline.
///
/// A workload can fail to start at all — a refused nested sandbox, a rejected policy, a front-end
/// that never answers — and an unbounded wait would turn that into a hang instead of a failure.
fn run_bounded(mut command: Command) -> Output {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|error| panic!("run supervisor: {error}"));
    let stdout = child
        .stdout
        .take()
        .unwrap_or_else(|| panic!("supervisor stdout is missing"));
    let stderr = child
        .stderr
        .take()
        .unwrap_or_else(|| panic!("supervisor stderr is missing"));
    let stdout = std::thread::spawn(move || read_to_end(stdout));
    let stderr = std::thread::spawn(move || read_to_end(stderr));

    let deadline = Instant::now() + RUN_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => panic!("wait for supervisor: {error}"),
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the supervised command did not finish within {RUN_TIMEOUT:?}");
        }
        std::thread::sleep(Duration::from_millis(10));
    };

    Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    }
}

fn read_to_end(mut source: impl Read) -> Vec<u8> {
    let mut buffer = Vec::new();
    let _ = source.read_to_end(&mut buffer);
    buffer
}

fn close_fd(descriptor: RawFd) {
    unsafe {
        libc::close(descriptor);
    }
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[test]
fn an_allowed_host_is_reachable_through_the_http_front_end() {
    let run = run_workload("http_forward", TOKEN, &["http", "socks5"]);
    let stdout = String::from_utf8_lossy(&run.output.stdout);

    assert!(
        run.output.status.success(),
        "stdout:\n{stdout}\nstderr:\n{}",
        String::from_utf8_lossy(&run.output.stderr)
    );
    assert!(stdout.contains("http-forward=origin-ok"), "stdout:\n{stdout}");
    assert_eq!(run.opened_streams, 1);
}

#[test]
fn an_allowed_host_is_reachable_through_connect_and_socks() {
    let run = run_workload("tunnels", TOKEN, &["http", "socks5"]);
    let stdout = String::from_utf8_lossy(&run.output.stdout);

    assert!(
        run.output.status.success(),
        "stdout:\n{stdout}\nstderr:\n{}",
        String::from_utf8_lossy(&run.output.stderr)
    );
    assert!(stdout.contains("connect-tunnel=tunnelled"), "stdout:\n{stdout}");
    assert!(stdout.contains("socks-tunnel=tunnelled"), "stdout:\n{stdout}");
    assert_eq!(run.opened_streams, 2);
}

#[test]
fn a_denied_host_is_refused_in_each_front_end_vocabulary() {
    let run = run_workload("denied", TOKEN, &["http", "socks5"]);
    let stdout = String::from_utf8_lossy(&run.output.stdout);

    assert!(
        run.output.status.success(),
        "stdout:\n{stdout}\nstderr:\n{}",
        String::from_utf8_lossy(&run.output.stderr)
    );
    assert!(stdout.contains("connect-denied=403"), "stdout:\n{stdout}");
    assert!(stdout.contains("forward-denied=403"), "stdout:\n{stdout}");
    assert!(stdout.contains("socks-denied=2"), "stdout:\n{stdout}");
    assert_eq!(run.opened_streams, 0);
}

#[test]
fn the_workload_cannot_reach_the_destination_without_the_proxy() {
    let run = run_workload("direct", TOKEN, &["http", "socks5"]);
    let stdout = String::from_utf8_lossy(&run.output.stdout);

    assert!(
        run.output.status.success(),
        "stdout:\n{stdout}\nstderr:\n{}",
        String::from_utf8_lossy(&run.output.stderr)
    );
    assert!(stdout.contains("direct-connect=refused"), "stdout:\n{stdout}");
    assert!(stdout.contains("upstream-descriptor=closed"), "stdout:\n{stdout}");
    assert_eq!(run.opened_streams, 0);
}

#[test]
fn a_token_the_host_does_not_recognise_stops_the_command() {
    let run = run_workload("http_forward", "a-different-command's-token", &["http"]);
    let stderr = String::from_utf8_lossy(&run.output.stderr);

    assert_eq!(run.output.status.code(), Some(125));
    assert!(
        String::from_utf8_lossy(&run.output.stdout).is_empty(),
        "the workload must not run at all"
    );
    assert!(stderr.contains("refused the command authentication token"), "stderr:\n{stderr}");
}

#[test]
fn a_transfer_larger_than_one_window_completes_in_both_directions() {
    let run = run_workload("large_transfer", TOKEN, &["socks5"]);
    let stdout = String::from_utf8_lossy(&run.output.stdout);

    assert!(
        run.output.status.success(),
        "stdout:\n{stdout}\nstderr:\n{}",
        String::from_utf8_lossy(&run.output.stderr)
    );
    assert!(stdout.contains("large-transfer=1048576"), "stdout:\n{stdout}");
}

#[test]
fn only_the_requested_front_ends_are_offered() {
    let run = run_workload("front_ends", TOKEN, &["socks5"]);
    let stdout = String::from_utf8_lossy(&run.output.stdout);

    assert!(
        run.output.status.success(),
        "stdout:\n{stdout}\nstderr:\n{}",
        String::from_utf8_lossy(&run.output.stderr)
    );
    assert!(stdout.contains("http-proxy=unset"), "stdout:\n{stdout}");
    assert!(stdout.contains("all-proxy=socks5h"), "stdout:\n{stdout}");
    assert!(stdout.contains("no-proxy=empty"), "stdout:\n{stdout}");
}

// ---------------------------------------------------------------------------------------------
// The workload, which only ever sees loopback proxy endpoints in its environment.
// ---------------------------------------------------------------------------------------------

#[test]
fn proxy_workload_process() {
    let Ok(operation) = std::env::var("SUPERVISOR_TEST_PROXY_WORKLOAD") else {
        return;
    };
    match operation.as_str() {
        "http_forward" => {
            let response = http_proxy_request(&format!("http://{ALLOWED_HOST}/probe"));
            println!(
                "http-forward={}",
                response.rsplit("\r\n\r\n").next().unwrap_or_default()
            );
        }
        "tunnels" => {
            let mut connect = connect_to(http_proxy_endpoint());
            write_all(
                &mut connect,
                format!("CONNECT {ALLOWED_HOST}:443 HTTP/1.1\r\nHost: {ALLOWED_HOST}:443\r\n\r\n")
                    .as_bytes(),
            );
            let status = read_head_line(&mut connect);
            assert!(status.starts_with("HTTP/1.1 200"), "CONNECT said: {status}");
            // The blank line ending the response head belongs to the proxy exchange, not to the
            // tunnel, so it is consumed before the tunnel carries anything.
            while !read_head_line(&mut connect).is_empty() {}
            println!("connect-tunnel={}", echo_through(&mut connect));

            let mut socks = socks_connect(ALLOWED_HOST, 443);
            println!("socks-tunnel={}", echo_through(&mut socks));
        }
        "denied" => {
            let mut connect = connect_to(http_proxy_endpoint());
            write_all(
                &mut connect,
                format!("CONNECT {DENIED_HOST}:443 HTTP/1.1\r\n\r\n").as_bytes(),
            );
            println!("connect-denied={}", status_code(&read_head_line(&mut connect)));

            let forwarded = http_proxy_request(&format!("http://{DENIED_HOST}/probe"));
            println!(
                "forward-denied={}",
                status_code(forwarded.lines().next().unwrap_or_default())
            );

            let mut socks = connect_to(socks_proxy_endpoint());
            write_all(&mut socks, &[5, 1, 0]);
            let mut greeting = [0_u8; 2];
            read_exact(&mut socks, &mut greeting);
            let mut request = vec![5, 1, 0, 3, DENIED_HOST.len() as u8];
            request.extend_from_slice(DENIED_HOST.as_bytes());
            request.extend_from_slice(&443_u16.to_be_bytes());
            write_all(&mut socks, &request);
            let mut reply = [0_u8; 10];
            read_exact(&mut socks, &mut reply);
            println!("socks-denied={}", reply[1]);
        }
        "direct" => {
            let origin = std::env::var("SUPERVISOR_TEST_ORIGIN")
                .unwrap_or_else(|error| panic!("origin address: {error}"));
            let direct = TcpStream::connect(&origin);
            println!(
                "direct-connect={}",
                match direct {
                    Ok(_) => "reached".to_string(),
                    Err(_) => "refused".to_string(),
                }
            );
            let descriptor = unsafe { libc::fcntl(3, libc::F_GETFD) };
            println!(
                "upstream-descriptor={}",
                if descriptor < 0 { "closed" } else { "inherited" }
            );
        }
        "large_transfer" => {
            let mut socks = socks_connect(ALLOWED_HOST, 443);
            let payload = vec![b'x'; 1024 * 1024];
            let mut sender = socks
                .try_clone()
                .unwrap_or_else(|error| panic!("clone tunnel: {error}"));
            std::thread::spawn(move || {
                let _ = sender.write_all(&payload);
                let _ = sender.shutdown(Shutdown::Write);
            });
            let mut echoed = Vec::new();
            let mut buffer = [0_u8; 32 * 1024];
            while echoed.len() < 1024 * 1024 {
                match socks.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => echoed.extend_from_slice(&buffer[..read]),
                }
            }
            println!("large-transfer={}", echoed.len());
        }
        "front_ends" => {
            println!(
                "http-proxy={}",
                match std::env::var("HTTP_PROXY") {
                    Ok(value) => value,
                    Err(_) => "unset".to_string(),
                }
            );
            println!(
                "all-proxy={}",
                std::env::var("ALL_PROXY")
                    .unwrap_or_default()
                    .split("://")
                    .next()
                    .unwrap_or_default()
            );
            println!(
                "no-proxy={}",
                if std::env::var("NO_PROXY").unwrap_or_default().is_empty() {
                    "empty"
                } else {
                    "set"
                }
            );
        }
        other => panic!("unknown proxy workload operation: {other}"),
    }
}

fn http_proxy_endpoint() -> String {
    endpoint(&std::env::var("HTTP_PROXY").unwrap_or_else(|error| panic!("HTTP_PROXY: {error}")))
}

fn socks_proxy_endpoint() -> String {
    endpoint(&std::env::var("ALL_PROXY").unwrap_or_else(|error| panic!("ALL_PROXY: {error}")))
}

fn endpoint(url: &str) -> String {
    url.split("://")
        .nth(1)
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string()
}

fn connect_to(endpoint: String) -> TcpStream {
    TcpStream::connect(&endpoint)
        .unwrap_or_else(|error| panic!("connect to the front-end {endpoint}: {error}"))
}

fn http_proxy_request(url: &str) -> String {
    let mut client = connect_to(http_proxy_endpoint());
    write_all(
        &mut client,
        format!("GET {url} HTTP/1.1\r\nHost: {ALLOWED_HOST}\r\nProxy-Connection: keep-alive\r\n\r\n")
            .as_bytes(),
    );
    let mut response = String::new();
    let _ = client.read_to_string(&mut response);
    response
}

fn socks_connect(host: &str, port: u16) -> TcpStream {
    let mut socks = connect_to(socks_proxy_endpoint());
    write_all(&mut socks, &[5, 1, 0]);
    let mut greeting = [0_u8; 2];
    read_exact(&mut socks, &mut greeting);
    assert_eq!(greeting, [5, 0]);
    let mut request = vec![5, 1, 0, 3, host.len() as u8];
    request.extend_from_slice(host.as_bytes());
    request.extend_from_slice(&port.to_be_bytes());
    write_all(&mut socks, &request);
    let mut reply = [0_u8; 10];
    read_exact(&mut socks, &mut reply);
    assert_eq!(reply[1], 0, "SOCKS refused an allowed host: {}", reply[1]);
    socks
}

fn echo_through(stream: &mut TcpStream) -> String {
    write_all(stream, b"tunnelled");
    let mut echoed = [0_u8; 9];
    read_exact(stream, &mut echoed);
    String::from_utf8_lossy(&echoed).into_owned()
}

fn read_head_line(stream: &mut TcpStream) -> String {
    let mut line = Vec::new();
    let mut byte = [0_u8; 1];
    while line.len() < 128 {
        match stream.read(&mut byte) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if byte[0] == b'\r' {
                    continue;
                }
                if byte[0] == b'\n' {
                    break;
                }
                line.push(byte[0]);
            }
        }
    }
    String::from_utf8_lossy(&line).into_owned()
}

fn status_code(status_line: &str) -> String {
    status_line.split(' ').nth(1).unwrap_or_default().to_string()
}

fn write_all(stream: &mut TcpStream, bytes: &[u8]) {
    stream
        .write_all(bytes)
        .unwrap_or_else(|error| panic!("write to the front-end: {error}"));
}

fn read_exact(stream: &mut TcpStream, buffer: &mut [u8]) {
    stream
        .read_exact(buffer)
        .unwrap_or_else(|error| panic!("read from the front-end: {error}"));
}
