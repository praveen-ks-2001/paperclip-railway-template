#!/usr/bin/env node
/**
 * paperclip-railway/scripts/start.mjs
 *
 * Startup wrapper for paperclipai on Railway.
 *
 * Port layout:
 *   PUBLIC_PORT (3100) — owned by this wrapper, always
 *   PAPERCLIP_PORT (3099) — internal, Paperclip only
 *
 * Routing:
 *   /setup/*  → always handled here (env check, launch, invite, reset)
 *   /         → proxy if ready, else redirect to /setup
 *   everything else → proxy if ready, else redirect to /setup
 *
 * "Ready" is derived — no flag files, no SETUP_COMPLETE env var.
 *   isReady() = config.json exists AND all 4 required env vars are set
 */

import { createServer, request as httpRequest } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PUBLIC_PORT = parseInt(process.env.PORT || "3100", 10);
const PAPERCLIP_PORT = 3099;
const HOME = process.env.PAPERCLIP_HOME || "/paperclip";
const CONFIG_PATH = join(HOME, "config.json");
const INVITE_FILE = join(HOME, "bootstrap-invite.txt");
const SKIP_REASON_FILE = join(HOME, "bootstrap-skip-reason.txt");

// Strip ANSI escape sequences (colors, cursor, etc.) from strings
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

// ── Global state ─────────────────────────────────────────────────────────────

let paperclipProc = null;
let paperclipReady = false;
let inviteUrl = null;
let bootstrapSkippedReason = null;

// ── Ready check (derived from reality, no flags) ─────────────────────────────

const REQUIRED_VARS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_PUBLIC_URL",
  "PAPERCLIP_ALLOWED_HOSTNAMES",
];

function isReady() {
  return REQUIRED_VARS.every(k => !!process.env[k]) && existsSync(CONFIG_PATH);
}

function allEnvVarsSet() {
  return REQUIRED_VARS.every(k => !!process.env[k]);
}

// ── Config builder ────────────────────────────────────────────────────────────

function writeConfig() {
  mkdirSync(HOME, { recursive: true });
  mkdirSync(join(HOME, "logs"), { recursive: true });
  mkdirSync(join(HOME, "storage"), { recursive: true });

  const config = {
    $meta: {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: "onboard",
    },
    database: {
      provider: "postgres",
      connectionString: process.env.DATABASE_URL,
    },
    logging: {
      mode: "file",
      logDir: join(HOME, "logs"),
    },
    server: {
      deploymentMode: process.env.PAPERCLIP_DEPLOYMENT_MODE || "authenticated",
      deploymentExposure: process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE || "public",
      allowedHostnames: (process.env.PAPERCLIP_ALLOWED_HOSTNAMES || "")
        .split(",").map(h => h.trim()).filter(Boolean),
      port: PAPERCLIP_PORT,
      host: "127.0.0.1",
    },
    auth: {
      baseUrlMode: "explicit",
      publicBaseUrl: process.env.PAPERCLIP_PUBLIC_URL || "",
      disableSignUp: process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP === "true",
    },
    storage: {
      provider: "local_disk",
      localDiskPath: join(HOME, "storage"),
    },
    secrets: {
      provider: "local_encrypted",
      localEncrypted: {
        keyFilePath: join(HOME, "secrets.key"),
      },
    },
  };

  // Always overwrite — keeps config in sync with env vars on every boot
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`   Config written to ${CONFIG_PATH}`);
}

// ── Paperclip process ─────────────────────────────────────────────────────────

function startPaperclip() {
  if (paperclipProc) return; // already running

  console.log(`\n🚀 Starting Paperclip on internal port ${PAPERCLIP_PORT}...\n`);

  writeConfig();

  paperclipProc = spawn(
    "node",
    ["node_modules/.bin/paperclipai", "run"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PAPERCLIP_CONFIG: CONFIG_PATH,
        PAPERCLIP_HOME: HOME,
        PORT: String(PAPERCLIP_PORT),
        HOST: "127.0.0.1",
        NODE_ENV: process.env.NODE_ENV || "production",
        // Pass through LLM API keys if set
        ...(process.env.GROQ_API_KEY && { GROQ_API_KEY: process.env.GROQ_API_KEY }),
        ...(process.env.ANTHROPIC_API_KEY && { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }),
        ...(process.env.OPENAI_API_KEY && { OPENAI_API_KEY: process.env.OPENAI_API_KEY }),
      },
    }
  );

  paperclipProc.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);

    const clean = stripAnsi(text);

    // Capture bootstrap invite URL
    const match = clean.match(/https?:\/\/\S+\/invite\/pcp_bootstrap_\S+/);
    if (match) {
      inviteUrl = match[0].trim();
      bootstrapSkippedReason = null;
      writeFileSync(INVITE_FILE, inviteUrl);
      if (existsSync(SKIP_REASON_FILE)) unlinkSync(SKIP_REASON_FILE);
      console.log(`\n✅ Bootstrap invite URL saved to ${INVITE_FILE}\n`);
    }

    // Detect "admin already exists" — Paperclip skips invite generation
    if (clean.includes("Instance already has an admin user")) {
      bootstrapSkippedReason = "An admin account already exists. You can log in directly from the dashboard.";
      writeFileSync(SKIP_REASON_FILE, bootstrapSkippedReason);
      console.log(`\n⚠️ Bootstrap invite skipped: admin already exists.\n`);
    }

    // Detect ready
    if (!paperclipReady && (text.includes("Server listening on") || text.includes("server listening"))) {
      paperclipReady = true;
      console.log(`\n✅ Paperclip ready — proxying :${PUBLIC_PORT} → :${PAPERCLIP_PORT}\n`);
    }
  });

  paperclipProc.stderr.on("data", chunk => process.stderr.write(chunk));

  paperclipProc.on("error", err => {
    console.error("Paperclip process error:", err);
    paperclipProc = null;
    paperclipReady = false;
  });

  paperclipProc.on("exit", (code) => {
    console.log(`Paperclip exited with code ${code}`);
    // Railway will restart the whole container on exit — don't try to restart here
    process.exit(code ?? 1);
  });
}

function stopPaperclip() {
  if (!paperclipProc) return;
  paperclipReady = false;
  paperclipProc.kill("SIGTERM");
  paperclipProc = null;
}

// ── Reset ─────────────────────────────────────────────────────────────────────

function resetSetup() {
  stopPaperclip();
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  if (existsSync(INVITE_FILE)) unlinkSync(INVITE_FILE);
  if (existsSync(SKIP_REASON_FILE)) unlinkSync(SKIP_REASON_FILE);
  inviteUrl = null;
  bootstrapSkippedReason = null;
  console.log("\n🔄 Setup reset. Config and invite file deleted.\n");
}

// ── Proxy ─────────────────────────────────────────────────────────────────────

function proxy(req, res) {
  if (!paperclipReady) {
    res.writeHead(503, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f0f10;color:#fff">
      <div style="text-align:center">
        <div style="font-size:32px;margin-bottom:16px">⏳</div>
        <h2>Paperclip is starting up...</h2>
        <p style="color:#71717a;margin-top:8px">This page will refresh automatically.</p>
        <script>setTimeout(()=>location.reload(),3000)<\/script>
      </div></body></html>`);
    return;
  }

  const opts = {
    hostname: "127.0.0.1",
    port: PAPERCLIP_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      "x-forwarded-host": req.headers.host,
      "x-forwarded-proto": "https",
      "x-forwarded-for": req.socket.remoteAddress,
    },
  };

  const upstream = httpRequest(opts, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res, { end: true });
  });

  upstream.on("error", () => {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Paperclip is restarting — please refresh in a moment.");
  });

  req.pipe(upstream, { end: true });
}

// ── Env var status (for setup page) ──────────────────────────────────────────

function envVarStatus() {
  const all = [
    { key: "DATABASE_URL", required: true, label: "Database URL", example: "postgresql://user:pass@host:5432/db" },
    { key: "BETTER_AUTH_SECRET", required: true, label: "Auth Secret", example: "${{secret(32)}} — use Railway generator" },
    { key: "PAPERCLIP_PUBLIC_URL", required: true, label: "Public URL", example: "https://your-app.up.railway.app" },
    { key: "PAPERCLIP_ALLOWED_HOSTNAMES", required: true, label: "Allowed Hostnames", example: "your-app.up.railway.app" },
    { key: "PAPERCLIP_DEPLOYMENT_MODE", required: false, label: "Deployment Mode", example: "authenticated" },
    { key: "PAPERCLIP_HOME", required: false, label: "Paperclip Home", example: "/paperclip" },
    { key: "GROQ_API_KEY", required: false, label: "Groq API Key", example: "gsk_..." },
    { key: "ANTHROPIC_API_KEY", required: false, label: "Anthropic API Key", example: "sk-ant-..." },
    { key: "OPENAI_API_KEY", required: false, label: "OpenAI API Key", example: "sk-..." },
  ];
  return all.map(v => ({
    ...v,
    set: !!process.env[v.key],
    missing: v.required && !process.env[v.key],
  }));
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const method = req.method;
    const ready = isReady();

    // ── Setup API routes (always available) ──────────────────────────────────

    if (path === "/setup/status" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        vars: envVarStatus(),
        configExists: existsSync(CONFIG_PATH),
        paperclipReady: paperclipReady,
        ready: ready,
      }));
      return;
    }

    if (path === "/setup/invite" && method === "GET") {
      // Try loading from memory, then file
      if (!inviteUrl && existsSync(INVITE_FILE)) {
        try { inviteUrl = stripAnsi(readFileSync(INVITE_FILE, "utf8")).trim(); } catch (_) { }
      }
      if (!bootstrapSkippedReason && existsSync(SKIP_REASON_FILE)) {
        try { bootstrapSkippedReason = readFileSync(SKIP_REASON_FILE, "utf8").trim(); } catch (_) { }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        url: inviteUrl,
        paperclipReady,
        skippedReason: bootstrapSkippedReason || null,
      }));
      return;
    }

    if (path === "/setup/launch" && method === "POST") {
      if (paperclipProc) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, already: true }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => startPaperclip(), 300);
      return;
    }

    if (path === "/setup/rotate-invite" && method === "POST") {
      const proc = spawn(
        "node",
        ["node_modules/.bin/paperclipai", "auth", "bootstrap-ceo", "--force"],
        { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PAPERCLIP_CONFIG: CONFIG_PATH } }
      );
      let out = "";
      proc.stdout.on("data", d => {
        out += d.toString();
        const clean = stripAnsi(out);
        const match = clean.match(/https?:\/\/\S+\/invite\/pcp_bootstrap_\S+/);
        if (match) {
          inviteUrl = match[0].trim();
          writeFileSync(INVITE_FILE, inviteUrl);
          // Clear skip reason since we now have a fresh invite
          bootstrapSkippedReason = null;
          if (existsSync(SKIP_REASON_FILE)) unlinkSync(SKIP_REASON_FILE);
        }
      });
      proc.stderr.on("data", d => process.stderr.write(d));
      proc.on("exit", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ url: inviteUrl }));
      });
      return;
    }

    if (path === "/setup/reset" && method === "POST") {
      resetSetup();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── Setup page ────────────────────────────────────────────────────────────

    if (path === "/setup") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(readFileSync(join(__dirname, "setup.html"), "utf8"));
      return;
    }

    // ── Root + everything else ────────────────────────────────────────────────

    if (!ready) {
      res.writeHead(302, { Location: "/setup" });
      res.end();
      return;
    }

    proxy(req, res);
  });

  server.listen(PUBLIC_PORT, "0.0.0.0", () => {
    console.log(`\n🔧 Wrapper listening on port ${PUBLIC_PORT}`);
    console.log(`   Visit /setup to configure or manage your instance.\n`);
  });
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

startServer();

if (isReady()) {
  startPaperclip();
}

