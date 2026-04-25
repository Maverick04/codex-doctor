#!/usr/bin/env node

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const STATE_DB = path.join(CODEX_HOME, "state_5.sqlite");
const DOCTOR = path.join(__dirname, "codex-doctor.js");

const query = [
  "select id, coalesce(cwd,''), coalesce(model,''), coalesce(reasoning_effort,''),",
  "created_at, updated_at, tokens_used",
  "from threads where archived=0 order by updated_at desc;"
].join(" ");

const rows = run("sqlite3", ["-readonly", "-separator", "\t", STATE_DB, query]).stdout
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    const parts = line.split("\t");
    return {
      id: parts[0],
      cwd: parts[1],
      model: parts[2],
      effort: parts[3],
      created_at: Number(parts[4]) || 0,
      updated_at: Number(parts[5]) || 0,
      tokens_used: Number(parts[6]) || 0,
    };
  });

const results = rows.map((thread) => {
  const started = Date.now();
  const doctor = childProcess.spawnSync(process.execPath, [DOCTOR, "dg", thread.id, "-c"], {
    cwd: thread.cwd || process.cwd(),
    env: { ...process.env, CODEX_DOCTOR_COLOR: "0", NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 1024 * 1024 * 8,
  });
  const output = `${doctor.stdout || ""}${doctor.stderr || ""}`.trim();
  const issues = inspectOutput(thread, doctor, output);
  return {
    id: thread.id,
    short: `${thread.id.slice(0, 8)}...`,
    cwd: thread.cwd,
    model: thread.model,
    effort: thread.effort,
    runtime_hours: hours(thread),
    tokens: thread.tokens_used,
    status_code: doctor.status,
    elapsed_ms: Date.now() - started,
    output,
    issues,
  };
});

const summary = {
  total: results.length,
  failed: results.filter((item) => item.status_code !== 0).length,
  with_issues: results.filter((item) => item.issues.length > 0).length,
  issue_counts: countIssues(results),
  results,
};

console.log(JSON.stringify(summary, null, 2));

function inspectOutput(thread, doctor, output) {
  const issues = [];
  if (doctor.error) {
    issues.push(`spawn_error:${doctor.error.code || doctor.error.message}`);
  }
  if (doctor.status !== 0) {
    issues.push(`nonzero_exit:${doctor.status}`);
  }
  if (!output.includes("Codex Doctor")) {
    issues.push("missing_header");
  }
  if (/(?:^|\s)(?:node\s+)?(?:\.\/)?scripts\/codex-doctor\.js(?:\s+dg)?(?:\s|$)|codex-doctor(?:\/[^/\s]+)?\/scripts\/codex-doctor\.js/.test(output)) {
    issues.push("self_activity_leak");
  }
  if (/runtime (?:[1-9]\d{2,}h|unknown)/.test(output)) {
    issues.push("runtime_suspicious");
  }
  if (/ctx 0%/.test(output) && thread.tokens_used > 1000000) {
    issues.push("missing_token_sample_fallback");
  }
  if (/(^|[^/A-Za-z])(?:NaN|undefined|null)([^A-Za-z]|$)/.test(output)) {
    issues.push("bad_literal");
  }
  if (output.length > 1800) {
    issues.push("compact_too_long");
  }
  return issues;
}

function countIssues(results) {
  const counts = {};
  for (const result of results) {
    for (const issue of result.issues) {
      counts[issue] = (counts[issue] || 0) + 1;
    }
  }
  return counts;
}

function hours(thread) {
  if (!thread.created_at || !thread.updated_at || thread.updated_at < thread.created_at) {
    return 0;
  }
  return Math.round(((thread.updated_at - thread.created_at) / 3600) * 10) / 10;
}

function run(command, args) {
  const result = childProcess.spawnSync(command, args, {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024 * 4,
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}
