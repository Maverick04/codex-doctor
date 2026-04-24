# codex-doctor

`codex-doctor` is a local Codex plugin for diagnosing why a Codex session feels slow, expensive, repetitive, or close to context pressure. It reads local Codex session metadata and rollout JSONL files, then renders a compact or full session health report inside Codex.

## Features

- Context usage meter with model, session tokens, quota, start time, runtime, and current activity.
- Health signals for context, quota, activity, context growth, repeated work, and slow tools.
- Context growth attribution over the recent window, grouped by history carryover, file reads, shell output, search output, conversation, and web/search.
- Repeated work detection for repeated file reads, searches, commands, and repeated failures.
- Slow tool ranking by elapsed time, with failure status.
- Session selection that avoids diagnosing the doctor side session when invoked from a `/side` session.
- Compact mode for one-screen summaries.
- Dependency-free Node.js implementation.

## Commands

Inside Codex:

```text
$codex-doctor:doctor dg
$codex-doctor:doctor dg -c
$doctor dg
$doctor dg -c
```

Use the prefixed form first when you want to verify that Codex is invoking the plugin-provided skill rather than any other skill or shell alias named `doctor`.

Direct CLI usage from this repository:

```bash
node scripts/codex-doctor.js dg
node scripts/codex-doctor.js dg -c
node scripts/codex-doctor.js dg <session-id>
node scripts/codex-doctor.js dg <session-id> -c
node scripts/codex-doctor.js --source
node scripts/codex-doctor.js --version
```

## Example Output

```text
Codex Doctor 🟡 [warning]  context rising · repeated work · tool failure
source: codex-doctor@0.1.0 · plugin bundle

Context Usage
  ▰ ▰ ▰ ▰ ▰ ▰ ▰ ▰ ▰ ▰ ▰ ▰ ▰ ▰ ▰ ▰ ▰ ▱ ▱ ▱ ▱ ▱ ▱ ▱ ▱ ▱ ▱ ▱ ▱ ▱ ▱ ▱  gpt-5.5 xhigh
  186.4k/258.4k tokens (72%) · session 12.8M tokens · 5h 18% left reset 42m · week 61% left · plan pro
  019f2a44... · checkout-service · started 04-25 09:18 · runtime 2h41m · updated 12:01 · activity 4m12s · npm test -- --watch

Health Signals
┌──────────┬────────────┬────────────────────────────────────────────────────────────┐
│ signal   │ level      │ detail                                                     │
├──────────┼────────────┼────────────────────────────────────────────────────────────┤
│ context  │ 🟡 WARNING │ 186.4k/258.4k tokens (72%) · free 72k                     │
│ quota    │ 🟡 WARNING │ 5h 18% left reset 42m · week 61% left                      │
│ activity │ 🟡 WARNING │ 4m12s · npm test -- --watch                                │
│ growth   │ 🔵 WATCH   │ delta +38k · attributed 41k · top file reads 46%           │
│ repeat   │ 🔵 WATCH   │ read src/orders.ts x4, 18s, ~9.4k tokens                  │
│ tools    │ 🔵 WATCH   │ npm test -- --watch · 4m12s · still running                │
└──────────┴────────────┴────────────────────────────────────────────────────────────┘

Context Growth
last 20m · observed delta +38k tokens · attributed input 41k tokens
┌───────────────────────────┬──────────────┬─────────────────────┬────────────────────────────┐
│ source                    │ est.tokens ↓ │ share               │ evidence                   │
├───────────────────────────┼──────────────┼─────────────────────┼────────────────────────────┤
│ file reads                │ +18.8k       │ ▰ ▰ ▰ ▰ ▰ ▱ ▱ ▱ 46% │ src/orders.ts; src/api.ts  │
│ long shell output         │ +12.4k       │ ▰ ▰ ▰ ▱ ▱ ▱ ▱ ▱ 30% │ npm test -- --watch        │
│ history/context carryover │ +7.8k        │ ▰ ▰ ▱ ▱ ▱ ▱ ▱ ▱ 19% │ prior conversation         │
│ web/search                │ +2k          │ ▰ ▱ ▱ ▱ ▱ ▱ ▱ ▱ 5%  │ payment retry semantics    │
└───────────────────────────┴──────────────┴─────────────────────┴────────────────────────────┘

Repeated Work
┌───────────────────────┬───────┬──────┬──────────────┬─────────────────────────────────────┐
│ work                  │ count │ time │ est.tokens ↓ │ suggestion                          │
├───────────────────────┼───────┼──────┼──────────────┼─────────────────────────────────────┤
│ read src/orders.ts    │ x4    │ 18s  │ 9.4k         │ Use targeted grep or line ranges    │
│ search createOrder    │ x3    │ 7s   │ 2.1k         │ Reuse previous search result        │
└───────────────────────┴───────┴──────┴──────────────┴─────────────────────────────────────┘

Slow Tools
┌────────────────────────┬────────┬───────────┬────────────────────────────┐
│ tool                   │ time ↓ │ status    │ note                       │
├────────────────────────┼────────┼───────────┼────────────────────────────┤
│ npm run e2e            │ 2m14s  │ failed(1) │ shell command              │
│ npm run lint           │ 54s    │ failed(1) │ shell command              │
│ rg "createOrder" src   │ 7s     │ ok        │ search                     │
└────────────────────────┴────────┴───────────┴────────────────────────────┘

Next Actions
1. Current tool has been running 4m12s; verify whether it is expected before retrying.
2. Avoid re-reading full files; use targeted grep or line ranges.
3. Compact after the current verification checkpoint.
```

## Installation

### Standalone CLI

This path is verified against the current repository layout.

```bash
git clone https://github.com/Maverick04/codex-doctor.git ~/codex-doctor
cd ~/codex-doctor
npm test
node scripts/codex-doctor.js dg
node scripts/codex-doctor.js dg -c
```

### Codex Skill / Plugin

The repository includes a Codex plugin bundle:

- `.codex-plugin/plugin.json`
- `.agents/plugins/marketplace.json`
- `skills/doctor/SKILL.md`

In plugin-enabled Codex builds, install this repository with your Codex plugin manager, restart Codex, then run:

```text
$codex-doctor:doctor dg
$codex-doctor:doctor dg -c
$doctor dg
$doctor dg -c
```

The first output lines should include a source check:

```text
Codex Doctor 🔵 [watch]
source: codex-doctor@0.1.0 · plugin bundle
```

If direct CLI usage shows `source: codex-doctor@0.1.0 · local checkout`, you are running the repository script directly instead of the installed plugin bundle.

Note: the Codex CLI build used to verify this README does not expose a stable `plugin marketplace` command, so this README does not document one as a verified install path.

## How It Works

`codex-doctor` uses only local Codex data:

- `~/.codex/state_5.sqlite`
- `~/.codex/sessions/**/*.jsonl`

The script resolves a target session, parses rollout events, and computes:

- Usage and quota from `token_count` events.
- Current activity from pending `function_call` events that do not yet have outputs.
- Context growth from recent input token deltas and observed message/tool output.
- Repeated work from repeated reads, searches, commands, and failed commands.
- Slow tools from `exec_command_end` durations.

For historical sessions with missing or incomplete token samples, it falls back carefully:

- Missing positive context samples render as `context unknown` instead of `ctx 0%`.
- Session total tokens fall back to the thread metadata in `state_5.sqlite`.
- Repeated work and slow tool analysis still work if rollout events exist.

## Output Semantics

Severity levels:

- 🟢 `HEALTHY`: no obvious risk.
- 🔵 `WATCH`: useful signal, but not urgent.
- 🟡 `WARNING`: likely worth intervention soon.
- 🔴 `CRITICAL`: context, quota, repeat loops, or tool failures are likely impacting work.

Default table sorting:

- `Context Growth`: `est.tokens ↓`
- `Repeated Work`: `est.tokens ↓`
- `Slow Tools`: `time ↓`

## Tests

```bash
npm test
```

The test suite builds temporary Codex homes and validates:

- Full output sections, bordered tables, sort markers, share bars, severity badges, and slow-tool ordering.
- Context token edge cases, including missing positive samples and final zero samples.
- Structured message payloads, multiline thread metadata, and output hygiene checks.
- Default session selection, including doctor side-thread parent recovery.
- Pending and completed tool activity detection.
- Audit-script clean and issue-detection paths.
- Forced ANSI color mode for health levels.
- Fallback rollout discovery when `state_5.sqlite` is unavailable.
- Compact output's one-screen summary contract.
- CWD fallback selection, web-search context attribution, risk thresholds, and advice branches.

You can also audit local sessions:

```bash
node scripts/audit-sessions.js
```

## Requirements

- Node.js 16+
- `sqlite3` CLI
- A local Codex installation with session data under `~/.codex`

## License

MIT
