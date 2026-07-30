# Process tests

These tests exercise native child-process lifecycle and exit observation.

```text
test process
     |
     +--> NativeProcessManager
     |
     +--> waitForProcessExit
```

Each test owns and terminates the processes it starts.
