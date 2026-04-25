---
name: doctor
description: Use only when the user explicitly invokes `$codex-doctor:doctor`, `$doctor`, `$doctor dg`, or `$doctor dg -c` to diagnose a Codex session.
---

# doctor

Use this skill only for explicit `$codex-doctor:doctor` or `$doctor` invocations.

## Commands

- `$codex-doctor:doctor`, `$codex-doctor:doctor dg`, `$doctor`, and `$doctor dg`: run the full diagnosis.
- `$codex-doctor:doctor dg -c` and `$doctor dg -c`: run the compact diagnosis.
- `$codex-doctor:doctor --source` and `$doctor --source`: print the plugin script source check.

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

For source check mode:

```bash
node <resolved-plugin-root>/scripts/codex-doctor.js --source
```

## Output Relay Contract

After running the command, relay stdout verbatim:

- Paste the command output inside a fenced `text` code block.
- Do not summarize, translate, reorder, reformat, or convert tables into Markdown/list form.
- Do not omit sections such as `Health Signals`, `Context Growth`, `Repeated Work`, `Slow Tools`, or `Next Actions`.
- Do not add commentary before or after the output unless the command failed or the shell output was visibly truncated by the tool.
- If the full output is too long for the conversation, say it was truncated and rerun `$doctor dg -c`; never silently compress the full output.

## Notes

- The script defaults to `CODEX_THREAD_ID` from the current Codex tool environment when available.
- If invoked from a side session, the side thread's parent keeps the diagnosis focused on the main session instead of the `$doctor` side session.
- If the current thread cannot be resolved, it falls back to the current working directory's most recently active non-doctor Codex session.
- Do not auto-trigger this skill for natural-language questions unless the user explicitly includes `$doctor`.
