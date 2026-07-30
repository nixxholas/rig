# Happy integration tests

These tests exercise the public behavior of the Happy module. They keep
protocol clients, credentials, encryption, synchronization, RPC handling, and
event-to-message translation next to the implementation without colocating
test files with source files.

```
tests/
  HappyMachineClient.test.ts
  HappySessionClient.test.ts
  HappySyncRepository.test.ts
  HappySyncService.test.ts
  createHappyAgentState.test.ts
  handleHappySessionRpc.test.ts
  handleHappySpawnSession.test.ts
  happyEncryption.test.ts
  importHappyCredentials.test.ts
  loadOrCreateHappyMachineId.test.ts
  mapSessionEventToHappyMessages.test.ts
  resolveHappyUserInputAnswers.test.ts
  runHappyAuthCommand.test.ts
```

Tests that use SQLite create isolated temporary databases. Tests that interact
with Happy networking use local fakes and do not require a live Happy service.
