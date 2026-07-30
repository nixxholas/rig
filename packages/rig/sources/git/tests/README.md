# git tests

Tests for the files one level up. Most of them build a real repository in a
temporary directory and run real Git against it, because the thing being checked
is what Git actually answers, not what a stub was told to say.

```
    tests/
       |
       |  mkdtemp() -> git init -> commit -> mutate
       |
       v
    real repository on disk
       |
       +--> runScanGit / scanGitRepository / parse*   what Git reports
       +--> probeGitRepository                        presence and facts
       +--> watchGitRepositoryChanges                 change notifications
       +--> GitStateTracker                           debounce, evict, publish
```

Two consequences follow from using real Git. A test that needs the sandboxed
reader cannot run inside another sandbox, because `sandbox-exec` does not nest;
and every test removes its temporary directory in `afterEach`, so a failure
leaves nothing behind.

`GitStateTracker.test.ts` is the exception: it drives the tracker through its
injected scan and Git seams so it can test debouncing, eviction, backoff, and
version ordering deterministically, without waiting on a filesystem.

Tests for the HTTP routes that expose Git state live in `server`, next to the
route handling they exercise, not here.
