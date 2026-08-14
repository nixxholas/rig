# Platform boundaries

Linux establishes namespaces, mounts, seccomp, capability removal, and a
private procfs. macOS builds and installs one Seatbelt profile in-process.
`child.rs` holds the fork, wait, and status reproduction both platforms need
once something has to outlive the workload's `execve`.
