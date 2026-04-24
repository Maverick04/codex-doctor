const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const DOCTOR = path.resolve(__dirname, "../scripts/codex-doctor.js");

test("full diagnosis keeps core sections, sort markers, severity badges, and bounded runtime", () => {
  const fixture = createFixture({
    id: "11111111-1111-4111-8111-111111111111",
    createdAt: 1760000000,
    updatedAt: 1760007200,
    tokensUsed: 3200000,
    entries: [
      sessionMeta("11111111-1111-4111-8111-111111111111", "2026-04-24T00:00:00.000Z"),
      tokenCount("2026-04-24T00:00:00.000Z", 60000, 2500000),
      tokenCount("2026-04-24T00:10:00.000Z", 110000, 3200000),
      execEnd("2026-04-24T00:11:00.000Z", "a", "sed -n '1,220p' src/report.md", [{ type: "read", path: "src/report.md" }], "x".repeat(5200), 0, 0),
      execEnd("2026-04-24T00:12:00.000Z", "b", "sed -n '1,220p' src/report.md", [{ type: "read", path: "src/report.md" }], "x".repeat(5200), 0, 0),
      execEnd("2026-04-24T00:13:00.000Z", "c", "npm test", [{ type: "unknown" }], "failed".repeat(100), 1, 93),
    ],
  });

  const output = runDoctor(fixture, ["dg"]).stdout;

  assert.match(output, /Context Usage/);
  assert.match(output, /Health Signals/);
  assert.match(output, /Context Growth/);
  assert.match(output, /Repeated Work/);
  assert.match(output, /Slow Tools/);
  assert.match(output, /est\.tokens ↓/);
  assert.match(output, /time ↓/);
  assert.match(output, /🟢|🔵|🟡|🔴/);
  assert.match(output, /runtime 2h/);
  assert.doesNotMatch(output, /Session Summary/);
});

test("missing positive context token samples render as unknown instead of ctx 0%", () => {
  const fixture = createFixture({
    id: "22222222-2222-4222-8222-222222222222",
    tokensUsed: 22000000,
    entries: [
      sessionMeta("22222222-2222-4222-8222-222222222222", "2026-04-24T01:00:00.000Z"),
      tokenCount("2026-04-24T01:00:00.000Z", 0, 22000000),
      execEnd("2026-04-24T01:01:00.000Z", "a", "cat big.log", [{ type: "unknown" }], "x".repeat(12000), 0, 1),
    ],
  });

  const output = runDoctor(fixture, ["dg", "-c"]).stdout;

  assert.match(output, /context unknown/);
  assert.doesNotMatch(output, /ctx 0%/);
  assert.doesNotMatch(output, /NaN|undefined/);
});

test("non-string conversation payloads do not leak NaN shares", () => {
  const fixture = createFixture({
    id: "33333333-3333-4333-8333-333333333333",
    tokensUsed: 150000,
    entries: [
      sessionMeta("33333333-3333-4333-8333-333333333333", "2026-04-24T02:00:00.000Z"),
      tokenCount("2026-04-24T02:00:00.000Z", 20000, 100000),
      tokenCount("2026-04-24T02:05:00.000Z", 24000, 150000),
      {
        type: "event_msg",
        timestamp: "2026-04-24T02:05:10.000Z",
        payload: {
          type: "user_message",
          message: [{ type: "input_text", text: "structured payload" }],
        },
      },
    ],
  });

  const output = runDoctor(fixture, ["dg"]).stdout;

  assert.doesNotMatch(output, /NaN|undefined/);
  assert.match(output, /conversation/);
});

function createFixture(options) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-doctor-test-"));
  const cwd = path.join(home, "workspace");
  const sessionDir = path.join(home, "sessions", "2026", "04", "24");
  const rollout = path.join(sessionDir, `rollout-${options.id}.jsonl`);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(rollout, options.entries.map((entry) => JSON.stringify(entry)).join("\n"));

  const db = path.join(home, "state_5.sqlite");
  const createdAt = options.createdAt || 1760000000;
  const updatedAt = options.updatedAt || createdAt + 1800;
  const sql = [
    "create table threads (id text, rollout_path text, created_at integer, updated_at integer, cwd text, title text, model text, reasoning_effort text, tokens_used integer, first_user_message text, archived integer);",
    "create table thread_spawn_edges (child_thread_id text, parent_thread_id text);",
    `insert into threads values (${quote(options.id)}, ${quote(rollout)}, ${createdAt}, ${updatedAt}, ${quote(cwd)}, ${quote("fixture")}, ${quote("gpt-test")}, ${quote("xhigh")}, ${options.tokensUsed || 0}, ${quote("fixture")}, 0);`,
  ].join("\n");
  const result = childProcess.spawnSync("sqlite3", [db, sql], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  return { home, cwd, id: options.id };
}

function runDoctor(fixture, args) {
  const result = childProcess.spawnSync(process.execPath, [DOCTOR, ...args, fixture.id], {
    cwd: fixture.cwd,
    env: { ...process.env, CODEX_HOME: fixture.home, NO_COLOR: "1" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function sessionMeta(id, timestamp) {
  return {
    type: "session_meta",
    payload: { id, timestamp, cwd: "fixture" },
  };
}

function tokenCount(timestamp, inputTokens, totalTokens) {
  return {
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        model_context_window: 258400,
        last_token_usage: { input_tokens: inputTokens },
        total_token_usage: { input_tokens: totalTokens, output_tokens: 1000, total_tokens: totalTokens },
      },
      rate_limits: {
        primary: { used_percent: 12, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        secondary: { used_percent: 20 },
        plan_type: "prolite",
      },
    },
  };
}

function execEnd(timestamp, callId, command, parsedCmd, output, exitCode, seconds) {
  return {
    type: "event_msg",
    timestamp,
    payload: {
      type: "exec_command_end",
      call_id: callId,
      command: [command],
      parsed_cmd: parsedCmd,
      exit_code: exitCode,
      duration: { secs: seconds, nanos: 0 },
      aggregated_output: output,
    },
  };
}

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
