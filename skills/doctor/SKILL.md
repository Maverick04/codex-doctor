---
name: doctor
description: Use only when the user explicitly invokes `$doctor`, `$doctor dg`, or `$doctor dg -c` to diagnose a Codex session.
---

# doctor

Use this skill only for explicit `$doctor` invocations.

## Commands

- `$doctor` and `$doctor dg`: run the full diagnosis.
- `$doctor dg -c`: run the compact diagnosis.

## Workflow

Run the plugin script while keeping the shell `workdir` as the user's current workspace.
Resolve `../../scripts/codex-doctor.js` to an absolute path relative to this `SKILL.md` file, then run:

```bash
env CODEX_DOCTOR_COLOR=1 node <resolved-plugin-root>/scripts/codex-doctor.js dg
```

For compact mode:

```bash
env CODEX_DOCTOR_COLOR=1 node <resolved-plugin-root>/scripts/codex-doctor.js dg -c
```

Then relay the output directly. Do not add unrelated analysis.

## Notes

- The script defaults to the current working directory's most recently active non-doctor Codex session.
- If invoked from a side session, the non-doctor session selection keeps the diagnosis focused on the main session instead of the `$doctor` side session.
- Do not auto-trigger this skill for natural-language questions unless the user explicitly includes `$doctor`.
