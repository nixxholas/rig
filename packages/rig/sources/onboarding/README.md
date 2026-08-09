# Onboarding

This module owns the daemon-side onboarding state machine.

```text
durable completion marker
          |
          v
  provider configured? ---> provider setup
          |
          v
existing profile contract ---> profile required
          |
          v
 explicit Murmur choice ---> Murmur setup
          |
          v
  version marked complete
```

`OnboardingService` always checks the durable completion marker first. That completed fast path
does not read provider configuration or profiles. An incomplete provider step only asks whether
at least one provider is configured locally; inference is never verified, and a provider failing
later never reopens onboarding.

Once a provider is configured and the profile is complete, onboarding requires one explicit
Murmur choice. Opting out persists `disabled` without opening the Murmur store or generating keys.
Opting in lazily creates or restores the identity, binds the existing human profile, and returns
its public key and profile. Either choice completes the current onboarding version.

Profile completeness is deliberately supplied by the existing profile domain. This module neither
defines nor mutates the profile schema.
