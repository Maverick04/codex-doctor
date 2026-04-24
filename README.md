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
$doctor dg
$doctor dg -c
```

When the plugin skill is loaded with the plugin prefix:

```text
$codex-doctor:doctor dg
$codex-doctor:doctor dg -c
```

Direct CLI usage from this repository:

```bash
node scripts/codex-doctor.js dg
node scripts/codex-doctor.js dg -c
node scripts/codex-doctor.js dg <session-id>
node scripts/codex-doctor.js dg <session-id> -c
```

## Example Output

```text
Codex Doctor 🔵 [watch]  repeated work · tool failure

Context Usage
  ▰ ▰ ▰ ▰ ▰ ▰ ▰ ▰ ▰ ▰ ▰ ▰ ▱ ▱ ▱ ▱ ▱ ▱ ▱ ▱ ▱ ▱ ▱ ▱  123.6k/258.4k tokens (48%)  gpt-5.5 claude-trace
  usage: ctx 48% | session 20.8M tokens | 5h 93% left reset 4h29m | week 93% left | plan prolite
  activity: idle
  context: delta +14.8k / 20m, attributed 14.8k, top history/context carryover 80%
  repeat: codex debug prompt-input x2, 9s, ~5k tokens
  slowest: brew install --cask steipete/tap/codexbar, 3m37s, failed(-1)
```

## Installation

### Option A: Add this repository as a Codex marketplace

```bash
codex plugin marketplace add git@github.com:Maverick04/codex-doctor.git
```

Then enable the plugin if your Codex version does not auto-enable installed-by-default marketplace entries:

```toml
[plugins."codex-doctor@codex-doctor"]
enabled = true
```

Restart Codex after adding or enabling the plugin. Existing sessions usually do not hot-reload new plugin skills.

### Option B: Local marketplace install

```bash
git clone git@github.com:Maverick04/codex-doctor.git ~/learn_cc/codex-doctor
codex plugin marketplace add ~/learn_cc/codex-doctor
```

If needed, enable it in `~/.codex/config.toml`:

```toml
[plugins."codex-doctor@codex-doctor"]
enabled = true
```

### Option C: Run as a standalone script

```bash
git clone git@github.com:Maverick04/codex-doctor.git ~/learn_cc/codex-doctor
cd ~/learn_cc/codex-doctor
node scripts/codex-doctor.js dg
node scripts/codex-doctor.js dg -c
```

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
