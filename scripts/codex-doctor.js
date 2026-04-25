#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const STATE_DB = path.join(CODEX_HOME, "state_5.sqlite");
const SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
const WINDOW_MINUTES = 20;
const MAX_ROWS = 5;
const PACKAGE_INFO = loadPackageInfo();

main();

function main() {
  try {
    const argv = process.argv.slice(2);
    const command = argv[0] || "dg";

    if (command === "--version" || command === "version") {
      console.log(`${PACKAGE_INFO.name} ${PACKAGE_INFO.version}`);
      return;
    }

    if (command === "--source" || command === "source") {
      printSourceCheck();
      return;
    }

    if (command !== "dg") {
      printUsage();
      process.exitCode = 1;
      return;
    }

    const compact = argv.includes("-c") || argv.includes("--compact");
    const sessionArg = argv.find((item) => item !== "dg" && item !== "-c" && item !== "--compact");
    const diagnosis = diagnose({
      sessionArg,
      cwd: process.cwd(),
      currentThreadId: process.env.CODEX_THREAD_ID || "",
    });

    if (compact) {
      printCompact(diagnosis);
    } else {
      printFull(diagnosis);
    }
  } catch (error) {
    console.error(`codex-doctor failed: ${error.message}`);
    process.exitCode = 1;
  }
}

function diagnose(options) {
  const target = resolveTarget(options);
  const entries = loadJsonl(target.rollout_path);
  const parsed = parseSession(entries, target);
  const usage = buildUsage(parsed, target);
  const activity = findCurrentActivity(parsed);
  const context = buildContextAttribution(parsed);
  const keyEvents = buildKeyEvents(parsed);
  const repeated = buildRepeatedWork(parsed);
  const completedExecs = parsed.execEnds.filter((exec) => !exec.is_doctor);
  const slowTools = completedExecs
    .slice()
    .sort((a, b) => b.duration_ms - a.duration_ms)
    .slice(0, MAX_ROWS);
  const risk = scoreRisk({ usage, activity, context, repeated, slowTools });
  const advice = buildAdvice({ risk, usage, activity, context, repeated, slowTools });

  return {
    status: risk.status,
    reasons: risk.reasons,
    target,
    usage,
    activity,
    context,
    keyEvents,
    repeated,
    slowTools,
    advice,
  };
}

function resolveTarget(options) {
  const threads = loadThreads();
  if (threads.length === 0) {
    const latest = findLatestRollout();
    if (!latest) {
      throw new Error(`no Codex sessions found under ${SESSIONS_DIR}`);
    }
    return latest;
  }

  if (options.sessionArg) {
    const match = threads.find((thread) => thread.id.startsWith(options.sessionArg) || thread.id.includes(options.sessionArg));
    if (!match) {
      throw new Error(`session not found: ${options.sessionArg}`);
    }
    return match;
  }

  const current = resolveCurrentThreadTarget(options.currentThreadId, threads);
  if (current) {
    return current;
  }

  const sameCwd = threads.filter((thread) => thread.cwd === options.cwd);
  const pool = sameCwd.length > 0 ? sameCwd : threads;
  const nonDoctor = pool.find((thread) => !isDoctorThread(thread));
  const selected = nonDoctor || pool[0];
  const parent = selected && isDoctorThread(selected) ? loadParentThread(selected.id, threads) : null;
  return parent || selected;
}

function resolveCurrentThreadTarget(threadId, threads) {
  const normalized = normalizeThreadId(threadId);
  if (!normalized) {
    return null;
  }

  const current = threads.find((thread) => thread.id === normalized);
  if (!current) {
    return null;
  }

  return loadParentThread(current.id, threads) || current;
}

function loadThreads() {
  if (!fs.existsSync(STATE_DB)) {
    return [];
  }

  const query = [
    "select id, rollout_path, created_at, updated_at, cwd,",
    "replace(replace(replace(coalesce(title,''), char(9), ' '), char(10), '\\n'), char(13), '\\r'),",
    "coalesce(model,''), coalesce(reasoning_effort,''), tokens_used,",
    "replace(replace(replace(coalesce(first_user_message,''), char(9), ' '), char(10), '\\n'), char(13), '\\r')",
    "from threads where archived=0 order by updated_at desc limit 100;"
  ].join(" ");
  const result = childProcess.spawnSync("sqlite3", ["-readonly", "-separator", "\t", STATE_DB, query], {
    encoding: "utf8",
    timeout: 2000,
  });

  if (result.status !== 0 || !result.stdout.trim()) {
    return [];
  }

  return result.stdout.trim().split(/\r?\n/).map((line) => {
    const parts = line.split("\t");
    return {
      id: parts[0],
      rollout_path: parts[1],
      created_at: Number(parts[2]) || 0,
      updated_at: Number(parts[3]) || 0,
      cwd: parts[4] || "",
      title: parts[5] || "",
      model: parts[6] || "",
      reasoning_effort: parts[7] || "",
      tokens_used: Number(parts[8]) || 0,
      first_user_message: parts[9] || "",
    };
  }).filter((thread) => thread.rollout_path && fs.existsSync(thread.rollout_path));
}

function loadParentThread(childId, threads) {
  if (!fs.existsSync(STATE_DB)) {
    return null;
  }

  const query = `select parent_thread_id from thread_spawn_edges where child_thread_id='${escapeSql(childId)}' limit 1;`;
  const result = childProcess.spawnSync("sqlite3", ["-readonly", STATE_DB, query], {
    encoding: "utf8",
    timeout: 1000,
  });
  const parentId = result.status === 0 ? result.stdout.trim() : "";
  return parentId ? threads.find((thread) => thread.id === parentId) || null : null;
}

function findLatestRollout() {
  const files = [];
  walk(SESSIONS_DIR, (file) => {
    if (file.endsWith(".jsonl")) {
      const stat = fs.statSync(file);
      files.push({ file, mtimeMs: stat.mtimeMs });
    }
  });
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!files[0]) {
    return null;
  }

  const entries = loadJsonl(files[0].file);
  const meta = entries.find((entry) => entry.type === "session_meta");
  return {
    id: meta && meta.payload && meta.payload.id || path.basename(files[0].file, ".jsonl"),
    rollout_path: files[0].file,
    created_at: Math.floor(files[0].mtimeMs / 1000),
    updated_at: Math.floor(files[0].mtimeMs / 1000),
    cwd: meta && meta.payload && meta.payload.cwd || "",
    title: "",
    model: "",
    reasoning_effort: "",
    tokens_used: 0,
    first_user_message: "",
  };
}

function parseSession(entries, target) {
  const result = {
    id: target.id,
    cwd: target.cwd,
    model: target.model,
    reasoning: target.reasoning_effort,
    started_at: target.created_at ? new Date(target.created_at * 1000).toISOString() : null,
    updated_at: target.updated_at ? new Date(target.updated_at * 1000).toISOString() : null,
    tokenSamples: [],
    execCalls: [],
    execEnds: [],
    functionOutputs: new Set(),
    webEvents: [],
    messages: [],
    compactEvents: [],
    importantEvents: [],
    latestTimestamp: null,
  };

  for (const entry of entries) {
    if (entry.timestamp) {
      result.latestTimestamp = entry.timestamp;
      result.updated_at = entry.timestamp;
    }

    if (entry.type === "session_meta") {
      result.id = get(entry, "payload.id") || result.id;
      result.cwd = get(entry, "payload.cwd") || result.cwd;
      result.started_at = get(entry, "payload.timestamp") || result.started_at;
      continue;
    }

    if (entry.type === "turn_context") {
      result.model = get(entry, "payload.model") || result.model;
      result.reasoning = get(entry, "payload.effort") || get(entry, "payload.collaboration_mode.settings.reasoning_effort") || result.reasoning;
      continue;
    }

    if (entry.type === "response_item" && get(entry, "payload.type") === "function_call") {
      result.execCalls.push(normalizeFunctionCall(entry));
      continue;
    }

    if (entry.type === "response_item" && get(entry, "payload.type") === "function_call_output") {
      const callId = get(entry, "payload.call_id");
      if (callId) {
        result.functionOutputs.add(callId);
      }
      continue;
    }

    if (entry.type !== "event_msg") {
      continue;
    }

    const payloadType = get(entry, "payload.type");
    if (payloadType === "token_count") {
      result.tokenSamples.push(normalizeTokenSample(entry));
    } else if (payloadType === "exec_command_end") {
      result.execEnds.push(normalizeExecEnd(entry));
    } else if (payloadType === "web_search_end") {
      result.webEvents.push({
        timestamp: entry.timestamp,
        query: get(entry, "payload.query") || get(entry, "payload.action.query") || get(entry, "payload.action.url") || "web",
      });
    } else if (payloadType === "user_message" || payloadType === "agent_message") {
      result.messages.push({
        timestamp: entry.timestamp,
        role: payloadType === "user_message" ? "user" : "assistant",
        text: get(entry, "payload.message") || get(entry, "payload.last_agent_message") || "",
      });
    } else if (payloadType === "context_compacted") {
      result.compactEvents.push({ timestamp: entry.timestamp });
    } else if (payloadType === "turn_aborted" || payloadType === "thread_rolled_back" || payloadType === "error") {
      result.importantEvents.push({
        timestamp: entry.timestamp,
        type: payloadType,
        detail: summarizeImportantPayload(payloadType, entry.payload || {}),
      });
    } else if (payloadType === "patch_apply_end" && get(entry, "payload.success") === false) {
      result.importantEvents.push({
        timestamp: entry.timestamp,
        type: payloadType,
        detail: summarizeImportantPayload(payloadType, entry.payload || {}),
      });
    } else if (/^collab_/.test(String(payloadType || "")) || payloadType === "mcp_tool_call_end") {
      result.importantEvents.push({
        timestamp: entry.timestamp,
        type: payloadType,
        detail: summarizeImportantPayload(payloadType, entry.payload || {}),
      });
    }
  }

  return result;
}

function buildUsage(parsed, target) {
  const last = parsed.tokenSamples[parsed.tokenSamples.length - 1] || null;
  const contextSample = parsed.tokenSamples
    .slice()
    .reverse()
    .find((sample) => Number.isFinite(sample.input_tokens) && sample.input_tokens > 0 && get(sample, "info.model_context_window"));
  const usage = last && last.info && last.info.total_token_usage || {};
  const contextWindow = contextSample && contextSample.info && contextSample.info.model_context_window || last && last.info && last.info.model_context_window || 0;
  const contextInput = contextSample ? contextSample.input_tokens : null;
  const contextPercent = contextInput !== null && contextWindow ? Math.round((contextInput / contextWindow) * 100) : null;

  return {
    context_percent: contextPercent,
    context_input_tokens: contextInput || 0,
    context_window: contextWindow,
    input_tokens: usage.input_tokens || target.tokens_used || 0,
    cached_input_tokens: usage.cached_input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    reasoning_output_tokens: usage.reasoning_output_tokens || 0,
    total_tokens: usage.total_tokens || target.tokens_used || 0,
  };
}

function findCurrentActivity(parsed) {
  const completed = new Set(parsed.execEnds.map((item) => item.call_id));
  for (const callId of parsed.functionOutputs) {
    completed.add(callId);
  }

  const pending = parsed.execCalls
    .filter((call) => !completed.has(call.call_id))
    .sort((a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp));
  const active = pending.find((call) => !isDoctorCommand(call.command)) || null;
  if (!active) {
    return { state: "idle", label: "idle", elapsed_ms: 0 };
  }

  return {
    state: "running",
    label: summarizeCall(active),
    elapsed_ms: Math.max(0, Date.now() - timestampMs(active.timestamp)),
    call_id: active.call_id,
  };
}

function buildContextAttribution(parsed) {
  const samples = parsed.tokenSamples.filter((sample) => Number.isFinite(sample.input_tokens));
  const last = samples[samples.length - 1] || null;
  if (!last) {
    return { growth_tokens: 0, attributed_tokens: 0, window_minutes: WINDOW_MINUTES, sources: [] };
  }

  const endMs = timestampMs(last.timestamp);
  const windowStartMs = endMs - WINDOW_MINUTES * 60 * 1000;
  const lastCompactMs = Math.max(0, ...parsed.compactEvents
    .map((event) => timestampMs(event.timestamp))
    .filter((time) => time && time <= endMs));
  const startMs = Math.max(windowStartMs, lastCompactMs || 0);
  const compacted = Boolean(lastCompactMs && lastCompactMs >= windowStartMs);
  const baseline = samples.find((sample) => timestampMs(sample.timestamp) >= startMs) || samples[Math.max(0, samples.length - 2)] || last;
  const baselineMs = timestampMs(baseline.timestamp);
  const growth = Math.max(0, last.input_tokens - baseline.input_tokens);
  const buckets = new Map();

  for (const exec of parsed.execEnds) {
    if (exec.is_doctor) {
      continue;
    }
    if (timestampMs(exec.timestamp) < startMs) {
      continue;
    }

    const tokens = estimateTokensFromLength(exec.output_len);
    const bucket = classifyExecForContext(exec);
    addBucket(buckets, bucket.source, tokens, bucket.evidence);
  }

  for (const event of parsed.webEvents) {
    if (timestampMs(event.timestamp) >= startMs) {
      addBucket(buckets, "web/search", 200, truncate(event.query, 50));
    }
  }

  for (const msg of parsed.messages) {
    if (timestampMs(msg.timestamp) >= startMs) {
      addBucket(buckets, "conversation", estimateTokensFromText(msg.text), `${msg.role} message`);
    }
  }

  const total = Array.from(buckets.values()).reduce((sum, item) => sum + item.tokens, 0);
  if (growth > total) {
    addBucket(buckets, "history/context carryover", growth - total, "prior conversation and session context");
  }
  const adjustedTotal = Array.from(buckets.values()).reduce((sum, item) => sum + item.tokens, 0);
  const denom = Math.max(growth, adjustedTotal, 1);
  const sources = Array.from(buckets.entries())
    .map(([source, item]) => ({
      source,
      tokens: item.tokens,
      share: Number.isFinite(item.tokens / denom) ? item.tokens / denom : 0,
      evidence: item.evidence.slice(0, 3).join("; "),
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, MAX_ROWS);

  return {
    growth_tokens: growth,
    attributed_tokens: adjustedTotal,
    window_minutes: WINDOW_MINUTES,
    compacted,
    sample_start: baseline.timestamp,
    sample_end: last.timestamp,
    sample_span_ms: Math.max(0, endMs - baselineMs),
    sources,
  };
}

function buildKeyEvents(parsed) {
  const events = [];

  parsed.compactEvents.slice(-2).forEach((event) => {
    const sampleChange = describeCompactSampleChange(event, parsed.tokenSamples);
    events.push({
      timestamp: event.timestamp,
      type: "context compact",
      level: "warning",
      info: sampleChange
        ? `ctx sample ${formatTokens(sampleChange.before_tokens)} -> ${formatTokens(sampleChange.after_tokens)} (${formatSignedTokens(sampleChange.delta_tokens)})`
        : "context window reset",
      impact: sampleChange
        ? `samples ${formatRelativeOffset(sampleChange.before_offset_ms)}/${formatRelativeOffset(sampleChange.after_offset_ms)}; growth is measured after this point`
        : "growth is measured after this point",
    });
  });

  const gapEvent = buildTokenSampleGapEvent(parsed.tokenSamples);
  if (gapEvent) {
    events.push(gapEvent);
  }

  parsed.execEnds
    .filter((exec) => !exec.is_doctor && exec.exit_code !== 0)
    .sort((a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp))
    .slice(0, 2)
    .forEach((exec) => {
      events.push({
        timestamp: exec.timestamp,
        type: exec.exit_code < 0 ? "tool runner failure" : "tool failure",
        level: exec.exit_code < 0 ? "warning" : "watch",
        info: `${exec.label} · ${formatDuration(exec.duration_ms)} · ${toolStatusText(exec)}`,
        impact: exec.exit_code < 0
          ? "runner did not report a shell exit code"
          : "command output may be incomplete or stale",
      });
    });

  parsed.importantEvents
    .slice()
    .sort((a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp))
    .slice(0, 3)
    .forEach((event) => {
      events.push({
        timestamp: event.timestamp,
        type: formatEventType(event.type),
        level: levelForEventType(event.type),
        info: event.detail || "-",
        impact: impactForEventType(event.type),
      });
    });

  return events
    .filter((event) => event.timestamp)
    .sort((a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp))
    .slice(0, MAX_ROWS);
}

function describeCompactSampleChange(event, samples) {
  const compactMs = timestampMs(event.timestamp);
  if (!compactMs) {
    return null;
  }

  const maxDistanceMs = WINDOW_MINUTES * 60 * 1000;
  const valid = samples.filter((sample) => sample.timestamp && Number.isFinite(sample.input_tokens));
  const before = valid
    .filter((sample) => {
      const sampleMs = timestampMs(sample.timestamp);
      return sampleMs < compactMs && sample.input_tokens > 0 && compactMs - sampleMs <= maxDistanceMs;
    })
    .pop();
  const after = valid.find((sample) => {
    const sampleMs = timestampMs(sample.timestamp);
    return sampleMs > compactMs && sample.input_tokens > 0 && sampleMs - compactMs <= maxDistanceMs;
  });

  if (!before || !after) {
    return null;
  }

  return {
    before_tokens: before.input_tokens,
    after_tokens: after.input_tokens,
    delta_tokens: after.input_tokens - before.input_tokens,
    before_offset_ms: timestampMs(before.timestamp) - compactMs,
    after_offset_ms: timestampMs(after.timestamp) - compactMs,
  };
}

function buildTokenSampleGapEvent(samples) {
  const valid = samples
    .filter((sample) => Number.isFinite(sample.input_tokens) && sample.timestamp)
    .sort((a, b) => timestampMs(a.timestamp) - timestampMs(b.timestamp));
  let latestGap = null;
  for (let index = 1; index < valid.length; index += 1) {
    const prevMs = timestampMs(valid[index - 1].timestamp);
    const nextMs = timestampMs(valid[index].timestamp);
    const gapMs = nextMs - prevMs;
    if (gapMs > WINDOW_MINUTES * 60 * 1000) {
      latestGap = {
        timestamp: valid[index].timestamp,
        type: "token sample gap",
        level: "watch",
        info: `${formatDuration(gapMs)} without token samples`,
        impact: "diagnosis before and after this turn can differ",
      };
    }
  }
  return latestGap;
}

function buildRepeatedWork(parsed) {
  const groups = new Map();

  for (const exec of parsed.execEnds) {
    if (exec.is_doctor) {
      continue;
    }
    const key = repeatedKey(exec);
    if (!key) {
      continue;
    }

    if (!groups.has(key.key)) {
      groups.set(key.key, {
        work: key.label,
        count: 0,
        duration_ms: 0,
        estimated_tokens: 0,
        failures: 0,
        suggestion: key.suggestion,
      });
    }
    const group = groups.get(key.key);
    group.count += 1;
    group.duration_ms += exec.duration_ms;
    group.estimated_tokens += Math.round(exec.output_len / 4);
    if (exec.exit_code !== 0) {
      group.failures += 1;
    }
  }

  return Array.from(groups.values())
    .filter((group) => group.count > 1 || group.failures > 1)
    .sort((a, b) => (b.estimated_tokens - a.estimated_tokens) || (b.duration_ms - a.duration_ms))
    .slice(0, MAX_ROWS);
}

function scoreRisk(input) {
  let score = 0;
  const reasons = [];
  const ctx = input.usage.context_percent;

  if (ctx !== null && ctx >= 85) {
    score += 3;
    reasons.push("context high");
  } else if (ctx !== null && ctx >= 70) {
    score += 2;
    reasons.push("context rising");
  } else if (ctx !== null && ctx >= 50) {
    score += 1;
    reasons.push("context watch");
  }

  if (input.context.growth_tokens > 50000) {
    score += 2;
    reasons.push("fast context growth");
  } else if (input.context.growth_tokens > 20000) {
    score += 1;
    reasons.push("context growth");
  }

  if (input.repeated.length > 0) {
    score += 1;
    reasons.push("repeated work");
  }

  const failures = input.slowTools.filter((tool) => tool.exit_code !== 0).length;
  if (failures >= 3) {
    score += 2;
    reasons.push("tool failures");
  } else if (failures > 0) {
    score += 1;
    reasons.push("tool failure");
  }

  if (input.activity.state === "running" && input.activity.elapsed_ms > 120000) {
    score += 2;
    reasons.push("long running tool");
  }

  const status = score >= 5 ? "critical" : score >= 3 ? "warning" : score >= 1 ? "watch" : "healthy";
  return { status, reasons };
}

function buildAdvice(input) {
  const advice = [];

  if (input.activity.state === "running" && input.activity.elapsed_ms > 120000) {
    advice.push(`Current tool has been running ${formatDuration(input.activity.elapsed_ms)}; verify whether it is expected before retrying.`);
  }

  const topContext = input.context.sources[0];
  if (topContext && /shell|long/.test(topContext.source)) {
    advice.push("Filter large shell output before reading it back into the session.");
  } else if (topContext && /file/.test(topContext.source)) {
    advice.push("Avoid re-reading full files; use targeted grep or line ranges.");
  }

  const topRepeat = input.repeated[0];
  if (topRepeat) {
    advice.push(`${topRepeat.suggestion}: ${topRepeat.work}.`);
  }

  if (input.usage.context_percent !== null && input.usage.context_percent >= 70) {
    advice.push("Compact after the current verification checkpoint.");
  }

  if (advice.length === 0) {
    advice.push("Continue; no major context or tool-loop risk detected.");
  }

  return unique(advice).slice(0, 3);
}

function printFull(diagnosis) {
  const color = makeColor();
  const target = diagnosis.target;
  const usage = diagnosis.usage;
  const status = formatStatusBadge(diagnosis.status, color);
  const reasonText = diagnosis.reasons && diagnosis.reasons.length > 0
    ? color.dim(`  ${diagnosis.reasons.join(" · ")}`)
    : "";

  console.log(`${color.bold("Codex Doctor")} ${status}${reasonText}`);
  console.log(color.dim(formatSourceLine()));
  console.log("");
  printContextMeter(diagnosis, color);
  console.log("");

  console.log(color.bold("Health Signals"));
  printTable([
    ["signal", "level", "detail"],
    ...buildSignals(diagnosis).map((signal) => [
      signal.name,
      formatSeverityBadge(signal.level, color),
      signal.detail,
    ]),
  ]);
  console.log("");

  console.log(color.bold("Context Growth"));
  const compactText = diagnosis.context.compacted ? " · after compact" : "";
  const sampleText = diagnosis.context.sample_start && diagnosis.context.sample_end
    ? ` · sample ${formatShortDateTime(diagnosis.context.sample_start)} -> ${formatShortDateTime(diagnosis.context.sample_end)}`
    : "";
  console.log(color.dim(`last ${diagnosis.context.window_minutes}m${compactText}${sampleText} · observed delta +${formatTokens(diagnosis.context.growth_tokens)} tokens · attributed input ${formatTokens(diagnosis.context.attributed_tokens || 0)} tokens`));
  if (diagnosis.context.sources.length === 0) {
    console.log("none detected");
  } else {
    printTable([
      ["source", "est.tokens ↓", "share", "evidence"],
      ...diagnosis.context.sources.map((item) => [
        item.source,
        `+${formatTokens(item.tokens)}`,
        renderShare(item.share, color),
        truncate(item.evidence || "-", 56),
      ]),
    ]);
  }
  console.log("");

  console.log(color.bold("Key Events"));
  if (diagnosis.keyEvents.length === 0) {
    console.log("none detected");
  } else {
    printTable([
      ["time", "event", "key info", "impact"],
      ...diagnosis.keyEvents.map((event) => [
        formatShortDateTime(event.timestamp),
        colorSeverity(event.level || "watch", event.type, color),
        truncate(event.info || "-", 48),
        truncate(event.impact || "-", 58),
      ]),
    ]);
  }
  console.log("");

  console.log(color.bold("Repeated Work"));
  if (diagnosis.repeated.length === 0) {
    console.log("none detected");
  } else {
    printTable([
      ["work", "count", "time", "est.tokens ↓", "suggestion"],
      ...diagnosis.repeated.map((item) => [
        truncate(item.work, 34),
        colorSeverity(item.count >= 4 ? "warning" : "watch", `x${item.count}`, color),
        formatDuration(item.duration_ms),
        formatTokens(item.estimated_tokens),
        item.suggestion,
      ]),
    ]);
  }
  console.log("");

  console.log(color.bold("Slow Tools"));
  if (diagnosis.slowTools.length === 0) {
    console.log("none detected");
  } else {
    printTable([
      ["tool", "time ↓", "status", "note"],
      ...diagnosis.slowTools.map((item) => [
        truncate(item.label, 34),
        colorSeverity(item.duration_ms > 120000 ? "warning" : item.duration_ms > 30000 ? "watch" : "healthy", formatDuration(item.duration_ms), color),
        formatToolStatus(item, color),
        truncate(item.note, 46),
      ]),
    ]);
  }
  console.log("");

  console.log(color.bold("Next Actions"));
  diagnosis.advice.forEach((item, index) => {
    console.log(`${index + 1}. ${item}`);
  });
}

function printCompact(diagnosis) {
  const color = makeColor();
  const target = diagnosis.target;
  const usage = diagnosis.usage;
  const project = target.cwd ? path.basename(target.cwd) : "unknown-cwd";
  const status = formatStatusBadge(diagnosis.status, color);
  const topContext = diagnosis.context.sources[0];
  const topRepeat = diagnosis.repeated[0];
  const slow = diagnosis.slowTools[0];

  console.log(`${color.bold("Codex Doctor")} ${status}`);
  console.log(color.dim(formatSourceLine()));
  console.log(`${renderMeter(usage.context_percent, 24, color)}  ${formatContextUsage(usage)}  ${target.model || "unknown"} ${project}`);
  console.log(`usage: ${formatUsageBits(usage)}`);
  console.log(`activity: ${formatActivity(diagnosis.activity, color)}`);
  console.log(`context: delta +${formatTokens(diagnosis.context.growth_tokens)} / ${diagnosis.context.window_minutes}m${diagnosis.context.compacted ? " after compact" : ""}, sample ${formatShortDateTime(diagnosis.context.sample_end)}, attributed ${formatTokens(diagnosis.context.attributed_tokens || 0)}${topContext ? `, top ${topContext.source} ${formatPercent(topContext.share * 100)}` : ""}`);
  console.log(`repeat: ${topRepeat ? `${topRepeat.work} x${topRepeat.count}, ${formatDuration(topRepeat.duration_ms)}, ~${formatTokens(topRepeat.estimated_tokens)} tokens` : "none"}`);
  console.log(`slowest: ${slow ? `${slow.label}, ${formatDuration(slow.duration_ms)}, ${toolStatusText(slow)}` : "none"}`);
  console.log(`advice: ${diagnosis.advice[0]}`);
}

function printContextMeter(diagnosis, color) {
  const usage = diagnosis.usage;
  const target = diagnosis.target;
  const model = [target.model || "unknown-model", target.reasoning_effort || ""].filter(Boolean).join(" ");
  const project = target.cwd ? path.basename(target.cwd) : "unknown-cwd";

  console.log(color.bold("Context Usage"));
  console.log(`  ${renderMeter(usage.context_percent, 32, color)}  ${model}`);
  console.log(`  ${formatContextUsage(usage, color)} · session ${formatTokens(usage.total_tokens)} tokens`);
  console.log(`  ${shortId(target.id)} · ${project} · started ${formatShortDateTime(target.created_at)} · runtime ${formatSessionRuntime(target)} · updated ${formatShortDateTime(target.updated_at)} · activity ${formatActivity(diagnosis.activity, color)}`);
}

function buildSignals(diagnosis) {
  const usage = diagnosis.usage;
  const contextPressure = Math.max(diagnosis.context.growth_tokens, diagnosis.context.attributed_tokens || 0);
  const failedTools = diagnosis.slowTools.filter((tool) => tool.exit_code !== 0).length;
  const slowest = diagnosis.slowTools[0] || null;
  const topContext = diagnosis.context.sources[0] || null;
  const topRepeat = diagnosis.repeated[0] || null;

  return [
    {
      name: "context",
      level: severityForContext(usage.context_percent),
      detail: `${formatContextUsage(usage)}${usage.context_percent !== null && usage.context_window ? ` · free ${formatTokens(Math.max(0, usage.context_window - usage.context_input_tokens))}` : ""}`,
    },
    {
      name: "activity",
      level: severityForActivity(diagnosis.activity),
      detail: diagnosis.activity.state === "running"
        ? `${formatDuration(diagnosis.activity.elapsed_ms)} · ${diagnosis.activity.label}`
        : "idle",
    },
    {
      name: "growth",
      level: contextPressure > 50000 ? "warning" : contextPressure > 20000 ? "watch" : "healthy",
      detail: `delta +${formatTokens(diagnosis.context.growth_tokens)} · attributed ${formatTokens(diagnosis.context.attributed_tokens || 0)}${topContext ? ` · top ${topContext.source} ${formatPercent(topContext.share * 100)}` : ""}`,
    },
    {
      name: "repeat",
      level: diagnosis.repeated.length >= 4 ? "warning" : diagnosis.repeated.length > 0 ? "watch" : "healthy",
      detail: topRepeat ? `${topRepeat.work} x${topRepeat.count}, ${formatDuration(topRepeat.duration_ms)}, ~${formatTokens(topRepeat.estimated_tokens)} tokens` : "none",
    },
    {
      name: "tools",
      level: failedTools >= 3 ? "warning" : failedTools > 0 || (slowest && slowest.duration_ms > 120000) ? "watch" : "healthy",
      detail: slowest ? `${slowest.label} · ${formatDuration(slowest.duration_ms)} · ${toolStatusText(slowest)}` : "none",
    },
  ];
}

function formatActivity(activity, color) {
  if (activity.state !== "running") {
    return colorSeverity("healthy", "idle", color);
  }
  const text = `${formatDuration(activity.elapsed_ms)} · ${activity.label}`;
  return colorSeverity(severityForActivity(activity), text, color);
}

function formatContextUsage(usage, color) {
  if (usage.context_percent === null) {
    return color ? colorSeverity("unknown", "context unknown", color) : "context unknown";
  }
  const text = usage.context_window
    ? `${formatTokens(usage.context_input_tokens)}/${formatTokens(usage.context_window)} tokens (${usage.context_percent}%)`
    : `${usage.context_percent}%`;
  return color ? colorSeverity(severityForContext(usage.context_percent), text, color) : text;
}

function renderShare(share, color) {
  return `${renderMeter(share * 100, 10, color)} ${formatPercent(share * 100)}`;
}

function renderMeter(percent, width, color) {
  if (percent === null || percent === undefined || Number.isNaN(Number(percent))) {
    return Array.from({ length: width }, () => color.dim("▱")).join(" ");
  }
  const value = Math.max(0, Math.min(100, Number(percent)));
  const filled = Math.round((value / 100) * width);
  const level = severityForContext(value);
  const parts = [];
  for (let index = 0; index < width; index += 1) {
    parts.push(index < filled ? colorSeverity(level, "▰", color) : color.dim("▱"));
  }
  return parts.join(" ");
}

function formatToolStatus(item, color) {
  if (item.exit_code === 0) {
    return colorSeverity("healthy", "ok", color);
  }
  return colorSeverity("critical", toolStatusText(item), color);
}

function toolStatusText(item) {
  if (item.exit_code === 0) {
    return "ok";
  }
  if (item.exit_code === null || item.exit_code < 0) {
    return "tool failed";
  }
  return `failed(${item.exit_code})`;
}

function severityForContext(percent) {
  if (percent === null || percent === undefined) {
    return "unknown";
  }
  if (percent >= 85) {
    return "critical";
  }
  if (percent >= 70) {
    return "warning";
  }
  if (percent >= 50) {
    return "watch";
  }
  return "healthy";
}

function severityForActivity(activity) {
  if (activity.state !== "running") {
    return "healthy";
  }
  if (activity.elapsed_ms > 300000) {
    return "critical";
  }
  if (activity.elapsed_ms > 120000) {
    return "warning";
  }
  return "watch";
}

function colorSeverity(level, text, color) {
  if (level === "unknown") {
    return color.dim(text);
  }
  return color.status(level, text);
}

function formatStatusBadge(level, color) {
  return formatSeverityBadge(level, color, `[${level}]`);
}

function formatSeverityBadge(level, color, label) {
  const normalized = level || "unknown";
  const glyphs = {
    healthy: "🟢",
    watch: "🔵",
    warning: "🟡",
    critical: "🔴",
    unknown: "⚪",
  };
  const text = label || normalized.toUpperCase();
  return `${glyphs[normalized] || glyphs.unknown} ${colorSeverity(normalized, text, color)}`;
}

function formatUsageBits(usage) {
  const bits = [];
  if (usage.context_percent !== null) {
    bits.push(`ctx ${usage.context_percent}%`);
  }
  if (usage.total_tokens) {
    bits.push(`session ${formatTokens(usage.total_tokens)} tokens`);
  }
  return bits.join(" | ") || "usage unavailable";
}

function summarizeImportantPayload(type, payload) {
  if (type === "turn_aborted") {
    return payload.reason ? `reason ${payload.reason}` : "turn interrupted";
  }
  if (type === "thread_rolled_back") {
    return payload.reason ? `reason ${payload.reason}` : "thread rolled back";
  }
  if (type === "error") {
    return payload.message || payload.error || payload.code || "runtime error";
  }
  if (type === "patch_apply_end") {
    return payload.stderr || payload.stdout || "patch failed";
  }
  if (type === "mcp_tool_call_end") {
    return payload.tool_name || payload.server_name || payload.status || "mcp tool call";
  }
  if (/^collab_/.test(String(type || ""))) {
    return payload.agent_id || payload.target || payload.status || "collaboration state changed";
  }
  return payload.status || payload.reason || type;
}

function formatEventType(type) {
  return String(type || "event").replace(/_/g, " ");
}

function levelForEventType(type) {
  if (type === "error") {
    return "critical";
  }
  if (type === "turn_aborted" || type === "thread_rolled_back" || type === "patch_apply_end") {
    return "warning";
  }
  if (type === "mcp_tool_call_end") {
    return "watch";
  }
  return "watch";
}

function impactForEventType(type) {
  if (type === "turn_aborted") {
    return "turn was interrupted; partial work may be stale";
  }
  if (type === "thread_rolled_back") {
    return "conversation state was reverted";
  }
  if (type === "error") {
    return "runtime error may have affected the turn";
  }
  if (type === "patch_apply_end") {
    return "patch was not applied";
  }
  if (type === "mcp_tool_call_end") {
    return "external tool result may need verification";
  }
  if (/^collab_/.test(String(type || ""))) {
    return "subagent or collaboration state changed";
  }
  return "session state changed";
}

function normalizeFunctionCall(entry) {
  const payload = entry.payload || {};
  const args = safeJsonParse(payload.arguments) || {};
  return {
    timestamp: entry.timestamp,
    name: payload.name || "tool",
    call_id: payload.call_id || "",
    arguments: args,
    command: args.cmd || "",
  };
}

function normalizeExecEnd(entry) {
  const payload = entry.payload || {};
  const parsed = Array.isArray(payload.parsed_cmd) ? payload.parsed_cmd : [];
  const cmd = Array.isArray(payload.command) && payload.command.length > 0
    ? payload.command[payload.command.length - 1]
    : (parsed[0] && parsed[0].cmd || "");
  return {
    timestamp: entry.timestamp,
    call_id: payload.call_id || "",
    command: cmd,
    parsed_cmd: parsed,
    exit_code: typeof payload.exit_code === "number" ? payload.exit_code : null,
    status: payload.status || "",
    duration_ms: durationToMs(payload.duration),
    output_len: (payload.aggregated_output || "").length,
    is_doctor: isDoctorCommand(cmd),
    label: summarizeCommand(cmd, parsed),
    note: noteForCommand(cmd, parsed),
  };
}

function normalizeTokenSample(entry) {
  const info = get(entry, "payload.info") || null;
  const inputTokens = get(info, "last_token_usage.input_tokens");
  return {
    timestamp: entry.timestamp,
    info,
    input_tokens: Number.isFinite(inputTokens) ? inputTokens : null,
  };
}

function classifyExecForContext(exec) {
  const first = exec.parsed_cmd[0] || {};
  if (first.type === "read") {
    return { source: "file reads", evidence: displayPath(first.path || first.name || exec.command) };
  }
  if (first.type === "search") {
    return { source: "search output", evidence: first.query ? `search ${truncate(first.query, 34)}` : exec.label };
  }
  if (exec.output_len > 8000) {
    return { source: "long shell output", evidence: exec.label };
  }
  if (first.type === "list_files") {
    return { source: "file listings", evidence: exec.label };
  }
  if (exec.output_len > 0) {
    return { source: "shell output", evidence: exec.label };
  }
  return { source: "tool results", evidence: exec.label };
}

function repeatedKey(exec) {
  const first = exec.parsed_cmd[0] || {};
  if (first.type === "read") {
    return {
      key: `read:${first.path || first.name}`,
      label: `read ${displayPath(first.path || first.name || "file")}`,
      suggestion: "Use targeted grep or a narrower line range",
    };
  }
  if (first.type === "search") {
    return {
      key: `search:${first.query || exec.command}:${first.path || ""}`,
      label: `search ${truncate(first.query || exec.command, 36)}`,
      suggestion: "Reuse previous search result",
    };
  }
  if (exec.exit_code !== 0) {
    return {
      key: `failed:${normalizeCommand(exec.command)}`,
      label: `failed ${truncate(exec.command, 42)}`,
      suggestion: "Stop retrying the same failing command",
    };
  }
  return {
    key: `cmd:${normalizeCommand(exec.command)}`,
    label: truncate(exec.command, 48),
    suggestion: "Cache or reuse the command output",
  };
}

function summarizeCall(call) {
  if (call.name === "exec_command") {
    return truncate(call.command || "exec_command", 80);
  }
  if (call.name === "write_stdin") {
    return `write_stdin session ${call.arguments.session_id || ""}`.trim();
  }
  return call.name;
}

function summarizeCommand(cmd, parsed) {
  const first = parsed[0] || {};
  if (first.type === "read") {
    return `read ${displayPath(first.path || first.name || cmd)}`;
  }
  if (first.type === "search") {
    return `search ${truncate(first.query || cmd, 42)}`;
  }
  if (first.type === "list_files") {
    return `list ${displayPath(first.path || cmd)}`;
  }
  return truncate(cmd, 80);
}

function noteForCommand(cmd, parsed) {
  const first = parsed[0] || {};
  if (first.type && first.type !== "unknown") {
    return first.type;
  }
  if (/brew install/.test(cmd)) {
    return "Homebrew install/download";
  }
  if (/npm install/.test(cmd)) {
    return "npm install";
  }
  if (/codexbar usage/.test(cmd)) {
    return "provider usage fetch";
  }
  if (/ccusage-codex/.test(cmd)) {
    return "local usage scan";
  }
  return "shell command";
}

function addBucket(buckets, source, tokens, evidence) {
  if (!buckets.has(source)) {
    buckets.set(source, { tokens: 0, evidence: [] });
  }
  const bucket = buckets.get(source);
  bucket.tokens += Number.isFinite(tokens) ? tokens : 0;
  if (evidence && !bucket.evidence.includes(evidence)) {
    bucket.evidence.push(evidence);
  }
}

function estimateTokensFromLength(length) {
  const value = Number(length);
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(value / 4)) : 0;
}

function estimateTokensFromText(value) {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "string") {
    return Math.round(value.length / 4);
  }
  try {
    return Math.round(JSON.stringify(value).length / 4);
  } catch {
    return Math.round(String(value).length / 4);
  }
}

function loadJsonl(file) {
  if (!file || !fs.existsSync(file)) {
    throw new Error(`rollout file not found: ${file || "(empty)"}`);
  }
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => safeJsonParse(line))
    .filter(Boolean);
}

function walk(dir, callback) {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      walk(file, callback);
    } else {
      callback(file);
    }
  }
}

function printTable(rows) {
  if (!rows || rows.length === 0) {
    return;
  }
  const color = makeColor();
  const printableRows = rows.map((row, rowIndex) => {
    return row.map((cell) => {
      const text = String(cell || "");
      return rowIndex === 0 ? color.bold(text) : text;
    });
  });
  const widths = rows[0].map((_, column) => {
    return Math.min(72, Math.max(...printableRows.map((row) => visibleLength(String(row[column] || "")))));
  });

  const top = `┌${widths.map((width) => "─".repeat(width + 2)).join("┬")}┐`;
  const separator = `├${widths.map((width) => "─".repeat(width + 2)).join("┼")}┤`;
  const bottom = `└${widths.map((width) => "─".repeat(width + 2)).join("┴")}┘`;

  console.log(top);
  printableRows.forEach((row, rowIndex) => {
    console.log(`│ ${row.map((cell, index) => padRight(fitCell(String(cell || ""), widths[index]), widths[index])).join(" │ ")} │`);
    if (rowIndex === 0 && printableRows.length > 1) {
      console.log(separator);
    }
  });
  console.log(bottom);
}

function makeColor() {
  const forced = process.env.CODEX_DOCTOR_COLOR === "1" || process.env.FORCE_COLOR === "1" || process.env.CLICOLOR_FORCE === "1";
  const enabled = !process.env.NO_COLOR && (process.stdout.isTTY || forced);
  const wrap = (code, text) => enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
  return {
    bold: (text) => wrap("1", text),
    dim: (text) => wrap("2", text),
    status: (status, text) => {
      if (status === "healthy") return wrap("32;1", text);
      if (status === "watch") return wrap("36;1", text);
      if (status === "warning") return wrap("33;1", text);
      if (status === "critical") return wrap("31;1", text);
      if (status === "unknown") return wrap("2", text);
      return text;
    },
  };
}

function loadPackageInfo() {
  const fallback = { name: "codex-doctor", version: "0.0.0" };
  const packagePath = path.resolve(__dirname, "..", "package.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    return {
      name: parsed.name || fallback.name,
      version: parsed.version || fallback.version,
    };
  } catch {
    return fallback;
  }
}

function detectSourceKind() {
  const scriptPath = path.resolve(__filename).replace(/\\/g, "/");
  if (scriptPath.includes("/.codex/plugins/cache/")) {
    return "plugin bundle";
  }
  if (scriptPath.includes("/node_modules/")) {
    return "npm package";
  }
  return "local checkout";
}

function formatSourceLine() {
  return `source: ${PACKAGE_INFO.name}@${PACKAGE_INFO.version} · ${detectSourceKind()}`;
}

function printSourceCheck() {
  console.log(`${PACKAGE_INFO.name} ${PACKAGE_INFO.version}`);
  console.log(`source: ${detectSourceKind()}`);
  console.log("entry: scripts/codex-doctor.js");
}

function printUsage() {
  console.log("Usage:");
  console.log("  codex-doctor dg");
  console.log("  codex-doctor dg -c");
  console.log("  codex-doctor --source");
  console.log("  codex-doctor --version");
}

function get(value, dottedPath) {
  if (!value || !dottedPath) {
    return undefined;
  }
  return dottedPath.split(".").reduce((current, key) => {
    return current && Object.prototype.hasOwnProperty.call(current, key) ? current[key] : undefined;
  }, value);
}

function safeJsonParse(value) {
  try {
    return typeof value === "string" ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function durationToMs(duration) {
  if (!duration) {
    return 0;
  }
  return (Number(duration.secs) || 0) * 1000 + Math.round((Number(duration.nanos) || 0) / 1000000);
}

function timestampMs(value) {
  return coerceTimeMs(value);
}

function formatDuration(ms) {
  if (!ms) {
    return "0s";
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes ? `${hours}h${minutes}m` : `${hours}h`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m${rest}s` : `${minutes}m`;
}

function formatTokens(value) {
  const n = Math.round(Number(value) || 0);
  if (n >= 1000000) {
    return `${trimNumber(n / 1000000)}M`;
  }
  if (n >= 1000) {
    return `${trimNumber(n / 1000)}k`;
  }
  return String(n);
}

function formatSignedTokens(value) {
  const n = Math.round(Number(value) || 0);
  if (n === 0) {
    return "0";
  }
  return `${n > 0 ? "+" : "-"}${formatTokens(Math.abs(n))}`;
}

function formatRelativeOffset(ms) {
  const n = Math.round(Number(ms) || 0);
  if (n === 0) {
    return "0s";
  }
  return `${n > 0 ? "+" : "-"}${formatDuration(Math.abs(n))}`;
}

function trimNumber(value) {
  return value >= 10 ? value.toFixed(1).replace(/\.0$/, "") : value.toFixed(2).replace(/0$/, "").replace(/\.0$/, "");
}

function formatPercent(value) {
  return `${Math.round(value)}%`;
}

function formatSessionRuntime(target) {
  const start = coerceTimeMs(target.created_at);
  const end = coerceTimeMs(target.updated_at) || Date.now();
  if (!start || !end || end < start) {
    return "unknown";
  }
  return formatDuration(end - start);
}

function formatShortDateTime(value) {
  const ms = coerceTimeMs(value);
  if (!ms) {
    return "unknown";
  }
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const time = date.toTimeString().slice(0, 5);
  return `${month}-${day} ${time}`;
}

function coerceTimeMs(value) {
  if (!value) {
    return 0;
  }
  if (typeof value === "number") {
    return value < 100000000000 ? value * 1000 : value;
  }
  if (/^\d+$/.test(String(value))) {
    const numeric = Number(value);
    return numeric < 100000000000 ? numeric * 1000 : numeric;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function shortId(id) {
  return id ? `${id.slice(0, 8)}...` : "unknown";
}

function displayPath(value) {
  if (!value) {
    return "";
  }
  const home = os.homedir();
  const cwd = process.cwd();
  return String(value).replace(home, "~").replace(cwd, ".");
}

function truncate(value, limit) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

function normalizeCommand(cmd) {
  return String(cmd || "").replace(/\s+/g, " ").trim();
}

function normalizeThreadId(value) {
  return String(value || "").trim();
}

function isDoctorThread(thread) {
  return /\$doctor|codex-doctor/i.test(`${thread.title || ""} ${thread.first_user_message || ""}`);
}

function isDoctorCommand(command) {
  const text = normalizeCommand(command);
  return /(?:^|\s)(?:node\s+)?(?:\.\/)?scripts\/codex-doctor\.js(?:\s+dg)?(?:\s|$)/.test(text)
    || /codex-doctor(?:\/[^/\s]+)?\/scripts\/codex-doctor\.js/.test(text)
    || /(?:^|\s)codex-doctor\s+dg(?:\s|$)/.test(text);
}

function escapeSql(value) {
  return String(value || "").replace(/'/g, "''");
}

function unique(items) {
  return Array.from(new Set(items));
}

function visibleLength(value) {
  return stripAnsi(value).length;
}

function padRight(value, width) {
  const length = visibleLength(value);
  return length >= width ? value : value + " ".repeat(width - length);
}

function fitCell(value, width) {
  if (visibleLength(value) <= width) {
    return value;
  }
  return truncate(stripAnsi(value), width);
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-9;]*m/g, "");
}
