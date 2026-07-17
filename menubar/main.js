// src/main.ts
import { app, Tray, BrowserWindow, ipcMain, nativeImage, screen } from "electron";
import { fileURLToPath } from "node:url";
import * as fs7 from "node:fs";
import * as path5 from "node:path";

// ../dist/core/claude-scanner.js
import * as fs2 from "node:fs";
import * as path from "node:path";

// ../dist/config/defaults.js
var TIMING = {
  scanIntervalMs: 5e3,
  batchIntervalMs: 1e4,
  activeThresholdMs: 3e4,
  idleThresholdMs: 3e5,
  tailPollMs: 1e3,
  seedLines: 20,
  maxCommentaryLines: 200
};
var TRUNCATE = {
  /** User prompts and assistant text — carries intent and rationale. */
  prose: 600,
  /** Tool targets: file paths, commands, patterns. */
  target: 60,
  /** Shell command lines. */
  command: 80,
  /** One-line activity string for a session card / roster line. */
  activity: 80
};
var DEFAULT_PROVIDER = "claude-cli";
var DEFAULT_MODEL = "claude-haiku-4-5-20251001";
var CLAUDE_DIR = `${process.env["HOME"]}/.claude`;
var CODEX_DIR = `${process.env["HOME"]}/.codex`;
var PI_DIR = `${process.env["HOME"]}/.pi`;

// ../dist/utils/project-name.js
function extractProjectName(dirName) {
  const parts = dirName.replace(/^-/, "").split("-");
  return parts[parts.length - 1] || dirName;
}
function extractProjectNameFromCwd(cwd) {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

// ../dist/core/jsonl-prefix-reader.js
import * as fs from "node:fs";
function scanJsonlPrefix(jsonlPath, onLine, options) {
  const maxBytes = options?.maxBytes ?? 256 * 1024;
  const chunkBytes = options?.chunkBytes ?? 64 * 1024;
  const maxLines = options?.maxLines ?? 200;
  let fd = null;
  const buffer = Buffer.alloc(chunkBytes);
  let bytesReadTotal = 0;
  let linesRead = 0;
  let carry = "";
  try {
    fd = fs.openSync(jsonlPath, "r");
    while (bytesReadTotal < maxBytes && linesRead < maxLines) {
      const remaining = maxBytes - bytesReadTotal;
      const toRead = Math.min(chunkBytes, remaining);
      const bytesRead = fs.readSync(fd, buffer, 0, toRead, bytesReadTotal);
      if (bytesRead <= 0)
        break;
      bytesReadTotal += bytesRead;
      carry += buffer.subarray(0, bytesRead).toString("utf-8");
      let newline = carry.indexOf("\n");
      while (newline >= 0 && linesRead < maxLines) {
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        newline = carry.indexOf("\n");
        if (!line)
          continue;
        linesRead++;
        if (onLine(line) === true)
          return;
      }
    }
    const tail = carry.trimEnd();
    if (tail && linesRead < maxLines) {
      onLine(tail);
    }
  } catch {
  } finally {
    if (fd !== null)
      fs.closeSync(fd);
  }
}

// ../dist/core/claude-scanner.js
function scanClaudeSessions() {
  const results = [];
  const contextStates = readContextStates();
  const projectsDir = path.join(CLAUDE_DIR, "projects");
  if (!fs2.existsSync(projectsDir))
    return results;
  const projectDirs = fs2.readdirSync(projectsDir);
  for (const projDir of projectDirs) {
    const fullProjDir = path.join(projectsDir, projDir);
    let stat;
    try {
      stat = fs2.statSync(fullProjDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory())
      continue;
    let jsonlFiles;
    try {
      jsonlFiles = fs2.readdirSync(fullProjDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const jsonlFile of jsonlFiles) {
      const jsonlPath = path.join(fullProjDir, jsonlFile);
      const sessionId = jsonlFile.replace(".jsonl", "");
      let jsonlStat;
      try {
        jsonlStat = fs2.statSync(jsonlPath);
      } catch {
        continue;
      }
      const mtime = jsonlStat.mtimeMs;
      const age = Date.now() - mtime;
      if (age > TIMING.idleThresholdMs)
        continue;
      const contextState = contextStates.find((cs) => sessionId.startsWith(cs.session_id));
      const metadata = readSessionMetadata(jsonlPath);
      const status = age < TIMING.activeThresholdMs ? "active" : age < TIMING.idleThresholdMs ? "idle" : "ended";
      results.push({
        jsonlPath,
        session: {
          id: sessionId,
          source: "claude",
          projectName: extractProjectName(projDir),
          projectDir: fullProjDir,
          jsonlPath,
          cwd: metadata.cwd || fullProjDir,
          gitBranch: metadata.gitBranch || "unknown",
          slug: metadata.slug || sessionId.slice(0, 8),
          model: metadata.model || "unknown",
          version: metadata.version || "",
          usedPercent: contextState?.used_percent ?? 0,
          contextStatus: contextState?.status ?? "safe",
          status,
          lastEventTime: new Date(mtime),
          eventCount: 0,
          currentActivity: ""
        }
      });
    }
  }
  return results;
}
function readContextStates() {
  const states = [];
  let files;
  try {
    files = fs2.readdirSync(CLAUDE_DIR).filter((f) => f.startsWith("context_state_"));
  } catch {
    return states;
  }
  for (const file of files) {
    try {
      const raw = fs2.readFileSync(path.join(CLAUDE_DIR, file), "utf-8");
      const parsed = JSON.parse(raw);
      states.push(parsed);
    } catch {
    }
  }
  return states;
}
function readSessionMetadata(jsonlPath) {
  const meta = {};
  scanJsonlPrefix(jsonlPath, (line) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed.cwd && !meta.cwd)
        meta.cwd = parsed.cwd;
      if (parsed.gitBranch && !meta.gitBranch)
        meta.gitBranch = parsed.gitBranch;
      if (parsed.slug && !meta.slug)
        meta.slug = parsed.slug;
      if (parsed.version && !meta.version)
        meta.version = parsed.version;
      if (parsed.message?.model && !meta.model)
        meta.model = parsed.message.model;
      if (meta.cwd && meta.gitBranch && meta.slug && meta.model && meta.version) {
        return true;
      }
    } catch {
    }
    return false;
  }, { maxBytes: 512 * 1024, maxLines: 300 });
  return meta;
}

// ../dist/core/codex-scanner.js
import * as fs3 from "node:fs";
import * as path2 from "node:path";
function scanCodexSessions() {
  const results = [];
  const sessionsDir = path2.join(CODEX_DIR, "sessions");
  if (!fs3.existsSync(sessionsDir))
    return results;
  const now = /* @__PURE__ */ new Date();
  const dateDirs = [dateDir(now), dateDir(new Date(now.getTime() - 864e5))];
  for (const dateDir2 of dateDirs) {
    const fullDir = path2.join(sessionsDir, dateDir2);
    if (!fs3.existsSync(fullDir))
      continue;
    let files;
    try {
      files = fs3.readdirSync(fullDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const jsonlPath = path2.join(fullDir, file);
      let stat;
      try {
        stat = fs3.statSync(jsonlPath);
      } catch {
        continue;
      }
      const mtime = stat.mtimeMs;
      const age = Date.now() - mtime;
      if (age > TIMING.idleThresholdMs)
        continue;
      const metadata = readCodexSessionMeta(jsonlPath);
      const sessionId = metadata.id || file.replace(".jsonl", "");
      const status = age < TIMING.activeThresholdMs ? "active" : age < TIMING.idleThresholdMs ? "idle" : "ended";
      results.push({
        jsonlPath,
        session: {
          id: sessionId,
          source: "codex",
          projectName: metadata.projectName || "unknown",
          projectDir: metadata.cwd || fullDir,
          jsonlPath,
          cwd: metadata.cwd || "",
          gitBranch: metadata.gitBranch || "unknown",
          slug: sessionId.slice(0, 8),
          model: metadata.model || "unknown",
          version: metadata.cliVersion || "",
          usedPercent: 0,
          contextStatus: "safe",
          status,
          lastEventTime: new Date(mtime),
          eventCount: 0,
          currentActivity: ""
        }
      });
    }
  }
  return results;
}
function dateDir(d) {
  const y = d.getFullYear().toString();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return path2.join(y, m, day);
}
function readCodexSessionMeta(jsonlPath) {
  const meta = {};
  scanJsonlPrefix(jsonlPath, (line) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "session_meta" && parsed.payload) {
        const p = parsed.payload;
        meta.id = p.id;
        meta.cwd = p.cwd;
        meta.cliVersion = p.cli_version;
        if (p.git?.branch)
          meta.gitBranch = p.git.branch;
        if (p.cwd)
          meta.projectName = extractProjectNameFromCwd(p.cwd);
      }
      if (parsed.type === "turn_context" && parsed.payload?.model && !meta.model) {
        meta.model = parsed.payload.model;
      }
      if (meta.id && meta.cwd && meta.model && meta.gitBranch)
        return true;
    } catch {
    }
    return false;
  }, { maxBytes: 512 * 1024, maxLines: 400 });
  return meta;
}

// ../dist/core/pi-scanner.js
import * as fs4 from "node:fs";
import * as path3 from "node:path";
function scanPiSessions() {
  const results = [];
  const sessionsDir = path3.join(PI_DIR, "agent", "sessions");
  if (!fs4.existsSync(sessionsDir))
    return results;
  let projectDirs;
  try {
    projectDirs = fs4.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const projectDirEntry of projectDirs) {
    if (!projectDirEntry.isDirectory())
      continue;
    const projectDirName = projectDirEntry.name;
    const projectDirPath = path3.join(sessionsDir, projectDirName);
    let files;
    try {
      files = fs4.readdirSync(projectDirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const jsonlPath = path3.join(projectDirPath, file);
      let stat;
      try {
        stat = fs4.statSync(jsonlPath);
      } catch {
        continue;
      }
      const mtime = stat.mtimeMs;
      const age = Date.now() - mtime;
      if (age > TIMING.idleThresholdMs)
        continue;
      const metadata = readPiSessionMeta(jsonlPath);
      const sessionId = metadata.id || fallbackSessionId(file);
      const status = age < TIMING.activeThresholdMs ? "active" : age < TIMING.idleThresholdMs ? "idle" : "ended";
      const projectName = metadata.projectName || inferProjectNameFromDir(projectDirName);
      results.push({
        jsonlPath,
        session: {
          id: sessionId,
          source: "pi",
          projectName,
          projectDir: metadata.cwd || projectDirPath,
          jsonlPath,
          cwd: metadata.cwd || projectDirPath,
          gitBranch: "unknown",
          slug: sessionId.slice(0, 8),
          model: metadata.model || "unknown",
          version: metadata.version || "",
          usedPercent: 0,
          contextStatus: "safe",
          status,
          lastEventTime: new Date(mtime),
          eventCount: 0,
          currentActivity: ""
        }
      });
    }
  }
  return results;
}
function readPiSessionMeta(jsonlPath) {
  const meta = {};
  scanJsonlPrefix(jsonlPath, (line) => {
    try {
      const parsed = JSON.parse(line);
      const type = parsed["type"];
      if (type === "session") {
        if (typeof parsed["id"] === "string" && !meta.id) {
          meta.id = parsed["id"];
        }
        if (typeof parsed["cwd"] === "string" && !meta.cwd) {
          meta.cwd = parsed["cwd"];
          meta.projectName = extractProjectNameFromCwd(parsed["cwd"]);
        }
        if (parsed["version"] !== void 0 && !meta.version) {
          meta.version = String(parsed["version"]);
        }
      }
      if (type === "model_change" && typeof parsed["modelId"] === "string" && !meta.model) {
        meta.model = parsed["modelId"];
      }
      if (type === "message") {
        const message = parsed["message"];
        if (message && typeof message === "object") {
          const msg = message;
          if (typeof msg["model"] === "string" && !meta.model) {
            meta.model = msg["model"];
          }
        }
      }
      if (meta.id && meta.cwd && meta.model && meta.version) {
        return true;
      }
    } catch {
    }
    return false;
  }, { maxBytes: 512 * 1024, maxLines: 400 });
  return meta;
}
function fallbackSessionId(fileName) {
  const withoutExt = fileName.replace(/\.jsonl$/, "");
  const parts = withoutExt.split("_");
  return parts[parts.length - 1] || withoutExt;
}
function inferProjectNameFromDir(projectDirName) {
  const normalized = projectDirName.replace(/^--/, "").replace(/--$/, "");
  const parts = normalized.split("-").filter(Boolean);
  return parts[parts.length - 1] || projectDirName;
}

// ../dist/core/providers/claude-session.js
import { spawn } from "node:child_process";
import * as fs5 from "node:fs";
import * as os from "node:os";
import * as path4 from "node:path";
var OBSERVER_CWD = path4.join(os.tmpdir(), "aside-observer");
var OBSERVER_PROJECT_MARKER = "aside-observer";
var ANSWER_TIMEOUT_MS = 18e4;
var OVERRIDING_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
var ClaudeSession = class {
  child = null;
  buffer = "";
  pending = null;
  /** Serialises asks: each waits for the previous to settle. */
  tail = Promise.resolve();
  startedWith = null;
  /**
   * Ask a question, starting or reusing the session.
   *
   * `systemPrompt` is the observer's static role and is fixed when the process
   * starts. The volatile part — what the agents are doing right now — is
   * `context`, sent with each question, because it changes between turns and a
   * system prompt cannot be revised once the session is live.
   */
  ask(model, systemPrompt, context, question) {
    const run = () => this.askOne(model, systemPrompt, context, question);
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => void 0);
    return result;
  }
  async askOne(model, systemPrompt, context, question) {
    const changed = this.startedWith && (this.startedWith.model !== model || this.startedWith.systemPrompt !== systemPrompt);
    if (changed)
      this.dispose();
    const child = this.ensureStarted(model, systemPrompt);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.dispose();
        reject(new Error(`claude-cli: timed out after ${ANSWER_TIMEOUT_MS / 1e3}s.`));
      }, ANSWER_TIMEOUT_MS);
      this.pending = { resolve, reject, timer };
      const content = context ? `${context}

---

Question: ${question}` : question;
      try {
        child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}
`);
      } catch (err) {
        clearTimeout(timer);
        this.pending = null;
        reject(new Error(`claude-cli: could not write to the session (${String(err)})`));
      }
    });
  }
  ensureStarted(model, systemPrompt) {
    if (this.child && !this.child.killed)
      return this.child;
    fs5.mkdirSync(OBSERVER_CWD, { recursive: true });
    const env = { ...process.env };
    for (const key of OVERRIDING_VARS)
      delete env[key];
    let child;
    try {
      child = spawn("claude", [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        // stream-json output requires --verbose; without it the CLI refuses.
        "--verbose",
        // "" disables every built-in tool. Claude Code ships with Write/Edit/
        // Bash enabled — telling a model it has no tools is not the same as it
        // having none. This is what makes aside's read-only promise mechanical
        // rather than aspirational.
        "--tools",
        "",
        "--append-system-prompt",
        systemPrompt,
        "--model",
        model
      ], { cwd: OBSERVER_CWD, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      throw explain(err);
    }
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2e3);
    });
    child.on("error", (err) => this.fail(explain(err)));
    child.on("close", (code) => {
      this.child = null;
      this.startedWith = null;
      if (this.pending) {
        this.fail(explain(Object.assign(new Error(`exited with code ${code}`), {
          stderr,
          stdout: this.buffer
        })));
      }
      this.buffer = "";
    });
    this.child = child;
    this.startedWith = { model, systemPrompt };
    return child;
  }
  /** Parse newline-delimited JSON events; a `result` event completes an ask. */
  onStdout(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim())
        continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== "result")
        continue;
      const pending = this.pending;
      if (!pending)
        continue;
      this.pending = null;
      clearTimeout(pending.timer);
      const text = typeof event.result === "string" ? event.result.trim() : "";
      if (event.is_error) {
        pending.reject(new Error(`claude-cli: ${text || "the session reported an error"}`));
      } else {
        pending.resolve(text || "(no response)");
      }
    }
  }
  fail(err) {
    const pending = this.pending;
    if (!pending)
      return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(err);
  }
  /** Stop the session. The next ask starts a fresh one. */
  dispose() {
    this.child?.kill();
    this.child = null;
    this.startedWith = null;
    this.buffer = "";
  }
  /** True while a conversation is live. */
  get isRunning() {
    return this.child !== null && !this.child.killed;
  }
};
function explain(err) {
  const e = err;
  if (e.code === "ENOENT") {
    return new Error('claude-cli: the "claude" command was not found. Install Claude Code, or pick another provider (--provider ollama needs nothing). If aside was launched from Finder it may not have your PATH.');
  }
  const output = `${(e.stdout ?? "").trim()}
${(e.stderr ?? "").trim()}`.trim();
  if (/not logged in|please run\s*\/?login|authentication/i.test(output)) {
    return new Error('claude-cli: Claude Code is not logged in. Run "claude" in a terminal and sign in, then try again.');
  }
  return new Error(`claude-cli: ${output || e.message || "failed"}`.slice(0, 400));
}

// ../dist/core/providers/claude-cli.js
var session = new ClaudeSession();
var claudeCli = {
  id: "claude-cli",
  label: "Claude Code (your login, no API key)",
  apiKeyEnv: [],
  requiresApiKey: false,
  models: [
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", recommended: true },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" }
  ],
  complete({ model, systemPrompt, context, question }) {
    return session.ask(model, systemPrompt, context, question);
  }
};
function disposeClaudeSession() {
  session.dispose();
}

// ../dist/core/session-scanner.js
function scanAllSessions(filter) {
  const sessions = [];
  const jsonlPaths = /* @__PURE__ */ new Map();
  if (filter.source !== "codex" && filter.source !== "pi") {
    for (const { session: session2, jsonlPath } of scanClaudeSessions()) {
      if (matchesFilter(session2, filter)) {
        sessions.push(session2);
        jsonlPaths.set(session2.id, jsonlPath);
      }
    }
  }
  if (filter.source !== "claude" && filter.source !== "pi") {
    for (const { session: session2, jsonlPath } of scanCodexSessions()) {
      if (matchesFilter(session2, filter)) {
        sessions.push(session2);
        jsonlPaths.set(session2.id, jsonlPath);
      }
    }
  }
  if (filter.source !== "claude" && filter.source !== "codex") {
    for (const { session: session2, jsonlPath } of scanPiSessions()) {
      if (matchesFilter(session2, filter)) {
        sessions.push(session2);
        jsonlPaths.set(session2.id, jsonlPath);
      }
    }
  }
  sessions.sort((a, b) => {
    const statusOrder = { active: 0, idle: 1, ended: 2 };
    const statusDiff = statusOrder[a.status] - statusOrder[b.status];
    if (statusDiff !== 0)
      return statusDiff;
    return b.lastEventTime.getTime() - a.lastEventTime.getTime();
  });
  return { sessions, jsonlPaths };
}
function isObserverSession(session2) {
  return session2.projectDir.includes(OBSERVER_PROJECT_MARKER) || session2.cwd.includes(OBSERVER_PROJECT_MARKER) || session2.projectName.includes(OBSERVER_PROJECT_MARKER);
}
function matchesFilter(session2, filter) {
  if (isObserverSession(session2))
    return false;
  if (filter.projectName && session2.projectName !== filter.projectName) {
    return false;
  }
  if (filter.sessionIds && filter.sessionIds.length > 0) {
    const matches = filter.sessionIds.some((id) => session2.id.startsWith(id));
    if (!matches)
      return false;
  }
  if (filter.source && session2.source !== filter.source) {
    return false;
  }
  return true;
}

// ../dist/core/session-tailer.js
import * as fs6 from "node:fs";
import { EventEmitter } from "node:events";
var SessionTailer = class extends EventEmitter {
  watchers = /* @__PURE__ */ new Map();
  /**
   * Start tailing a session JSONL file.
   * Reads the last N lines on startup, then watches for new appends.
   */
  startTailing(sessionId, jsonlPath) {
    if (this.watchers.has(sessionId))
      return;
    let offset;
    try {
      const stat = fs6.statSync(jsonlPath);
      const seedBytes = Math.min(stat.size, 32768);
      offset = stat.size - seedBytes;
      if (seedBytes > 0) {
        const fd = fs6.openSync(jsonlPath, "r");
        const buf = Buffer.alloc(seedBytes);
        fs6.readSync(fd, buf, 0, seedBytes, offset);
        fs6.closeSync(fd);
        const text = buf.toString("utf-8");
        const firstNewline = offset > 0 ? text.indexOf("\n") + 1 : 0;
        const lines = text.slice(firstNewline).split("\n").filter(Boolean);
        const seedLines = lines.slice(-TIMING.seedLines);
        for (const line of seedLines) {
          this.emit("line", { sessionId, line, isSeed: true });
        }
      }
      offset = stat.size;
    } catch {
      offset = 0;
    }
    let watcher;
    try {
      watcher = fs6.watch(jsonlPath, () => {
        this.readNewLines(sessionId, jsonlPath);
      });
    } catch {
      watcher = null;
    }
    const pollTimer = setInterval(() => {
      this.readNewLines(sessionId, jsonlPath);
    }, TIMING.tailPollMs);
    this.watchers.set(sessionId, { watcher, offset, pollTimer });
  }
  stopTailing(sessionId) {
    const entry = this.watchers.get(sessionId);
    if (!entry)
      return;
    try {
      entry.watcher?.close();
    } catch {
    }
    if (entry.pollTimer)
      clearInterval(entry.pollTimer);
    this.watchers.delete(sessionId);
  }
  stopAll() {
    for (const id of this.watchers.keys()) {
      this.stopTailing(id);
    }
  }
  get tailedSessionIds() {
    return [...this.watchers.keys()];
  }
  readNewLines(sessionId, jsonlPath) {
    const entry = this.watchers.get(sessionId);
    if (!entry)
      return;
    let stat;
    try {
      stat = fs6.statSync(jsonlPath);
    } catch {
      return;
    }
    if (stat.size <= entry.offset)
      return;
    const bytesToRead = stat.size - entry.offset;
    if (bytesToRead <= 0)
      return;
    try {
      const fd = fs6.openSync(jsonlPath, "r");
      const buf = Buffer.alloc(bytesToRead);
      fs6.readSync(fd, buf, 0, bytesToRead, entry.offset);
      fs6.closeSync(fd);
      entry.offset = stat.size;
      const text = buf.toString("utf-8");
      const lines = text.split("\n").filter(Boolean);
      for (const line of lines) {
        this.emit("line", { sessionId, line, isSeed: false });
      }
    } catch {
    }
  }
};

// ../dist/core/claude-classifier.js
function classifyClaudeLine(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const ts = parsed["timestamp"] || (/* @__PURE__ */ new Date()).toISOString();
  const type = parsed["type"];
  if (type === "file-history-snapshot")
    return null;
  if (type === "user") {
    const message = parsed["message"];
    if (message?.content) {
      const content = message.content;
      let summary;
      if (typeof content === "string") {
        summary = truncate(content, TRUNCATE.prose);
      } else if (Array.isArray(content)) {
        const toolResult = content.find((c) => c["type"] === "tool_result");
        if (toolResult) {
          const isError = toolResult["is_error"] === true;
          const toolUseId = toolResult["tool_use_id"] || "";
          if (isError) {
            return { kind: "tool_result_error", tool: toolUseId, error: "Tool execution failed", ts };
          }
          return { kind: "tool_result_ok", tool: toolUseId, summary: "Tool completed", ts };
        }
        const text = content.find((c) => c["type"] === "text");
        summary = truncate(text?.["text"] || "User message", TRUNCATE.prose);
      } else {
        summary = "User message";
      }
      return { kind: "user_prompt", summary, ts };
    }
    return null;
  }
  if (type === "assistant") {
    const message = parsed["message"];
    if (!message?.content)
      return null;
    const content = message.content;
    if (!Array.isArray(content)) {
      return { kind: "assistant_text", preview: truncate(String(message.content), TRUNCATE.prose), ts };
    }
    for (const block of content) {
      if (block["type"] === "tool_use") {
        const toolName = block["name"] || "unknown";
        const input = block["input"];
        const target = extractToolTarget(toolName, input);
        return { kind: "tool_call", tool: toolName, target, ts };
      }
    }
    for (const block of content) {
      if (block["type"] === "text" && block["text"]) {
        return { kind: "assistant_text", preview: truncate(block["text"], TRUNCATE.prose), ts };
      }
    }
    return null;
  }
  if (type === "progress") {
    const data = parsed["data"];
    if (!data)
      return null;
    if (data["type"] === "bash_progress") {
      const command = data["command"] || "";
      const elapsed = data["elapsedTimeSeconds"] || 0;
      return { kind: "bash_running", command: truncate(command, TRUNCATE.command), elapsedSeconds: elapsed, ts };
    }
    return null;
  }
  if (type === "system") {
    const subtype = parsed["subtype"];
    if (subtype === "turn_response") {
      const durationMs = parsed["durationMs"] || 0;
      return { kind: "turn_complete", durationMs, ts };
    }
    return null;
  }
  return null;
}
function extractToolTarget(tool, input) {
  if (!input)
    return "";
  switch (tool) {
    case "Read":
    case "Write":
      return truncate(input["file_path"] || "", TRUNCATE.target);
    case "Edit":
      return truncate(input["file_path"] || "", TRUNCATE.target);
    case "Bash":
      return truncate(input["command"] || "", TRUNCATE.target);
    case "Glob":
      return truncate(input["pattern"] || "", TRUNCATE.target);
    case "Grep":
      return truncate(input["pattern"] || "", TRUNCATE.target);
    case "WebFetch":
      return truncate(input["url"] || "", TRUNCATE.target);
    case "WebSearch":
      return truncate(input["query"] || "", TRUNCATE.target);
    case "Task":
      return truncate(input["description"] || "", TRUNCATE.target);
    default:
      return "";
  }
}
function truncate(s, max) {
  const clean = sanitizeForTui(s);
  if (clean.length <= max)
    return clean;
  return clean.slice(0, max - 3) + "...";
}
function sanitizeForTui(s) {
  return s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, " ").replace(/[\r\n\t]/g, " ").replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
}

// ../dist/core/codex-classifier.js
var callIdToTool = /* @__PURE__ */ new Map();
var callIdOrder = [];
var MAX_CALL_TRACK = 2048;
function classifyCodexLine(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const ts = parsed["timestamp"] || (/* @__PURE__ */ new Date()).toISOString();
  const type = parsed["type"];
  const payload = parsed["payload"];
  if (!payload)
    return null;
  if (type === "session_meta") {
    const cwd = payload["cwd"] || "";
    const git = payload["git"];
    const branch = git?.["branch"] || "unknown";
    return { kind: "session_started", project: cwd, branch, model: "", ts };
  }
  if (type === "event_msg") {
    const eventType = payload["type"];
    if (eventType === "user_message") {
      const message = payload["message"] || "User message";
      return { kind: "user_prompt", summary: truncate2(message, TRUNCATE.prose), ts };
    }
    if (eventType === "task_started") {
      return { kind: "user_prompt", summary: "Task started", ts };
    }
    if (eventType === "task_complete") {
      return { kind: "turn_complete", durationMs: 0, ts };
    }
    return null;
  }
  if (type === "response_item") {
    const role = payload["role"];
    const itemType = payload["type"];
    if (role === "user" && itemType === "message") {
      const content = payload["content"];
      if (content) {
        for (const block of content) {
          if (block["type"] === "input_text") {
            const text = block["text"] || "";
            if (text.includes("<environment_context>"))
              return null;
            return { kind: "user_prompt", summary: truncate2(text, TRUNCATE.prose), ts };
          }
        }
      }
      return null;
    }
    if (itemType === "function_call") {
      const name = payload["name"] || "unknown";
      const args = payload["arguments"] || "";
      const callId = payload["call_id"] || "";
      let target = "";
      try {
        const parsedArgs = JSON.parse(args);
        const command = parsedArgs["command"];
        const filePath = parsedArgs["file_path"];
        const query = parsedArgs["query"];
        const targetValue = Array.isArray(command) ? command.join(" ") : command || filePath || query || args;
        target = truncate2(String(targetValue), 60);
      } catch {
        target = truncate2(args, TRUNCATE.target);
      }
      if (callId) {
        rememberCallTool(callId, name);
      }
      return { kind: "tool_call", tool: name, target, ts };
    }
    if (itemType === "function_call_output") {
      const callId = payload["call_id"] || "";
      const toolName = resolveCallTool(callId);
      const parsedOutput = parseFunctionCallOutput(payload["output"]);
      if (parsedOutput.isError) {
        return {
          kind: "tool_result_error",
          tool: toolName,
          error: truncate2(parsedOutput.text || "Tool execution failed", TRUNCATE.prose),
          ts
        };
      }
      return {
        kind: "tool_result_ok",
        tool: toolName,
        summary: truncate2(parsedOutput.text || "Tool completed", TRUNCATE.command),
        ts
      };
    }
    if (role === "assistant" && itemType === "message") {
      const content = payload["content"];
      if (content) {
        for (const block of content) {
          if (block["type"] === "output_text") {
            return { kind: "assistant_text", preview: truncate2(block["text"] || "", TRUNCATE.prose), ts };
          }
        }
      }
      return null;
    }
    return null;
  }
  if (type === "token_count") {
    return null;
  }
  if (type === "turn_context") {
    return null;
  }
  return null;
}
function rememberCallTool(callId, toolName) {
  if (callIdToTool.has(callId)) {
    callIdToTool.set(callId, toolName);
    return;
  }
  callIdToTool.set(callId, toolName);
  callIdOrder.push(callId);
  if (callIdOrder.length > MAX_CALL_TRACK) {
    const oldest = callIdOrder.shift();
    if (oldest)
      callIdToTool.delete(oldest);
  }
}
function resolveCallTool(callId) {
  if (!callId)
    return "tool";
  const tool = callIdToTool.get(callId) || "tool";
  callIdToTool.delete(callId);
  return tool;
}
function parseFunctionCallOutput(output) {
  let parsed = null;
  let text = "";
  if (typeof output === "string") {
    try {
      const maybe = JSON.parse(output);
      if (maybe && typeof maybe === "object") {
        parsed = maybe;
      } else {
        text = output;
      }
    } catch {
      text = output;
    }
  } else if (output && typeof output === "object") {
    parsed = output;
  }
  let explicitError = null;
  let exitCode = null;
  if (parsed) {
    if (typeof parsed["output"] === "string") {
      text = parsed["output"];
    } else if (typeof parsed["error"] === "string") {
      text = parsed["error"];
    } else {
      text = JSON.stringify(parsed);
    }
    if (typeof parsed["is_error"] === "boolean") {
      explicitError = parsed["is_error"];
    }
    if (typeof parsed["error"] === "string" && parsed["error"].trim().length > 0) {
      explicitError = true;
    }
    const metadata = parsed["metadata"];
    const rawExitCode = metadata?.["exit_code"];
    if (typeof rawExitCode === "number" && Number.isFinite(rawExitCode)) {
      exitCode = rawExitCode;
    } else if (typeof rawExitCode === "string") {
      const parsedExitCode = Number.parseInt(rawExitCode, 10);
      if (Number.isFinite(parsedExitCode)) {
        exitCode = parsedExitCode;
      }
    }
  }
  const cleanText = sanitizeForTui2(text);
  const looksFatal = /\b(error:|exception|traceback|permission denied|command not found)\b/i.test(cleanText);
  const isError = exitCode !== null ? exitCode !== 0 : explicitError ?? looksFatal;
  return { text: cleanText, isError };
}
function truncate2(s, max) {
  const clean = sanitizeForTui2(s);
  if (clean.length <= max)
    return clean;
  return clean.slice(0, max - 3) + "...";
}
function sanitizeForTui2(s) {
  return s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, " ").replace(/[\r\n\t]/g, " ").replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
}

// ../dist/core/pi-classifier.js
function classifyPiLine(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const ts = parsed["timestamp"] || (/* @__PURE__ */ new Date()).toISOString();
  const type = parsed["type"];
  if (type === "session") {
    const project = typeof parsed["cwd"] === "string" ? parsed["cwd"] : "";
    return { kind: "session_started", project, branch: "unknown", model: "", ts };
  }
  if (type !== "message") {
    return null;
  }
  const message = parsed["message"];
  if (!message || typeof message !== "object")
    return null;
  const msg = message;
  const role = msg["role"];
  if (role === "user") {
    const text = extractTextBlock(msg["content"]);
    if (!text)
      return null;
    return { kind: "user_prompt", summary: truncate3(text, TRUNCATE.prose), ts };
  }
  if (role === "assistant") {
    const content = msg["content"];
    if (!Array.isArray(content))
      return null;
    for (const block of content) {
      if (!block || typeof block !== "object")
        continue;
      const item = block;
      if (item["type"] === "toolCall") {
        const tool = item["name"] || "tool";
        const target = extractToolTarget2(item["arguments"]);
        return { kind: "tool_call", tool, target, ts };
      }
    }
    for (const block of content) {
      if (!block || typeof block !== "object")
        continue;
      const item = block;
      if (item["type"] === "text" && typeof item["text"] === "string") {
        return { kind: "assistant_text", preview: truncate3(item["text"], TRUNCATE.prose), ts };
      }
    }
    return null;
  }
  if (role === "toolResult") {
    const toolName = msg["toolName"] || "tool";
    const text = extractTextBlock(msg["content"]) || "Tool completed";
    const isError = msg["isError"] === true;
    if (isError) {
      return {
        kind: "tool_result_error",
        tool: toolName,
        error: truncate3(text, TRUNCATE.prose),
        ts
      };
    }
    return {
      kind: "tool_result_ok",
      tool: toolName,
      summary: truncate3(text, TRUNCATE.command),
      ts
    };
  }
  if (role === "bashExecution") {
    const command = truncate3(String(msg["command"] || ""), TRUNCATE.command);
    const rawExitCode = msg["exitCode"];
    const cancelled = msg["cancelled"] === true;
    const exitCode = typeof rawExitCode === "number" && Number.isFinite(rawExitCode) ? rawExitCode : cancelled ? 130 : 0;
    return { kind: "bash_complete", command, exitCode, ts };
  }
  return null;
}
function extractTextBlock(content) {
  if (!Array.isArray(content))
    return "";
  for (const block of content) {
    if (!block || typeof block !== "object")
      continue;
    const item = block;
    if (item["type"] === "text" && typeof item["text"] === "string") {
      return sanitizeForTui3(item["text"]);
    }
  }
  return "";
}
function extractToolTarget2(rawArguments) {
  if (!rawArguments || typeof rawArguments !== "object")
    return "";
  const args = rawArguments;
  const target = args["command"] ?? args["path"] ?? args["file_path"] ?? args["pattern"] ?? args["query"] ?? args["url"] ?? "";
  if (typeof target === "string") {
    return truncate3(target, TRUNCATE.target);
  }
  if (Array.isArray(target)) {
    return truncate3(target.map((v) => String(v)).join(" "), TRUNCATE.target);
  }
  return truncate3(String(target), TRUNCATE.target);
}
function truncate3(s, max) {
  const clean = sanitizeForTui3(s);
  if (clean.length <= max)
    return clean;
  return clean.slice(0, max - 3) + "...";
}
function sanitizeForTui3(s) {
  return s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, " ").replace(/[\r\n\t]/g, " ").replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
}

// ../dist/core/event-classifier.js
function classifyLine(raw, source) {
  if (source === "claude") {
    return classifyClaudeLine(raw);
  }
  if (source === "codex") {
    return classifyCodexLine(raw);
  }
  return classifyPiLine(raw);
}
function activityFromEvent(event) {
  return clampActivity(describeEvent(event));
}
function clampActivity(s) {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (oneLine.length <= TRUNCATE.activity)
    return oneLine;
  return oneLine.slice(0, TRUNCATE.activity - 3) + "...";
}
function describeEvent(event) {
  switch (event.kind) {
    case "user_prompt":
      return `Prompt: ${event.summary}`;
    case "assistant_text":
      return `Responding...`;
    case "tool_call":
      return `${event.tool}: ${event.target}`;
    case "tool_result_ok":
      return `${event.tool || "Tool"} completed`;
    case "tool_result_error":
      return `${event.tool || "Tool"} FAILED`;
    case "tool_rejected":
      return `${event.tool} rejected`;
    case "bash_running":
      return `Running: ${event.command}`;
    case "bash_complete":
      return `Bash done (exit ${event.exitCode})`;
    case "file_written":
      return `Writing ${event.path}`;
    case "file_edited":
      return `Editing ${event.path}`;
    case "turn_complete":
      return `Turn complete (${(event.durationMs / 1e3).toFixed(1)}s)`;
    case "context_health":
      return `Context: ${event.usedPercent}% (${event.status})`;
    case "session_started":
      return `Session started`;
    default:
      return "";
  }
}

// ../dist/core/providers/types.js
function assembleSystemPrompt(req) {
  return [req.systemPrompt, req.context, req.history].filter(Boolean).join("\n\n");
}
var ProviderError = class extends Error {
  provider;
  status;
  constructor(message, provider, status) {
    super(message);
    this.provider = provider;
    this.status = status;
    this.name = "ProviderError";
  }
};
async function errorFromResponse(provider, response) {
  let detail = "";
  try {
    const body = await response.text();
    try {
      const parsed = JSON.parse(body);
      detail = parsed?.error?.message ?? parsed?.error?.type ?? parsed?.message ?? body;
    } catch {
      detail = body;
    }
  } catch {
  }
  detail = String(detail).trim().slice(0, 300);
  if (response.status === 401 || response.status === 403) {
    return new ProviderError(`${provider}: credentials rejected (${response.status}). ${detail}`, provider, response.status);
  }
  if (response.status === 429) {
    return new ProviderError(`${provider}: rate limited. ${detail}`, provider, 429);
  }
  return new ProviderError(`${provider}: request failed (${response.status}). ${detail}`, provider, response.status);
}

// ../dist/core/providers/anthropic.js
var API_URL = "https://api.anthropic.com/v1/messages";
var API_VERSION = "2023-06-01";
var MAX_TOKENS = 1500;
var anthropic = {
  id: "anthropic",
  label: "Anthropic",
  apiKeyEnv: ["ANTHROPIC_API_KEY"],
  requiresApiKey: true,
  models: [
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", recommended: true },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" }
  ],
  async complete(req) {
    const { model, question, apiKey, signal } = req;
    const systemPrompt = assembleSystemPrompt(req);
    if (!apiKey)
      throw new ProviderError("anthropic: no API key", "anthropic");
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: "user", content: question }]
      }),
      ...signal ? { signal } : {}
    });
    if (!response.ok)
      throw await errorFromResponse("anthropic", response);
    const data = await response.json();
    const text = (data.content ?? []).filter((b) => b.type === "text" && b.text).map((b) => b.text).join("").trim();
    return text || "(no response)";
  }
};

// ../dist/core/providers/openai.js
var API_URL2 = "https://api.openai.com/v1/chat/completions";
var MAX_TOKENS2 = 1500;
var openai = {
  id: "openai",
  label: "OpenAI",
  apiKeyEnv: ["OPENAI_API_KEY"],
  requiresApiKey: true,
  models: [
    { id: "gpt-4o-mini", label: "GPT-4o mini", recommended: true },
    { id: "gpt-4o", label: "GPT-4o" }
  ],
  async complete(req) {
    const { model, question, apiKey, signal } = req;
    const systemPrompt = assembleSystemPrompt(req);
    if (!apiKey)
      throw new ProviderError("openai: no API key", "openai");
    const response = await fetch(API_URL2, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: MAX_TOKENS2,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: question }
        ]
      }),
      ...signal ? { signal } : {}
    });
    if (!response.ok)
      throw await errorFromResponse("openai", response);
    const data = await response.json();
    const text = (data.choices?.[0]?.message?.content ?? "").trim();
    return text || "(no response)";
  }
};

// ../dist/core/providers/ollama.js
var DEFAULT_HOST = "http://127.0.0.1:11434";
function host() {
  const configured = process.env["OLLAMA_HOST"]?.trim();
  if (!configured)
    return DEFAULT_HOST;
  return /^https?:\/\//.test(configured) ? configured : `http://${configured}`;
}
var ollama = {
  id: "ollama",
  label: "Ollama (local)",
  apiKeyEnv: [],
  requiresApiKey: false,
  // Suggestions only — what's actually available is whatever the user pulled,
  // which `listInstalledModels` reports. Any id may be passed explicitly.
  models: [
    { id: "llama3.2", label: "Llama 3.2 (local)", recommended: true },
    { id: "qwen2.5", label: "Qwen 2.5 (local)" }
  ],
  async complete(req) {
    const { model, question, signal } = req;
    const systemPrompt = assembleSystemPrompt(req);
    let response;
    try {
      response = await fetch(`${host()}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: question }
          ]
        }),
        ...signal ? { signal } : {}
      });
    } catch (err) {
      throw new Error(`ollama: can't reach a local model runtime at ${host()}. Is Ollama running? Start it with \`ollama serve\`, or set OLLAMA_HOST. (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!response.ok)
      throw await errorFromResponse("ollama", response);
    const data = await response.json();
    return (data.message?.content ?? "").trim() || "(no response)";
  }
};

// ../dist/core/providers/index.js
var PROVIDERS = [claudeCli, anthropic, openai, ollama];
function getProviders() {
  return [...PROVIDERS];
}
function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id);
}
function resolveApiKey(provider) {
  if (!provider.requiresApiKey)
    return null;
  for (const name of provider.apiKeyEnv) {
    const value = process.env[name]?.trim();
    if (value)
      return value;
  }
  return null;
}
async function complete(providerId, req) {
  const provider = getProvider(providerId);
  if (!provider) {
    const known = PROVIDERS.map((p) => p.id).join(", ");
    throw new ProviderError(`Unknown provider "${providerId}". Known: ${known}`, providerId);
  }
  const apiKey = resolveApiKey(provider);
  if (provider.requiresApiKey && !apiKey) {
    throw new ProviderError(`No API key for ${provider.label}. Set ${provider.apiKeyEnv.join(" or ")}, or switch to a local model (--provider ollama) which needs no key.`, providerId);
  }
  return provider.complete({ ...req, ...apiKey ? { apiKey } : {} });
}

// ../dist/core/side-chat-service.js
var MAX_TRANSCRIPT = 150;
var SideChatService = class {
  engine;
  handlers;
  now;
  tailer = new SessionTailer();
  transcripts = /* @__PURE__ */ new Map();
  sources = /* @__PURE__ */ new Map();
  chat = [];
  sessions = [];
  focusId = null;
  thinking = false;
  turnSeq = 0;
  constructor(engine, handlers = {}, now = () => /* @__PURE__ */ new Date()) {
    this.engine = engine;
    this.handlers = handlers;
    this.now = now;
    this.tailer.on("line", ({ sessionId, line, isSeed }) => {
      const source = this.sources.get(sessionId) ?? "claude";
      const event = classifyLine(line, source);
      if (!event)
        return;
      const buf = this.transcripts.get(sessionId) ?? [];
      buf.push(event);
      if (buf.length > MAX_TRANSCRIPT)
        buf.splice(0, buf.length - MAX_TRANSCRIPT);
      this.transcripts.set(sessionId, buf);
      if (!isSeed) {
        const activity = activityFromEvent(event);
        if (activity)
          this.handlers.onActivity?.(sessionId, activity);
      }
      this.handlers.onTranscript?.(sessionId);
    });
  }
  setModel(provider, model) {
    this.engine.setModel(provider, model);
  }
  /** Reconcile the set of tailed sessions with the currently active ones. */
  syncSessions(sessions, jsonlPaths) {
    this.sessions = sessions;
    this.sources.clear();
    for (const s of sessions)
      this.sources.set(s.id, s.source);
    const activeIds = /* @__PURE__ */ new Set();
    for (const s of sessions) {
      if (s.status === "active" || s.status === "idle") {
        activeIds.add(s.id);
        const jsonlPath = jsonlPaths.get(s.id);
        if (jsonlPath && !this.tailer.tailedSessionIds.includes(s.id)) {
          this.tailer.startTailing(s.id, jsonlPath);
        }
      }
    }
    for (const id of this.tailer.tailedSessionIds) {
      if (!activeIds.has(id))
        this.tailer.stopTailing(id);
    }
  }
  /**
   * Focus a session, or null for none. Focus only deepens that session's
   * transcript in the prompt; the chat still spans every session.
   */
  setFocus(sessionId) {
    this.focusId = sessionId;
  }
  getFocus() {
    return this.focusId;
  }
  getTranscript(sessionId) {
    return this.transcripts.get(sessionId) ?? [];
  }
  /** The one bird's-eye conversation. */
  getChat() {
    return this.chat;
  }
  isThinking() {
    return this.thinking;
  }
  /** Everything the observer can see right now. */
  snapshot() {
    const now = this.now();
    const sessions = this.sessions.map((s) => ({
      id: s.id,
      source: s.source,
      projectName: s.projectName,
      gitBranch: s.gitBranch,
      model: s.model,
      status: s.status,
      idleForMs: Math.max(0, now.getTime() - s.lastEventTime.getTime()),
      currentActivity: s.currentActivity,
      contextUsedPercent: s.usedPercent,
      contextStatus: s.contextStatus,
      transcript: this.getTranscript(s.id)
    }));
    return { now, sessions, focusId: this.focusId };
  }
  /**
   * Ask the observer a question about the sessions it can see. Needs no session
   * selection — the whole world is in scope. Resolves when answered.
   */
  async ask(question) {
    const trimmed = question.trim();
    if (!trimmed)
      return;
    const history = [...this.chat];
    this.appendTurn(this.newTurn("user", trimmed));
    this.setThinking(true);
    try {
      const answer = await this.engine.ask({ world: this.snapshot(), history, question: trimmed });
      this.appendTurn(this.newTurn("assistant", answer));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.appendTurn(this.newTurn("assistant", `\u26A0 ${message}`, true));
    } finally {
      this.setThinking(false);
    }
  }
  dispose() {
    this.tailer.stopAll();
    disposeClaudeSession();
  }
  appendTurn(turn) {
    this.chat = [...this.chat, turn];
    this.handlers.onChat?.();
  }
  setThinking(thinking) {
    this.thinking = thinking;
    this.handlers.onThinking?.(thinking);
  }
  newTurn(role, content, error = false) {
    this.turnSeq += 1;
    return { id: `t${this.turnSeq}-${Date.now()}`, role, content, timestamp: /* @__PURE__ */ new Date(), error };
  }
};

// ../dist/core/transcript-format.js
function formatEvent(event) {
  switch (event.kind) {
    case "session_started":
      return `[session started] project=${event.project} branch=${event.branch} model=${event.model}`;
    case "user_prompt":
      return `[user] ${event.summary}`;
    case "assistant_text":
      return `[agent] ${event.preview}`;
    case "tool_call":
      return `[tool] ${event.tool} \u2192 ${event.target}`;
    case "tool_result_ok":
      return `[tool ok] ${event.tool}: ${event.summary}`;
    case "tool_result_error":
      return `[tool ERROR] ${event.tool}: ${event.error}`;
    case "tool_rejected":
      return `[tool rejected by user] ${event.tool}`;
    case "bash_running":
      return `[bash running ${event.elapsedSeconds}s] ${event.command}`;
    case "bash_complete":
      return `[bash done exit=${event.exitCode}] ${event.command}`;
    case "file_written":
      return `[wrote file] ${event.path}`;
    case "file_edited":
      return `[edited file] ${event.path}`;
    case "turn_complete":
      return `[turn complete in ${(event.durationMs / 1e3).toFixed(1)}s]`;
    case "context_health":
      return `[context ${event.usedPercent}% used (${event.status})]`;
    case "unknown":
      return "";
    default:
      return "";
  }
}

// ../dist/core/world-view.js
var TRANSCRIPT_BUDGET_CHARS = 24e3;
var MIN_DETAIL_CHARS = 400;
var WEIGHTS = { focus: 6, active: 3, idle: 1.5, ended: 0.5 };
function weightFor(session2, focusId) {
  if (session2.id === focusId)
    return WEIGHTS.focus;
  if (session2.status === "active")
    return WEIGHTS.active;
  if (session2.status === "idle")
    return WEIGHTS.idle;
  return WEIGHTS.ended;
}
function allocateTranscriptBudget(sessions, focusId, totalChars = TRANSCRIPT_BUDGET_CHARS) {
  const candidates = sessions.filter((s) => s.transcript.length > 0);
  const perSession = /* @__PURE__ */ new Map();
  if (candidates.length === 0 || totalChars < MIN_DETAIL_CHARS) {
    return { perSession, omitted: candidates.map((s) => s.id) };
  }
  let pool = candidates.map((s) => ({ id: s.id, weight: weightFor(s, focusId) }));
  for (; ; ) {
    const totalWeight = pool.reduce((sum, p) => sum + p.weight, 0);
    const shares = pool.map((p) => ({ ...p, share: Math.floor(totalChars * p.weight / totalWeight) }));
    const starved = shares.some((s) => s.share < MIN_DETAIL_CHARS);
    if (!starved) {
      for (const s of shares)
        perSession.set(s.id, s.share);
      break;
    }
    if (pool.length === 1) {
      perSession.set(pool[0].id, totalChars);
      break;
    }
    let weakest = 0;
    for (let i = 1; i < pool.length; i += 1) {
      if (pool[i].weight <= pool[weakest].weight)
        weakest = i;
    }
    pool = pool.filter((_, i) => i !== weakest);
  }
  const omitted = candidates.filter((s) => !perSession.has(s.id)).map((s) => s.id);
  return { perSession, omitted };
}
function tailWithinBudget(transcript, budget) {
  const lines = [];
  let spent = 0;
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const line = formatEvent(transcript[i]);
    if (!line)
      continue;
    if (spent + line.length > budget && lines.length > 0)
      break;
    lines.unshift(line);
    spent += line.length + 1;
  }
  return lines;
}
function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1e3));
  if (seconds < 60)
    return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
function renderRoster(world) {
  if (world.sessions.length === 0) {
    return "No agent sessions are running. Nothing to observe right now.";
  }
  const lines = world.sessions.map((s) => {
    const focus = s.id === world.focusId ? " <- user is focused here" : "";
    const branch = s.gitBranch ? ` (${s.gitBranch})` : "";
    const quiet = `quiet for ${formatDuration(s.idleForMs)}`;
    const activity = s.currentActivity ? ` | last seen: ${s.currentActivity}` : "";
    const ctx = s.contextUsedPercent > 0 ? ` | context ${s.contextUsedPercent}% (${s.contextStatus})` : "";
    return `- [${s.id}] ${s.source} \xB7 ${s.projectName}${branch} | ${s.status.toUpperCase()}, ${quiet}${ctx}${activity}${focus}`;
  });
  return `=== Agent sessions aside can see (${world.sessions.length}) ===
${lines.join("\n")}`;
}
function renderDetail(world, totalChars = TRANSCRIPT_BUDGET_CHARS) {
  const { perSession, omitted } = allocateTranscriptBudget(world.sessions, world.focusId, totalChars);
  const blocks = [];
  for (const session2 of world.sessions) {
    const budget = perSession.get(session2.id);
    if (!budget)
      continue;
    const lines = tailWithinBudget(session2.transcript, budget);
    if (lines.length === 0)
      continue;
    const branch = session2.gitBranch ? ` (${session2.gitBranch})` : "";
    blocks.push(`--- [${session2.id}] ${session2.projectName}${branch} \u2014 most recent activity, oldest first ---
${lines.join("\n")}`);
  }
  if (blocks.length === 0)
    return "";
  let out = `=== Recent activity ===
${blocks.join("\n\n")}`;
  if (omitted.length > 0) {
    out += `

(Transcript detail for ${omitted.length} other session(s) was omitted to fit the context budget. They are listed in the roster above; ask about one directly to focus it.)`;
  }
  return out;
}
function renderWorld(world, totalChars = TRANSCRIPT_BUDGET_CHARS) {
  return [
    `Current time: ${world.now.toISOString()}`,
    renderRoster(world),
    renderDetail(world, totalChars)
  ].filter(Boolean).join("\n\n");
}
var HISTORY_BUDGET_CHARS = 8e3;
function renderHistory(history, budgetChars = HISTORY_BUDGET_CHARS) {
  if (history.length === 0)
    return "";
  const kept = [];
  let spent = 0;
  let dropped = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    const line = `${turn.role === "user" ? "User asked" : "You answered"}: ${turn.content}`;
    if (spent + line.length > budgetChars && kept.length > 0) {
      dropped = i + 1;
      break;
    }
    kept.unshift(line);
    spent += line.length + 1;
  }
  const header = dropped > 0 ? `=== Earlier in this side chat (${dropped} older turn(s) omitted for length) ===` : "=== Earlier in this side chat (for continuity) ===";
  return `${header}
${kept.join("\n")}`;
}

// ../dist/core/side-chat-engine.js
var SYSTEM_PROMPT = `You are "aside" \u2014 a read-only observer with a bird's-eye view of the AI coding-agent sessions running on this user's machine.

You are given, for every session you can see: a roster line (project, branch, source, status, how long it has been quiet, context usage, last observed activity), and \u2014 for the sessions most worth the detail \u2014 a recent transcript of prompts, agent replies, tool calls, file edits, and command output.

The user chats with YOU on the side. They are asking about their agents WITHOUT interrupting or steering them.

Your job:
- Answer questions across all sessions: what each agent is doing right now, why it went the way it did, what it will likely do next.
- Compare and connect sessions when it helps ("both are editing the same file", "this one has been stuck for 20 minutes while that one finished").
- Notice things worth flagging: a session quiet far longer than its work suggests it should be, repeated failing commands, a session burning context, an agent that looks off-track.
- Be concise and direct. This is a side panel, not an essay.

Formatting:
- Answer in plain prose. Both frontends render your reply as literal text, so markdown does not format \u2014 "## Heading", "**bold**" and "---" appear verbatim and just look like noise. Use short paragraphs and plain "-" bullets only.
- Lead with the answer. A one-line verdict first, detail after.

Reading the data:
- "Current time" and each session's "quiet for" are computed for you. Use them for anything about idleness or how long something has taken \u2014 you cannot infer elapsed time from the transcript alone, because a session that does nothing writes nothing.
- A session being quiet is not automatically a problem. An agent waiting on the user, or finished, is quiet and fine. Say what the quiet most likely means given its last activity, and distinguish "waiting for input" from "stalled mid-task".
- Transcript prose is truncated, so an agent's reasoning may be cut off mid-thought. Don't mistake a truncation for the agent stopping.

Hard constraints:
- You are READ-ONLY. You have no tools and cannot edit files, run commands, or send anything into any session. Never claim to have done so.
- If asked to *do* something, explain that you only observe \u2014 the user should tell that agent directly.
- You see agent sessions only. You cannot see builds, containers, other terminals, browser tabs, or anything else on the machine. If asked about something outside the sessions, say plainly that it's outside what you can see.
- If the data doesn't answer the question, say so rather than guessing. Never invent activity that isn't in the transcript. If detail for a session was omitted from your context, say that instead of assuming it was idle.`;
var SideChatEngine = class {
  config;
  constructor(config) {
    this.config = config;
  }
  setModel(provider, model) {
    this.config = { ...this.config, provider, model };
  }
  async ask({ world, history, question }) {
    const provider = getProvider(this.config.provider);
    if (!provider) {
      throw new Error(`Unknown provider: ${this.config.provider}`);
    }
    return complete(provider.id, {
      model: this.config.model,
      systemPrompt: SYSTEM_PROMPT,
      context: renderWorld(world, this.config.transcriptBudget ?? TRANSCRIPT_BUDGET_CHARS),
      history: renderHistory(history),
      question
    });
  }
};

// ../dist/config/model-catalog.js
function flattenModelCatalog() {
  const options = [];
  for (const provider of getProviders()) {
    for (const model of provider.models) {
      options.push({
        provider: provider.id,
        model: model.id,
        label: `${model.label} (${model.id})`,
        ...model.recommended ? { recommended: true } : {}
      });
    }
  }
  return options;
}

// src/backend.ts
var MenubarBackend = class {
  constructor(config, onUpdate, deps = {}) {
    this.config = config;
    this.onUpdate = onUpdate;
    this.scan = deps.scan ?? (() => scanAllSessions({}));
    this.models = (deps.models ?? flattenModelCatalog)();
    this.service = deps.service ?? new SideChatService(new SideChatEngine(config), {
      onChat: () => this.emit(),
      onThinking: () => this.emit(),
      onActivity: (id, activity) => {
        const s = this.sessions.find((x) => x.id === id);
        if (s) {
          s.currentActivity = activity;
          s.status = "active";
        }
        this.emit();
      }
    });
  }
  config;
  onUpdate;
  service;
  scan;
  /** Catalogued once: it's a static registry, not live state. */
  models;
  sessions = [];
  focusId = null;
  timer = null;
  start() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), TIMING.scanIntervalMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.service.dispose();
  }
  /** Focus a session (or null for none) to deepen its transcript in the prompt. */
  selectSession(id) {
    this.focusId = id;
    this.service.setFocus(id);
    this.emit();
  }
  setModel(provider, model) {
    this.config = { ...this.config, provider, model };
    this.service.setModel(provider, model);
    this.emit();
  }
  /** Ask about the whole world. No session selection required. */
  ask(question) {
    return this.service.ask(question);
  }
  getState() {
    const now = Date.now();
    return {
      sessions: this.sessions.map((s) => ({
        id: s.id,
        source: s.source,
        projectName: s.projectName,
        status: s.status,
        currentActivity: s.currentActivity,
        idleForMs: Math.max(0, now - s.lastEventTime.getTime())
      })),
      focusId: this.focusId,
      messages: this.service.getChat(),
      thinking: this.service.isThinking(),
      provider: this.config.provider,
      model: this.config.model,
      models: this.models
    };
  }
  /** Rescan sessions, keep the focus valid, and re-sync the tailer. */
  refresh() {
    const { sessions, jsonlPaths } = this.scan();
    this.sessions = sessions;
    if (!this.focusId || !sessions.some((s) => s.id === this.focusId)) {
      this.focusId = sessions[0]?.id ?? null;
      this.service.setFocus(this.focusId);
    }
    this.service.syncSessions(sessions, jsonlPaths);
    this.emit();
  }
  emit() {
    this.onUpdate(this.getState());
  }
};

// src/shell-env.ts
import { execFileSync } from "node:child_process";
var IMPORTABLE_VAR = /^(PATH|[A-Z0-9_]*(API_KEY|AUTH_TOKEN|API_TOKEN))$/;
var MAX_VALUE_LENGTH = 8192;
function importShellEnv(timeoutMs = 5e3) {
  const shell = process.env["SHELL"];
  if (!shell) return { imported: [], error: "no $SHELL set" };
  let raw;
  try {
    raw = execFileSync(shell, ["-l", "-i", "-c", "printenv"], {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
      // A shell that dumps enormous output shouldn't be able to exhaust memory.
      maxBuffer: 4 * 1024 * 1024
    });
  } catch (err) {
    return { imported: [], error: err instanceof Error ? err.message : String(err) };
  }
  const imported = [];
  for (const line of raw.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (!IMPORTABLE_VAR.test(key)) continue;
    if (!value || value.length > MAX_VALUE_LENGTH) continue;
    if (key !== "PATH" && process.env[key]) continue;
    process.env[key] = value;
    imported.push(key);
  }
  return { imported };
}
function isMissingShellEnv() {
  const path6 = process.env["PATH"] ?? "";
  const hasUserPaths = /\/(usr\/local|opt\/homebrew|\.local|\.npm-global|\.cargo)\/bin/.test(path6);
  return !hasUserPaths;
}

// src/main.ts
var here = path5.dirname(fileURLToPath(import.meta.url));
var WINDOW_WIDTH = 400;
var WINDOW_HEIGHT = 560;
var DEV_SHOW = process.argv.includes("--show");
var DEV_SHOW_POSITION = { x: 80, y: 80 };
function flagValue(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}
var CAPTURE_PATH = flagValue("--capture");
var CAPTURE_ASK = flagValue("--ask");
var tray = null;
var win = null;
var backend = null;
function trayImage() {
  const image = nativeImage.createFromPath(path5.join(here, "..", "assets", "trayTemplate.png"));
  if (image.isEmpty()) return nativeImage.createEmpty();
  image.setTemplateImage(true);
  return image;
}
function createWindow() {
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path5.join(here, "..", "preload.cjs"),
      contextIsolation: true,
      sandbox: false
    }
  });
  window.loadFile(path5.join(here, "..", "index.html"));
  if (!DEV_SHOW) window.on("blur", () => window.hide());
  return window;
}
function positionWindow(window, trayInstance) {
  const trayBounds = trayInstance.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const x = Math.round(
    Math.min(
      Math.max(trayBounds.x + trayBounds.width / 2 - WINDOW_WIDTH / 2, display.workArea.x + 8),
      display.workArea.x + display.workArea.width - WINDOW_WIDTH - 8
    )
  );
  const y = Math.round(trayBounds.y + trayBounds.height + 4);
  window.setPosition(x, y, false);
}
function toggleWindow() {
  if (!win || !tray) return;
  if (win.isVisible()) {
    win.hide();
    return;
  }
  positionWindow(win, tray);
  win.show();
  win.focus();
  win.webContents.send("aside:update", backend?.getState());
}
app.whenReady().then(() => {
  app.dock?.hide();
  if (isMissingShellEnv()) {
    const { imported, error } = importShellEnv();
    if (imported.length > 0) console.log(`  \u2022 imported from login shell: ${imported.join(", ")}`);
    else if (error) console.warn(`  \u2022 shell env import failed: ${error}`);
  }
  win = createWindow();
  backend = new MenubarBackend(
    { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
    (state) => {
      if (win && !win.isDestroyed()) win.webContents.send("aside:update", state);
    }
  );
  backend.start();
  ipcMain.handle("aside:get-state", () => backend?.getState());
  ipcMain.handle("aside:select", (_e, id) => backend?.selectSession(id));
  ipcMain.handle("aside:ask", (_e, question) => backend?.ask(question));
  ipcMain.handle(
    "aside:set-model",
    (_e, provider, model) => backend?.setModel(provider, model)
  );
  const icon = trayImage();
  tray = new Tray(icon);
  if (icon.isEmpty()) tray.setTitle("aside");
  tray.setToolTip("aside \u2014 read-only bird's-eye chat for your agents");
  tray.on("click", toggleWindow);
  if (DEV_SHOW || CAPTURE_PATH) {
    win.setPosition(DEV_SHOW_POSITION.x, DEV_SHOW_POSITION.y, false);
    win.show();
    win.webContents.once("did-finish-load", () => {
      win?.webContents.send("aside:update", backend?.getState());
    });
  }
  if (CAPTURE_PATH) void captureAndQuit(win, CAPTURE_PATH, CAPTURE_ASK);
});
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function captureAndQuit(window, target, question) {
  try {
    await new Promise((resolve) => {
      if (!window.webContents.isLoading()) return resolve();
      window.webContents.once("did-finish-load", () => resolve());
    });
    await sleep(1500);
    if (question) {
      await window.webContents.executeJavaScript(`
        (() => {
          document.getElementById('input').value = ${JSON.stringify(question)};
          document.getElementById('composer').dispatchEvent(
            new Event('submit', { cancelable: true }),
          );
        })()
      `);
      for (let i = 0; i < 60; i += 1) {
        await sleep(1e3);
        const busy = await window.webContents.executeJavaScript(
          `!!document.querySelector('.thinking')`
        );
        const answered = await window.webContents.executeJavaScript(
          `!!document.querySelector('.turn.assistant')`
        );
        if (!busy && answered) break;
      }
      await sleep(500);
    }
    const image = await window.webContents.capturePage();
    fs7.writeFileSync(target, image.toPNG());
    console.log(`captured -> ${target}`);
  } catch (err) {
    console.error("capture failed:", err);
  } finally {
    app.exit(0);
  }
}
app.on("window-all-closed", () => {
});
app.on("before-quit", () => {
  backend?.stop();
});
