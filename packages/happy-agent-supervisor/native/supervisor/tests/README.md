# Native behavior tests

`behavior.rs` invokes the real supervisor recursively and verifies output and
exit propagation, filesystem enforcement, seccomp with retained egress, private
procfs visibility, `ps`, zero effective capabilities, and signals.

Its filesystem cases write through a _relative_ path on purpose. Binding a mount
over the working directory leaves an already-standing process pointing at the
shadowed directory underneath, so `/workspace/file` can succeed while `./file`
is refused — and relative is how commands actually write.

`the_legacy_remount_fallback_enforces_the_same_boundary` forces the pre-5.12
remount path with `HAPPY_AGENT_SUPERVISOR_FORCE_LEGACY_REMOUNT=1`, because every
kernel this is tested on has `mount_setattr` and the fallback would otherwise
never execute anywhere it could be observed. It cannot run as a unit test:
libtest runs each test body on a spawned thread, and `unshare(CLONE_NEWUSER)`
returns `EINVAL` for a process with more than one thread, so it has to drive the
real binary as a subprocess.

`outgoing_proxy.rs` plays Rig: it connects a real descriptor, authenticates a
command token, and applies that command's policy per connection while the real
supervisor serves its front-ends inside the sandbox. It covers the allowed and
denied paths of both front-ends, a refused token stopping the command outright,
a transfer larger than one credit window, and the workload's inability to reach
the destination without the proxy.

## Running them on Linux from a macOS host

The test binaries bake in absolute paths at compile time, so the repository has
to appear inside the container at the same path it has on the host:

```sh
cargo +1.96.0 test --locked --target aarch64-unknown-linux-musl --no-run
docker run --rm --platform linux/arm64 \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  --security-opt systempaths=unconfined \
  -v "$REPO:$REPO" -w "$REPO/packages/happy-agent-supervisor/native" \
  alpine:3.20 "$REPO/.../deps/outgoing_proxy-<hash>" --test-threads=1
```

All three relaxations are needed and none of them weaken what is under test.
Docker's default seccomp profile refuses `unshare(CLONE_NEWUSER)`, its AppArmor
profile refuses the mount work, and its masked `/proc` entries leave procfs
partially covered, which makes mounting a private procfs inside a user
namespace fail. The supervisor installs its own filter and its own mounts once
it is running.

The amd64 lane cannot be run this way. QEMU user emulation does not implement
`prctl(PR_SET_SECCOMP)`, so the supervisor fails closed with `EINVAL` before it
reaches a front-end. That lane needs a real x86_64 kernel.
