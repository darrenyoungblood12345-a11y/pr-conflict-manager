# Codex native-hook qualification feasibility

The installed CLI reports `codex-cli 0.163.0-alpha.10.2`. Read-only local
`--help` and `--version` inspection was performed. No model turn, local provider
server, credential access, global configuration edit, trust bypass, or
`CODEX_HOME` change was used for this investigation.

The proposed model-free harness would run the actual CLI against an isolated
loopback Responses-compatible test provider, with an invocation-only custom
provider, dummy environment credential, normal workspace sandbox, and a temporary
Git fixture. Canned provider responses could request native `apply_patch`
actions, allowing file-change and denial evidence to be recorded without paid
inference. This is a feasibility proposal, not an implemented or proven harness.

The binding constraint is hook trust. Official documentation requires the
project layer to be trusted and each new/changed non-managed hook definition to
be reviewed using `/hooks`; otherwise the hook is skipped. Its documented
one-off bypass is explicitly outside the allowed test constraints. A temporary
project does not remove that trust requirement. Research stopped at this manual
step, as requested. Current adapter/unit/protocol tests therefore do not qualify
the actual Codex client’s native allow/deny behavior.

Official references fetched during this investigation:

- [Hook review and trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)
- [Configuration precedence, project restrictions, and custom providers](https://learn.chatgpt.com/docs/config-file/config-advanced)
- [Invocation-only Responses provider example](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)

A future actual-client qualification session needs the user to complete the
normal project/exact-hook trust flow first. It must still test denial, allowed
native edits, changed/untrusted hooks, hook crashes/timeouts, and tool paths that
are outside hook coverage. An already-running command is not stopped merely
because a later action is denied.
