# Immutable GitHub workspace binding

Desktop task registration/revision requires a selected local Git clone with a
supported `github.com` origin. The main process rereads that origin through the
read-only local Git observer, canonicalizes owner/repository identity, and checks
fresh authoritative workspace state. It never fetches the origin URL.

If the workspace is unbound, the main process commits `bind_repository` using
the observed identity and rereads committed state to confirm both authority and
the exact identity. A simultaneous different binding or lost authority rejects
the task attempt. An existing binding is immutable; a clone of another
repository cannot register or revise work there.

The renderer cannot send an arbitrary `bind_repository` command through its
validated command IPC. Workspace/client/selected-root generation guards prevent
an in-flight read, parser operation, or task result from being reused after a
selection change. GitHub owner/repository metadata comes from the local clone,
not a renderer-entered URL. Native command validation independently enforces
immutability.

Overview and Worktree display the binding from the workspace snapshot. A saved
binding is labeled when coordination is unavailable, and workspace-key changes
clear the old snapshot. A new task form uses the last local Git observation’s
branch and HEAD as editable defaults, without overwriting a user's intervening
edits or an existing task revision.

Focused tests cover an actual temporary Git repository (without network),
credential-redacted origins, existing mismatches, concurrent binding changes,
missing authority, stale acceptance, generation checks, and rejection of direct
renderer binding commands. This binding identifies repository coordination; it
does not establish semantic independence, branch mergeability, or conflict-free
merges.
