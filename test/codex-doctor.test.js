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
      execEnd("2026-04-24T00:14:00.000Z", "d", "node scripts/slow-40.js", [{ type: "unknown" }], "ok", 0, 40),
      execEnd("2026-04-24T00:15:00.000Z", "e", "node scripts/slow-120.js", [{ type: "unknown" }], "boom", 2, 120),
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
  assert.match(output, /file reads/);
  assert.match(output, /read src\/report\.md/);
  assert.match(output, /x2/);
  assert.match(output, /▰|▱/);
  assert.match(output, /failed\(2\)/);
  assertInOrder(output, ["node scripts/slow-120.js", "npm test", "node scripts/slow-40.js"]);
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

test("default target skips a multiline doctor side thread and diagnoses its parent", () => {
  const parentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const doctorId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const fixture = createFixture({
    id: parentId,
    cwdName: "doctor-side-thread",
    threads: [
      {
        id: parentId,
        cwdName: "parent-project",
        createdAt: 1760000000,
        updatedAt: 1760003600,
        tokensUsed: 120000,
        title: "implement parent task",
        firstUserMessage: "implement parent task",
        entries: [
          sessionMeta(parentId, "2026-04-24T03:00:00.000Z"),
          tokenCount("2026-04-24T03:05:00.000Z", 32000, 120000),
        ],
      },
      {
        id: doctorId,
        cwdName: "doctor-side-thread",
        createdAt: 1760007000,
        updatedAt: 1760007600,
        tokensUsed: 9000,
        title: "side diagnostics",
        firstUserMessage: "please inspect\n$doctor dg",
        entries: [
          sessionMeta(doctorId, "2026-04-24T04:00:00.000Z"),
          tokenCount("2026-04-24T04:01:00.000Z", 2000, 9000),
        ],
      },
    ],
    edges: [{ child: doctorId, parent: parentId }],
  });

  const output = runDoctor(fixture, ["dg"], { appendId: false }).stdout;

  assert.match(output, /aaaaaaaa\.\.\./);
  assert.match(output, /parent-project/);
  assert.doesNotMatch(output, /bbbbbbbb\.\.\./);
});

test("final zero context token sample falls back to latest positive sample", () => {
  const fixture = createFixture({
    id: "44444444-4444-4444-8444-444444444444",
    tokensUsed: 560000,
    entries: [
      sessionMeta("44444444-4444-4444-8444-444444444444", "2026-04-24T04:00:00.000Z"),
      tokenCount("2026-04-24T04:00:00.000Z", 50000, 500000),
      tokenCount("2026-04-24T04:10:00.000Z", 0, 560000),
    ],
  });

  const output = runDoctor(fixture, ["dg", "-c"]).stdout;

  assert.match(output, /50k/);
  assert.match(output, /19%/);
  assert.doesNotMatch(output, /context unknown|ctx 0%/);
});

test("pending activity ignores doctor commands and reports the real running tool", () => {
  const fixture = createFixture({
    id: "55555555-5555-4555-8555-555555555555",
    tokensUsed: 240000,
    entries: [
      sessionMeta("55555555-5555-4555-8555-555555555555", "2026-04-24T05:00:00.000Z"),
      tokenCount("2026-04-24T05:00:00.000Z", 24000, 240000),
      functionCall("2026-04-24T05:01:00.000Z", "real-tool", "exec_command", { cmd: "npm run build -- --watch" }),
      functionCall("2026-04-24T05:02:00.000Z", "doctor-tool", "exec_command", { cmd: "node /tmp/codex-doctor/scripts/codex-doctor.js dg" }),
      functionCall("2026-04-24T05:03:00.000Z", "relative-doctor-tool", "exec_command", { cmd: "node scripts/codex-doctor.js dg" }),
    ],
  });

  const output = runDoctor(fixture, ["dg", "-c"]).stdout;

  assert.match(output, /activity: .*npm run build -- --watch/);
  assert.doesNotMatch(output, /codex-doctor\/scripts\/codex-doctor\.js/);
  assert.doesNotMatch(output, /scripts\/codex-doctor\.js/);
});

test("completed function calls are not reported as current activity", () => {
  const fixture = createFixture({
    id: "56565656-5656-4565-8565-565656565656",
    tokensUsed: 240000,
    entries: [
      sessionMeta("56565656-5656-4565-8565-565656565656", "2026-04-24T05:30:00.000Z"),
      tokenCount("2026-04-24T05:30:00.000Z", 24000, 240000),
      functionCall("2026-04-24T05:31:00.000Z", "done-tool", "exec_command", { cmd: "npm test" }),
      functionOutput("2026-04-24T05:31:05.000Z", "done-tool", "ok"),
    ],
  });

  const output = runDoctor(fixture, ["dg", "-c"]).stdout;

  assert.match(output, /activity: idle/);
  assert.doesNotMatch(output, /activity: .*npm test/);
});

test("audit script handles multiline thread text and keeps compact output clean", () => {
  const fixture = createFixture({
    id: "66666666-6666-4666-8666-666666666666",
    title: "multi\nline title",
    firstUserMessage: "multi\nline prompt",
    tokensUsed: 180000,
    entries: [
      sessionMeta("66666666-6666-4666-8666-666666666666", "2026-04-24T06:00:00.000Z"),
      tokenCount("2026-04-24T06:00:00.000Z", 26000, 180000),
    ],
  });

  const audit = runAudit(fixture);
  const summary = JSON.parse(audit.stdout);

  assert.equal(summary.total, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.with_issues, 0);
  assert.deepEqual(summary.issue_counts, {});
});

test("audit script reports bad compact-output literals", () => {
  const fixture = createFixture({
    id: "67676767-6767-4676-8676-676767676767",
    model: "undefined",
    tokensUsed: 180000,
    entries: [
      sessionMeta("67676767-6767-4676-8676-676767676767", "2026-04-24T06:30:00.000Z"),
      tokenCount("2026-04-24T06:30:00.000Z", 26000, 180000),
    ],
  });

  const audit = runAudit(fixture);
  const summary = JSON.parse(audit.stdout);

  assert.equal(summary.total, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.with_issues, 1);
  assert.equal(summary.issue_counts.bad_literal, 1);
});

test("forced color mode emits ANSI colors for health levels", () => {
  const fixture = createFixture({
    id: "77777777-7777-4777-8777-777777777777",
    tokensUsed: 400000,
    entries: [
      sessionMeta("77777777-7777-4777-8777-777777777777", "2026-04-24T07:00:00.000Z"),
      tokenCount("2026-04-24T07:00:00.000Z", 140000, 300000),
      tokenCount("2026-04-24T07:10:00.000Z", 230000, 400000),
      execEnd("2026-04-24T07:11:00.000Z", "a", "sed -n '1,80p' src/a.md", [{ type: "read", path: "src/a.md" }], "x".repeat(1200), 0, 0),
      execEnd("2026-04-24T07:12:00.000Z", "b", "sed -n '1,80p' src/a.md", [{ type: "read", path: "src/a.md" }], "x".repeat(1200), 0, 0),
      execEnd("2026-04-24T07:13:00.000Z", "c", "npm test", [{ type: "unknown" }], "failed", 1, 90),
    ],
  });

  const output = runDoctor(fixture, ["dg"], { color: true }).stdout;

  assert.match(output, /\u001b\[32;1m/);
  assert.match(output, /\u001b\[36;1m/);
  assert.match(output, /\u001b\[33;1m/);
  assert.match(output, /\u001b\[31;1m/);
});

test("filesystem rollout fallback selects the newest session when sqlite is absent", () => {
  const latestId = "88888888-8888-4888-8888-888888888888";
  const olderId = "89898989-8989-4898-8989-898989898989";
  const fixture = createRolloutOnlyFixture({
    id: latestId,
    rollouts: [
      {
        id: olderId,
        mtime: "2026-04-24T07:00:00.000Z",
        entries: [
          sessionMeta(olderId, "2026-04-24T07:00:00.000Z"),
          tokenCount("2026-04-24T07:00:00.000Z", 12000, 50000),
        ],
      },
      {
        id: latestId,
        mtime: "2026-04-24T08:00:00.000Z",
        entries: [
          sessionMeta(latestId, "2026-04-24T08:00:00.000Z"),
          tokenCount("2026-04-24T08:00:00.000Z", 18000, 90000),
        ],
      },
    ],
  });

  const output = runDoctor(fixture, ["dg"], { appendId: false }).stdout;

  assert.match(output, /88888888\.\.\./);
  assert.doesNotMatch(output, /89898989\.\.\./);
});

test("compact output keeps the one-screen summary contract", () => {
  const fixture = createFixture({
    id: "90909090-9090-4909-8909-909090909090",
    tokensUsed: 210000,
    entries: [
      sessionMeta("90909090-9090-4909-8909-909090909090", "2026-04-24T09:00:00.000Z"),
      tokenCount("2026-04-24T09:00:00.000Z", 12000, 100000),
      tokenCount("2026-04-24T09:05:00.000Z", 22000, 210000),
      execEnd("2026-04-24T09:06:00.000Z", "a", "sed -n '1,80p' README.md", [{ type: "read", path: "README.md" }], "x".repeat(1600), 0, 0),
      execEnd("2026-04-24T09:07:00.000Z", "b", "sed -n '1,80p' README.md", [{ type: "read", path: "README.md" }], "x".repeat(1600), 0, 0),
      execEnd("2026-04-24T09:08:00.000Z", "c", "npm test", [{ type: "unknown" }], "ok", 0, 31),
    ],
  });

  const lines = runDoctor(fixture, ["dg", "-c"]).stdout.trim().split(/\r?\n/);

  assert.equal(lines.length, 8);
  assert.match(lines[0], /^Codex Doctor /);
  assert.match(lines[1], /22k\/258\.4k tokens \(9%\).*gpt-test workspace/);
  assert.match(lines[2], /^usage: ctx 9% \| session 210k tokens \| 5h \d+% left/);
  assert.match(lines[3], /^activity: idle/);
  assert.match(lines[4], /^context: delta \+10k \/ 20m, attributed /);
  assert.match(lines[5], /^repeat: read README\.md x2, /);
  assert.match(lines[6], /^slowest: npm test, 31s, ok/);
  assert.match(lines[7], /^advice: /);
});

test("default target falls back to newest non-doctor session when cwd has no match", () => {
  const latestId = "91919191-9191-4919-8919-919191919191";
  const olderId = "92929292-9292-4929-8929-929292929292";
  const fixture = createFixture({
    id: latestId,
    cwdName: "no-session-here",
    threads: [
      {
        id: latestId,
        cwdName: "latest-project",
        updatedAt: 1760010000,
        tokensUsed: 110000,
        entries: [
          sessionMeta(latestId, "2026-04-24T10:00:00.000Z"),
          tokenCount("2026-04-24T10:00:00.000Z", 24000, 110000),
        ],
      },
      {
        id: olderId,
        cwdName: "older-project",
        updatedAt: 1760000000,
        tokensUsed: 100000,
        entries: [
          sessionMeta(olderId, "2026-04-24T09:00:00.000Z"),
          tokenCount("2026-04-24T09:00:00.000Z", 22000, 100000),
        ],
      },
    ],
  });

  const output = runDoctor(fixture, ["dg"], { appendId: false }).stdout;

  assert.match(output, /91919191\.\.\./);
  assert.match(output, /latest-project/);
  assert.doesNotMatch(output, /92929292\.\.\./);
});

test("web search events are attributed to context growth", () => {
  const fixture = createFixture({
    id: "93939393-9393-4939-8939-939393939393",
    tokensUsed: 11000,
    entries: [
      sessionMeta("93939393-9393-4939-8939-939393939393", "2026-04-24T11:00:00.000Z"),
      tokenCount("2026-04-24T11:00:00.000Z", 10000, 10000),
      webSearchEnd("2026-04-24T11:05:00.000Z", "codex doctor statusline"),
      tokenCount("2026-04-24T11:10:00.000Z", 10100, 11000),
    ],
  });

  const output = runDoctor(fixture, ["dg"]).stdout;

  assert.match(output, /web\/search/);
  assert.match(output, /codex doctor statusline/);
});

test("risk scoring keeps context threshold boundaries stable", () => {
  const watchFixture = createFixture({
    id: "94949494-9494-4949-8949-949494949494",
    tokensUsed: 217056,
    entries: [
      sessionMeta("94949494-9494-4949-8949-949494949494", "2026-04-24T12:00:00.000Z"),
      tokenCount("2026-04-24T12:00:00.000Z", 217056, 217056),
    ],
  });
  const warningFixture = createFixture({
    id: "95959595-9595-4959-8959-959595959595",
    tokensUsed: 219640,
    entries: [
      sessionMeta("95959595-9595-4959-8959-959595959595", "2026-04-24T12:05:00.000Z"),
      tokenCount("2026-04-24T12:05:00.000Z", 219640, 219640),
    ],
  });

  assert.match(runDoctor(watchFixture, ["dg", "-c"]).stdout, /Codex Doctor 🔵 \[watch\]/);
  assert.match(runDoctor(warningFixture, ["dg", "-c"]).stdout, /Codex Doctor 🟡 \[warning\]/);
});

test("advice covers long-running tools and long shell output", () => {
  const fixture = createFixture({
    id: "96969696-9696-4969-8969-969696969696",
    tokensUsed: 160000,
    entries: [
      sessionMeta("96969696-9696-4969-8969-969696969696", "2026-04-24T13:00:00.000Z"),
      tokenCount("2026-04-24T13:00:00.000Z", 12000, 100000),
      functionCall("2026-04-24T13:02:00.000Z", "long-tool", "exec_command", { cmd: "npm run integration" }),
      execEnd("2026-04-24T13:03:00.000Z", "huge-output", "cat huge.log", [{ type: "unknown" }], "x".repeat(12000), 0, 1),
      tokenCount("2026-04-24T13:10:00.000Z", 18000, 160000),
    ],
  });

  const output = runDoctor(fixture, ["dg"]).stdout;

  assert.match(output, /Current tool has been running/);
  assert.match(output, /Filter large shell output/);
});

test("high context advice suggests compacting after a checkpoint", () => {
  const fixture = createFixture({
    id: "97979797-9797-4979-8979-979797979797",
    tokensUsed: 220000,
    entries: [
      sessionMeta("97979797-9797-4979-8979-979797979797", "2026-04-24T14:00:00.000Z"),
      tokenCount("2026-04-24T14:00:00.000Z", 150000, 150000),
      tokenCount("2026-04-24T14:10:00.000Z", 220000, 220000),
    ],
  });

  const output = runDoctor(fixture, ["dg"]).stdout;

  assert.match(output, /Compact after the current verification checkpoint/);
});

function createFixture(options) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-doctor-test-"));
  const cwd = path.join(home, options.cwdName || "workspace");
  const sessionDir = path.join(home, "sessions", "2026", "04", "24");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });

  const db = path.join(home, "state_5.sqlite");
  const sql = [
    "create table threads (id text, rollout_path text, created_at integer, updated_at integer, cwd text, title text, model text, reasoning_effort text, tokens_used integer, first_user_message text, archived integer);",
    "create table thread_spawn_edges (child_thread_id text, parent_thread_id text);",
  ];
  const threads = options.threads || [options];

  for (const thread of threads) {
    const threadCwd = thread.cwd || path.join(home, thread.cwdName || options.cwdName || "workspace");
    const rollout = path.join(sessionDir, `rollout-${thread.id}.jsonl`);
    const createdAt = thread.createdAt || options.createdAt || 1760000000;
    const updatedAt = thread.updatedAt || options.updatedAt || createdAt + 1800;

    fs.mkdirSync(threadCwd, { recursive: true });
    fs.writeFileSync(rollout, (thread.entries || []).map((entry) => JSON.stringify(entry)).join("\n"));
    sql.push(`insert into threads values (${quote(thread.id)}, ${quote(rollout)}, ${createdAt}, ${updatedAt}, ${quote(threadCwd)}, ${quote(thread.title || "fixture")}, ${quote(thread.model || "gpt-test")}, ${quote(thread.reasoning || "xhigh")}, ${thread.tokensUsed || 0}, ${quote(thread.firstUserMessage || "fixture")}, 0);`);
  }

  for (const edge of options.edges || []) {
    sql.push(`insert into thread_spawn_edges values (${quote(edge.child)}, ${quote(edge.parent)});`);
  }

  const result = childProcess.spawnSync("sqlite3", [db, sql.join("\n")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  return { home, cwd, id: options.id };
}

function createRolloutOnlyFixture(options) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-doctor-test-"));
  const cwd = path.join(home, options.cwdName || "workspace");
  const sessionDir = path.join(home, "sessions", "2026", "04", "24");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });

  for (const rolloutInfo of options.rollouts || []) {
    const rollout = path.join(sessionDir, `rollout-${rolloutInfo.id}.jsonl`);
    fs.writeFileSync(rollout, (rolloutInfo.entries || []).map((entry) => JSON.stringify(entry)).join("\n"));
    const mtime = new Date(rolloutInfo.mtime || Date.now());
    fs.utimesSync(rollout, mtime, mtime);
  }

  return { home, cwd, id: options.id };
}

function runDoctor(fixture, args, options = {}) {
  const argv = [DOCTOR, ...args];
  if (options.appendId !== false) {
    argv.push(options.id || fixture.id);
  }

  const env = { ...process.env, CODEX_HOME: fixture.home, NO_COLOR: "1", ...(options.env || {}) };
  if (options.color) {
    delete env.NO_COLOR;
    env.CODEX_DOCTOR_COLOR = "1";
  }

  const result = childProcess.spawnSync(process.execPath, argv, {
    cwd: options.cwd || fixture.cwd,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function runAudit(fixture) {
  const result = childProcess.spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/audit-sessions.js")], {
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

function webSearchEnd(timestamp, query) {
  return {
    type: "event_msg",
    timestamp,
    payload: {
      type: "web_search_end",
      query,
    },
  };
}

function functionCall(timestamp, callId, name, args) {
  return {
    type: "response_item",
    timestamp,
    payload: {
      type: "function_call",
      call_id: callId,
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function functionOutput(timestamp, callId, output) {
  return {
    type: "response_item",
    timestamp,
    payload: {
      type: "function_call_output",
      call_id: callId,
      output,
    },
  };
}

function assertInOrder(text, expected) {
  let offset = -1;
  for (const item of expected) {
    const next = text.indexOf(item, offset + 1);
    assert.ok(next > offset, `${item} should appear after previous item`);
    offset = next;
  }
}

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
