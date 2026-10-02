import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const COUNTER_FIELDS = {
  input: "promptTokensTotal",
  compute: "promptComputeTokensTotal",
  cache: "promptCacheTokensTotal",
  output: "generationTokensTotal",
  requests: "completedRequestsTotal",
};

function counter(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

// A counter the engine does not export stays null here, so it adds nothing instead of resetting to zero.
function reported(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

const lastColumn = (key) => (key === "requests" ? "last_requests" : `last_${key}_tokens`);
// last_seen_at is refreshed at least this often even while nothing changes, instead of on every poll.
const IDLE_TOUCH_MS = 15 * 60 * 1000;

function emptyTotals() {
  return { input: 0, compute: 0, cache: 0, output: 0, requests: 0, total: 0 };
}

function sumTotals(items) {
  const totals = items.reduce((sum, item) => ({
    input: sum.input + counter(item.input),
    compute: sum.compute + counter(item.compute),
    cache: sum.cache + counter(item.cache),
    output: sum.output + counter(item.output),
    requests: sum.requests + counter(item.requests),
  }), emptyTotals());
  totals.total = totals.input + totals.output;
  return totals;
}

function nextMonth(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new TypeError(`Invalid month: ${month}`);
  const [year, monthNumber] = month.split("-").map(Number);
  const next = new Date(Date.UTC(year, monthNumber, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
}

function totalsFromRow(row) {
  const totals = {
    input: counter(row?.input_tokens),
    compute: counter(row?.compute_tokens),
    cache: counter(row?.cache_tokens),
    output: counter(row?.output_tokens),
    requests: counter(row?.requests),
  };
  return { ...totals, total: totals.input + totals.output };
}

function dayInTimeZone(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

// The engine run a counter belongs to. vLLM reports its process start time; SGLang does not, so its runs share
// this key and a restart is recognised by counters going down (record() then starts "<key>#<time>").
function sessionKey(vllm) {
  const modelName = vllm?.modelName || "unknown-model";
  const processStartedAt = vllm?.processStartedAt || "unknown-process";
  return `${processStartedAt}|${modelName}`;
}

function likePrefix(value) {
  return `${value.replace(/[\\%_]/g, "\\$&")}#%`;
}

export class UsageStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    // Daily rows are keyed by the calendar day in this time zone (default: the server's own).
    this.timeZone = options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    // A short busy timeout: a locked ledger skips one write instead of stalling the poll loop for seconds.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 250;");
    this.lastReported = null;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_sessions (
        session_id TEXT PRIMARY KEY,
        model_name TEXT NOT NULL,
        process_started_at TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_input_tokens INTEGER NOT NULL,
        last_compute_tokens INTEGER NOT NULL,
        last_cache_tokens INTEGER NOT NULL,
        last_output_tokens INTEGER NOT NULL,
        last_requests INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_daily (
        day TEXT NOT NULL,
        session_id TEXT NOT NULL,
        model_name TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        compute_tokens INTEGER NOT NULL DEFAULT 0,
        cache_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (day, session_id)
      );
      CREATE INDEX IF NOT EXISTS usage_daily_model_idx ON usage_daily(model_name);
      CREATE INDEX IF NOT EXISTS usage_daily_day_idx ON usage_daily(day);
    `);
    this.latestSession = this.db.prepare(`
      SELECT * FROM usage_sessions WHERE session_id = ? OR session_id LIKE ? ESCAPE '\\'
      ORDER BY last_seen_at DESC LIMIT 1
    `);
    this.countSessions = this.db.prepare("SELECT COUNT(*) count FROM usage_sessions");
    this.insertSession = this.db.prepare(`
      INSERT INTO usage_sessions (
        session_id, model_name, process_started_at, first_seen_at, last_seen_at,
        last_input_tokens, last_compute_tokens, last_cache_tokens, last_output_tokens, last_requests
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateSession = this.db.prepare(`
      UPDATE usage_sessions SET
        model_name = ?, process_started_at = ?, last_seen_at = ?,
        last_input_tokens = ?, last_compute_tokens = ?, last_cache_tokens = ?,
        last_output_tokens = ?, last_requests = ?
      WHERE session_id = ?
    `);
    this.upsertDaily = this.db.prepare(`
      INSERT INTO usage_daily (
        day, session_id, model_name, input_tokens, compute_tokens, cache_tokens,
        output_tokens, requests, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, session_id) DO UPDATE SET
        model_name = excluded.model_name,
        input_tokens = input_tokens + excluded.input_tokens,
        compute_tokens = compute_tokens + excluded.compute_tokens,
        cache_tokens = cache_tokens + excluded.cache_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        requests = requests + excluded.requests,
        updated_at = excluded.updated_at
    `);
    this.sumToday = this.db.prepare(`
      SELECT SUM(input_tokens) input_tokens, SUM(compute_tokens) compute_tokens,
        SUM(cache_tokens) cache_tokens, SUM(output_tokens) output_tokens, SUM(requests) requests
      FROM usage_daily WHERE day = ?
    `);
    this.sumSession = this.db.prepare(`
      SELECT SUM(input_tokens) input_tokens, SUM(compute_tokens) compute_tokens,
        SUM(cache_tokens) cache_tokens, SUM(output_tokens) output_tokens, SUM(requests) requests
      FROM usage_daily WHERE session_id = ?
    `);
    this.sumAll = this.db.prepare(`
      SELECT SUM(input_tokens) input_tokens, SUM(compute_tokens) compute_tokens,
        SUM(cache_tokens) cache_tokens, SUM(output_tokens) output_tokens, SUM(requests) requests
      FROM usage_daily
    `);
    this.recentDays = this.db.prepare(`
      SELECT day, SUM(input_tokens) input_tokens, SUM(compute_tokens) compute_tokens,
        SUM(cache_tokens) cache_tokens, SUM(output_tokens) output_tokens, SUM(requests) requests
      FROM usage_daily GROUP BY day ORDER BY day DESC LIMIT ?
    `);
    this.daysByMonth = this.db.prepare(`
      SELECT day, SUM(input_tokens) input_tokens, SUM(compute_tokens) compute_tokens,
        SUM(cache_tokens) cache_tokens, SUM(output_tokens) output_tokens, SUM(requests) requests
      FROM usage_daily
      WHERE day >= ? AND day < ?
      GROUP BY day ORDER BY day ASC
    `);
    this.dayBounds = this.db.prepare("SELECT MIN(day) first_day, MAX(day) last_day FROM usage_daily");
    this.byModel = this.db.prepare(`
      SELECT model_name, SUM(input_tokens) input_tokens, SUM(compute_tokens) compute_tokens,
        SUM(cache_tokens) cache_tokens, SUM(output_tokens) output_tokens, SUM(requests) requests
      FROM usage_daily GROUP BY model_name ORDER BY SUM(input_tokens + output_tokens) DESC LIMIT ?
    `);
  }

  record(vllm, timestamp = Date.now()) {
    if (!vllm?.ok || !vllm.modelName) return this.summary();
    const keys = Object.keys(COUNTER_FIELDS);
    const current = Object.fromEntries(keys.map((key) => [key, reported(vllm[COUNTER_FIELDS[key]])]));
    this.lastReported = Object.fromEntries(keys.map((key) => [key, current[key] !== null]));
    const base = sessionKey(vllm);
    let existing = this.latestSession.get(base, likePrefix(base)) ?? null;
    let id = existing?.session_id ?? base;
    // A counter below its last value means the engine restarted under the same key: a new run starts at zero.
    const restarted = existing && keys.some((key) => current[key] !== null && current[key] < counter(existing[lastColumn(key)]));
    if (restarted) {
      id = `${base}#${new Date(timestamp).toISOString()}`;
      existing = null;
    }
    // A brand-new ledger only takes a baseline: what the engine served before this dashboard ran is not booked to today.
    // A later new run (restart, model switch, or one that started while the dashboard was down) counts from its start.
    const baselineOnly = !existing && !restarted && this.countSessions.get().count === 0;
    const delta = Object.fromEntries(keys.map((key) => {
      if (current[key] === null || baselineOnly) return [key, 0];
      return [key, Math.max(0, current[key] - (existing ? counter(existing[lastColumn(key)]) : 0))];
    }));
    const last = Object.fromEntries(keys.map((key) => [key, current[key] ?? (existing ? counter(existing[lastColumn(key)]) : 0)]));
    const changed = Object.values(delta).some((value) => value > 0);
    const collectedAt = new Date(timestamp).toISOString();
    const day = dayInTimeZone(timestamp, this.timeZone);
    // Nothing new to book: leave the database alone (fewer writes on an SD card), apart from an occasional touch.
    if (existing && !changed && keys.every((key) => last[key] === counter(existing[lastColumn(key)]))
      && existing.model_name === vllm.modelName && (existing.process_started_at ?? null) === (vllm.processStartedAt ?? null)
      && timestamp - Date.parse(existing.last_seen_at) < IDLE_TOUCH_MS) {
      return this.summary(id, vllm.modelName, vllm.processStartedAt, timestamp);
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (existing) {
        this.updateSession.run(
          vllm.modelName,
          vllm.processStartedAt ?? null,
          collectedAt,
          last.input,
          last.compute,
          last.cache,
          last.output,
          last.requests,
          id,
        );
      } else {
        this.insertSession.run(
          id,
          vllm.modelName,
          vllm.processStartedAt ?? null,
          collectedAt,
          collectedAt,
          last.input,
          last.compute,
          last.cache,
          last.output,
          last.requests,
        );
      }
      if (changed) {
        this.upsertDaily.run(
          day,
          id,
          vllm.modelName,
          delta.input,
          delta.compute,
          delta.cache,
          delta.output,
          delta.requests,
          collectedAt,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.summary(id, vllm.modelName, vllm.processStartedAt, timestamp);
  }

  summary(id = null, modelName = null, processStartedAt = null, timestamp = Date.now()) {
    const day = dayInTimeZone(timestamp, this.timeZone);
    const recentDays = [...this.recentDays.all(14)].map((row) => ({ day: row.day, ...totalsFromRow(row) }));
    const models = [...this.byModel.all(10)].map((row) => ({ modelName: row.model_name, ...totalsFromRow(row) }));
    return {
      persistent: true,
      timeZone: this.timeZone,
      day,
      modelName,
      processStartedAt,
      // Which counters the engine exported in the last sample; the page shows the others as unknown.
      reported: this.lastReported,
      today: totalsFromRow(this.sumToday.get(day)) ?? emptyTotals(),
      session: id ? totalsFromRow(this.sumSession.get(id)) : emptyTotals(),
      allTime: totalsFromRow(this.sumAll.get()),
      recentDays,
      models,
      updatedAt: new Date(timestamp).toISOString(),
      error: null,
    };
  }

  month(month, timestamp = Date.now()) {
    const endMonth = nextMonth(month);
    const days = [...this.daysByMonth.all(`${month}-01`, `${endMonth}-01`)]
      .map((row) => ({ day: row.day, ...totalsFromRow(row) }));
    const bounds = this.dayBounds.get();
    return {
      persistent: true,
      timeZone: this.timeZone,
      month,
      day: dayInTimeZone(timestamp, this.timeZone),
      days,
      totals: sumTotals(days),
      reported: this.lastReported,
      firstMonth: bounds?.first_day?.slice(0, 7) ?? null,
      lastMonth: bounds?.last_day?.slice(0, 7) ?? null,
      updatedAt: new Date(timestamp).toISOString(),
      error: null,
    };
  }

  close() {
    this.db.close();
  }
}
