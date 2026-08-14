use serde_json::json;
use std::fs;
use std::io::Write;
use std::os::fd::{AsRawFd, FromRawFd};
use std::process::{Command, Output};
use tempfile::TempDir;

const SUPERVISOR: &str = env!("CARGO_BIN_EXE_happy-agent-supervisor");

struct TestBoundary {
    _root: TempDir,
    workspace: std::path::PathBuf,
    outside: std::path::PathBuf,
    policy: std::path::PathBuf,
}

impl TestBoundary {
    fn new(egress: bool, local_binding: bool) -> Self {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("temporary root: {error}"));
        let workspace = root.path().join("workspace");
        let outside = root.path().join("outside");
        fs::create_dir(&workspace).unwrap_or_else(|error| panic!("workspace: {error}"));
        fs::create_dir(&outside).unwrap_or_else(|error| panic!("outside: {error}"));
        let policy = root.path().join("policy.json");
        fs::write(
            &policy,
            serde_json::to_vec(&json!({
                "mode": "workspace_write",
                "network": {
                    "egress": egress,
                    "localBinding": local_binding
                }
            }))
            .unwrap_or_else(|error| panic!("serialize policy: {error}")),
        )
        .unwrap_or_else(|error| panic!("write policy: {error}"));
        Self {
            _root: root,
            workspace,
            outside,
            policy,
        }
    }

    fn run(&self, command: &[&str]) -> Output {
        self.run_with_env(command, &[])
    }

    fn run_with_env(&self, command: &[&str], environment: &[(&str, &str)]) -> Output {
        let mut supervisor = Command::new(SUPERVISOR);
        supervisor
            .current_dir(&self.workspace)
            .args(["--policy-file"])
            .arg(&self.policy)
            .arg("--")
            .args(command);
        for (name, value) in environment {
            supervisor.env(name, value);
        }
        supervisor
            .output()
            .unwrap_or_else(|error| panic!("run supervisor: {error}"))
    }
}

#[test]
fn command_output_and_exit_status_pass_through() {
    let boundary = TestBoundary::new(false, false);
    let output = boundary.run(&["/bin/sh", "-c", "printf 'supervised-output'; exit 37"]);

    assert_eq!(String::from_utf8_lossy(&output.stdout), "supervised-output");
    assert_eq!(output.status.code(), Some(37));
    println!("stdout=supervised-output exit=37");
}

#[test]
fn policy_can_be_consumed_from_an_inherited_descriptor() {
    let boundary = TestBoundary::new(false, false);
    let mut descriptors = [-1, -1];
    assert_eq!(unsafe { libc::pipe(descriptors.as_mut_ptr()) }, 0);
    let policy_read = unsafe { fs::File::from_raw_fd(descriptors[0]) };
    let mut policy_write = unsafe { fs::File::from_raw_fd(descriptors[1]) };
    policy_write
        .write_all(
            &fs::read(&boundary.policy)
                .unwrap_or_else(|error| panic!("read descriptor policy: {error}")),
        )
        .unwrap_or_else(|error| panic!("write descriptor policy: {error}"));
    drop(policy_write);

    let output = Command::new(SUPERVISOR)
        .current_dir(&boundary.workspace)
        .arg("--policy-fd")
        .arg(policy_read.as_raw_fd().to_string())
        .args(["--", "/bin/sh", "-c", "printf fd-policy"])
        .output()
        .unwrap_or_else(|error| panic!("run descriptor policy test: {error}"));

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout), "fd-policy");
    println!("policy-fd=consumed stdout=fd-policy");
}

#[test]
fn writes_are_limited_to_the_workspace() {
    let boundary = TestBoundary::new(false, false);
    let inside = boundary.workspace.join("inside.txt");
    let outside = boundary.outside.join("outside.txt");
    let output = Command::new(SUPERVISOR)
        .current_dir(&boundary.workspace)
        .args(["--policy-file"])
        .arg(&boundary.policy)
        .args(["--", "/bin/sh", "-c"])
        // The inside write is deliberately relative. Binding a mount over the working directory
        // leaves an already-standing process pointing at the shadowed directory underneath, so an
        // absolute path can succeed while `./file` is refused, and relative is how commands write.
        .arg("printf inside > inside.txt; if printf outside > \"$OUTSIDE\"; then exit 91; fi")
        .env("OUTSIDE", &outside)
        .output()
        .unwrap_or_else(|error| panic!("run filesystem test: {error}"));

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read_to_string(inside).unwrap_or_else(|error| panic!("read inside: {error}")),
        "inside"
    );
    assert!(!outside.exists());
    println!("inside-write=inside outside-write=refused");
}

#[test]
fn local_binding_is_denied_while_egress_remains_available() {
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0")
        .unwrap_or_else(|error| panic!("bind host listener: {error}"));
    let endpoint = listener
        .local_addr()
        .unwrap_or_else(|error| panic!("listener address: {error}"));
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener
            .accept()
            .unwrap_or_else(|error| panic!("accept egress probe: {error}"));
        stream
            .write_all(b"egress-ok")
            .unwrap_or_else(|error| panic!("write egress probe: {error}"));
    });
    let boundary = TestBoundary::new(true, false);
    let output = workload(
        &boundary,
        "network",
        &[("SUPERVISOR_TEST_ENDPOINT", endpoint.to_string())],
    );
    server
        .join()
        .unwrap_or_else(|_| panic!("egress probe server panicked"));

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("bind=EPERM egress=egress-ok"));
    println!("bind=EPERM egress=egress-ok");
}

#[cfg(target_os = "linux")]
#[test]
fn proc_ps_and_zero_capabilities_are_visible_to_the_workload() {
    let boundary = TestBoundary::new(false, false);
    let output = workload(&boundary, "proc", &[]);
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(stdout.contains("proc=present"));
    assert!(stdout.contains("CapEff:\t0000000000000000"));
    assert!(stdout.contains("CapPrm:\t0000000000000000"));
    assert!(stdout.contains("CapBnd:\t0000000000000000"));
    assert!(stdout.contains("NoNewPrivs:\t1"));
    assert!(stdout.contains("proc-fd=working"));
    assert!(stdout.contains("workload-pid=2"));
    assert!(stdout.contains("ps=working"));
    println!("{stdout}");
}

#[cfg(target_os = "linux")]
#[test]
fn target_signals_pass_through_as_signals() {
    use std::os::unix::process::ExitStatusExt;

    let boundary = TestBoundary::new(false, false);
    let output = workload(&boundary, "signal", &[]);

    assert_eq!(output.status.signal(), Some(libc::SIGTERM));
    println!("signal=SIGTERM");
}

fn workload(boundary: &TestBoundary, operation: &str, environment: &[(&str, String)]) -> Output {
    let mut command = Command::new(SUPERVISOR);
    command
        .current_dir(&boundary.workspace)
        .args(["--policy-file"])
        .arg(&boundary.policy)
        .arg("--")
        .arg(std::env::current_exe().unwrap_or_else(|error| panic!("current test binary: {error}")))
        .args(["--exact", "workload_process", "--nocapture"])
        .env("SUPERVISOR_TEST_WORKLOAD", operation);
    for (key, value) in environment {
        command.env(key, value);
    }
    command
        .output()
        .unwrap_or_else(|error| panic!("run workload helper: {error}"))
}

#[test]
fn workload_process() {
    use std::io::Read;
    use std::net::{TcpListener, TcpStream};

    let Ok(operation) = std::env::var("SUPERVISOR_TEST_WORKLOAD") else {
        return;
    };
    match operation.as_str() {
        "network" => {
            let bind_error = TcpListener::bind("127.0.0.1:0")
                .err()
                .unwrap_or_else(|| panic!("local binding unexpectedly succeeded"));
            assert_eq!(bind_error.raw_os_error(), Some(libc::EPERM));
            let endpoint = std::env::var("SUPERVISOR_TEST_ENDPOINT")
                .unwrap_or_else(|error| panic!("egress endpoint: {error}"));
            let mut stream = TcpStream::connect(endpoint)
                .unwrap_or_else(|error| panic!("egress connect failed: {error}"));
            let mut response = String::new();
            stream
                .read_to_string(&mut response)
                .unwrap_or_else(|error| panic!("read egress response: {error}"));
            println!("bind=EPERM egress={response}");
        }
        #[cfg(target_os = "linux")]
        "proc" => {
            let status = fs::read_to_string("/proc/self/status")
                .unwrap_or_else(|error| panic!("read /proc/self/status: {error}"));
            let security_status = status
                .lines()
                .filter(|line| {
                    line.starts_with("CapEff:")
                        || line.starts_with("CapPrm:")
                        || line.starts_with("CapBnd:")
                        || line.starts_with("NoNewPrivs:")
                })
                .collect::<Vec<_>>();
            assert_eq!(
                security_status,
                [
                    "CapPrm:\t0000000000000000",
                    "CapEff:\t0000000000000000",
                    "CapBnd:\t0000000000000000",
                    "NoNewPrivs:\t1",
                ]
            );
            fs::read_dir("/proc/self/fd")
                .unwrap_or_else(|error| panic!("read /proc/self/fd: {error}"));
            assert_eq!(std::process::id(), 2);
            let ps = Command::new("ps")
                .args(["-o", "pid,comm"])
                .output()
                .unwrap_or_else(|error| panic!("run ps: {error}"));
            assert!(
                ps.status.success(),
                "ps stderr: {}",
                String::from_utf8_lossy(&ps.stderr)
            );
            println!(
                "proc=present\n{}\nproc-fd=working\nworkload-pid=2\nps=working",
                security_status.join("\n")
            );
        }
        #[cfg(target_os = "linux")]
        "signal" => unsafe {
            libc::raise(libc::SIGTERM);
        },
        other => panic!("unknown workload operation: {other}"),
    }
}

/// The pre-5.12 remount fallback would otherwise never execute on any kernel this is tested on, so
/// it is forced here and held to exactly the boundary the modern path enforces.
#[cfg(target_os = "linux")]
#[test]
fn the_legacy_remount_fallback_enforces_the_same_boundary() {
    let boundary = TestBoundary::new(false, false);
    let outside = boundary.outside.join("outside.txt");
    let output = boundary.run_with_env(
        &[
            "/bin/sh",
            "-c",
            "printf inside > inside.txt || exit 91; if printf outside > \"$OUTSIDE\"; then exit 92; fi",
        ],
        &[
            ("HAPPY_AGENT_SUPERVISOR_FORCE_LEGACY_REMOUNT", "1"),
            (
                "OUTSIDE",
                outside
                    .to_str()
                    .unwrap_or_else(|| panic!("outside path is not UTF-8")),
            ),
        ],
    );

    assert!(
        output.status.success(),
        "the forced fallback did not enforce the boundary (exit {:?})\nstdout:\n{}\nstderr:\n{}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read_to_string(boundary.workspace.join("inside.txt"))
            .unwrap_or_else(|error| panic!("read fallback workspace output: {error}")),
        "inside"
    );
    assert!(
        !outside.exists(),
        "the fallback permitted a write outside the workspace"
    );
}
