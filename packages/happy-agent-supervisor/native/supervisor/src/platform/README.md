# Platform boundaries

Linux establishes namespaces, mounts, seccomp, capability removal, and a
private procfs. macOS builds and installs one Seatbelt profile in-process.
`child.rs` holds the fork, wait, and status reproduction both platforms need
once something has to outlive the workload's `execve`.

Both platforms fork the egress process before their boundary exists: on Linux
before `unshare(CLONE_NEWNET)`, on macOS before `sandbox_init`. Ending it differs
for the same reason. The Linux supervisor stays outside the namespace it created
and kills and reaps the process directly; the macOS front-end process is itself
inside the profile, which forbids signalling a process outside its sandbox, so it
closes the link instead — which is what ends the egress loop and, more to the
point, what removes the route out of the jail.
