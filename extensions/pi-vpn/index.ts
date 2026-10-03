/**
 * pi-vpn: Pi-native independent VPN egress.
 *
 * Manages a dedicated Mihomo sidecar exclusively for Pi:
 * - own binary  (~/.pi/agent/bin/mihomo.exe)
 * - own config  (~/.pi/agent/pi-vpn/config.yaml, AI-editable with guardrails)
 * - own ports   (mixed 18090, socks 18091, controller 127.0.0.1:19097)
 * - own secret  (~/.pi/agent/pi-vpn/.secret, generated on first run)
 * - proxies imported from the Clash Verge subscription cache (no re-login,
 *   no subscription URL stored here; update the subscription in Verge,
 *   then run /vpn-update or the vpn_update tool).
 *
 * Zero npm dependencies (node builtins only).
 *
 * Model tools: vpn_status, vpn_start, vpn_stop, vpn_restart, vpn_switch, vpn_proxies, vpn_speedtest, vpn_health, vpn_mode, vpn_use, vpn_update, vpn_reload, vpn_sub_add, vpn_sub_list, vpn_sub_use, vpn_sub_remove
 * Commands: /vpn, /vpn-switch <keyword>, /netcheck, /vpn-update
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { openSync, closeSync } from "node:fs";
import {
  access,
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { connect } from "node:net";import { connect as tlsConnect } from "node:tls";import { request as httpsRequest } from "node:https";import { request as httpRequest } from "node:http";

// ---------------------------------------------------------------- constants

const EXT_NAME = "pi-vpn";

const PI_MIXED_PORT = 18090;
const PI_SOCKS_PORT = 18091;
const PI_CONTROLLER_HOST = "127.0.0.1";
const PI_CONTROLLER_PORT = 19097;

// Ports owned by Clash Verge on this machine. The pi config must never
// bind these; validation refuses to start if it does.
const RESERVED_PORTS = new Set([7890, 7891, 7892, 7895, 7896, 7898, 7899, 9090, 9097]);

const VERGE_DATA_DIR = join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? "C:\\", "AppData", "Roaming"),
  "io.github.clash-verge-rev.clash-verge-rev",
);

const DEFAULT_TEST_URL = "https://www.google.com/generate_204";
const FALLBACK_EGRESS = "http://127.0.0.1:7890"; // Clash Verge mixed port

const GEO_FILES = ["Country.mmdb", "ASN.mmdb", "geoip.dat", "geosite.dat"];

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ paths

interface VpnPaths {
  agentDir: string;
  runtimeDir: string;
  binary: string;
  configFile: string;
  goodConfigFile: string;
  settingsFile: string;
  secretFile: string;  metaFile: string;  subsFile: string;
  pidFile: string;
  logFile: string;
}

function getPaths(): VpnPaths {
  const agentDir = getAgentDir();
  const runtimeDir = join(agentDir, "pi-vpn");
  return {
    agentDir,
    runtimeDir,
    binary: join(agentDir, "bin", "mihomo.exe"),
    configFile: join(runtimeDir, "config.yaml"),
    goodConfigFile: join(runtimeDir, "config.good.yaml"),
    settingsFile: join(runtimeDir, "settings.json"),
    secretFile: join(runtimeDir, ".secret"),    metaFile: join(runtimeDir, "meta.json"),    subsFile: join(runtimeDir, "subscriptions.json"),
    pidFile: join(runtimeDir, "mihomo.pid"),
    logFile: join(runtimeDir, "mihomo.log"),
  };
}

// ---------------------------------------------------------------- settings

interface VpnSettings {
  mixedPort: number;
  socksPort: number;
  controllerPort: number;
  autoStart: boolean;
  /** Switch process proxy env to the pi sidecar once it is healthy. */
  autoUse: boolean;
  testUrl: string;  testTimeoutMs: number;  delayThresholdMs: number;  updateIntervalHours: number;  autoUpdateOnStart: boolean;}

const DEFAULT_SETTINGS: VpnSettings = {
  mixedPort: PI_MIXED_PORT,
  socksPort: PI_SOCKS_PORT,
  controllerPort: PI_CONTROLLER_PORT,
  autoStart: true,
  autoUse: true,
  testUrl: DEFAULT_TEST_URL,
  testTimeoutMs: 5000,
  delayThresholdMs: 1500,  updateIntervalHours: 24,  autoUpdateOnStart: false,};

async function loadSettings(p: VpnPaths): Promise<VpnSettings> {
  try {
    const raw = await readFile(p.settingsFile, "utf-8");
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<VpnSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function getSecret(p: VpnPaths): Promise<string> {
  try {
    const s = (await readFile(p.secretFile, "utf-8")).trim();
    if (s && s !== "set-your-secret" && s !== "myssr") return s;
  } catch {
    // fall through to generate
  }
  const s = randomBytes(24).toString("hex");
  await mkdir(p.runtimeDir, { recursive: true });
  await writeFile(p.secretFile, s + "\n", "utf-8");
  return s;
}

interface VpnMeta {
  updatedAt?: string;
  sourceFile?: string;
  selector?: string;
  node?: string;  egress?: "pi" | "system";  subscriptionId?: string;  subUpdatedAt?: string;}

async function loadMeta(p: VpnPaths): Promise<VpnMeta> {
  try {
    return JSON.parse(await readFile(p.metaFile, "utf-8")) as VpnMeta;
  } catch {
    return {};
  }
}

async function saveMeta(p: VpnPaths, patch: VpnMeta): Promise<void> {
  await withFileMutationQueue(p.metaFile, async () => {
    let cur: VpnMeta = {};
    try { cur = JSON.parse(await readFile(p.metaFile, "utf-8")) as VpnMeta; } catch { /* fresh or torn file: start over */ }
    const merged = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    await mkdir(p.runtimeDir, { recursive: true });
    const tmp = `${p.metaFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(merged, null, 2), "utf-8");
    await rename(tmp, p.metaFile);
  });
}// ------------------------------------------------- config import & guardrails

/** Find the active subscription cache file from Verge's profiles.yaml. */
async function findVergeCacheFile(): Promise<string | undefined> {
  try {
    const profilesYaml = await readFile(join(VERGE_DATA_DIR, "profiles.yaml"), "utf-8");
    const m = profilesYaml.match(/^\s*current:\s*(\S+)\s*$/m);
    if (!m) return undefined;
    const cache = join(VERGE_DATA_DIR, "profiles", `${m[1]}.yaml`);
    return (await exists(cache)) ? cache : undefined;
  } catch {
    return undefined;
  }
}

/** Replace (or insert) a top-level scalar key in the config head section. */
function setTopLevelKey(head: string, key: string, value: string): string {
  const re = new RegExp(`^${key}:.*$`, "m");
  if (re.test(head)) return head.replace(re, `${key}: ${value}`);
  return head.replace(/\s*$/, "") + `\n${key}: ${value}\n`;
}

/**
 * Build the pi-dedicated config from the Verge subscription cache.
 * Only the head (up to proxies:) is rewritten; proxies/groups/rules
 * pass through byte-for-byte.
 */
/**
 * Build the pi-dedicated config from raw subscription text.
 * Only the head (up to proxies:) is rewritten; proxies/groups/rules
 * pass through byte-for-byte.
 */
function buildConfigFromText(
  raw: string,
  settings: VpnSettings,
  secret: string,
  keepMode?: string,
  redactHost?: string,
): { configText: string; mode: string } {
  const idx = raw.search(/^\s*proxies\s*:/m);
  if (idx < 0) throw new Error("subscription text has no proxies: section.");
  let head = raw.slice(0, idx);
  if (redactHost) {
    head = head.split("\n").filter((l) => !(l.trim().startsWith("#") && l.includes(redactHost))).join("\n");
  }
  const body = raw.slice(idx);

  // Drop keys that would collide with Clash Verge or weaken isolation.
  head = head
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (/^(port|redir-port|tproxy-port|external-ui|external-controller-cors)\s*:/.test(t)) return false;
      if (/^tun\s*:/.test(t)) return false; // stale `tun:` scalar, if any
      return true;
    })
    .join("\n");
  // Drop a tun: block if present.
  head = head.replace(/^tun:\r?$[\s\S]*?(?=^[A-Za-z][\w-]*:)/m, "");

  const mode = keepMode ?? head.match(/^\s*mode\s*:\s*(\S+)\s*$/m)?.[1] ?? "rule";
  head = setTopLevelKey(head, "mixed-port", String(settings.mixedPort));
  head = setTopLevelKey(head, "socks-port", String(settings.socksPort));
  head = setTopLevelKey(head, "allow-lan", "false");
  head = setTopLevelKey(head, "ipv6", "false");
  head = setTopLevelKey(head, "mode", mode);
  head = setTopLevelKey(head, "log-level", "info");
  head = setTopLevelKey(head, "external-controller", `${PI_CONTROLLER_HOST}:${settings.controllerPort}`);
  head = setTopLevelKey(head, "secret", secret);
  head = setTopLevelKey(head, "unified-delay", "true");
  head = setTopLevelKey(head, "tcp-concurrent", "true");
  head = head.replace(/\s*$/, "") + "\n\n";

  return { configText: head + body, mode };
}

async function buildConfigFromCache(
  p: VpnPaths,
  settings: VpnSettings,
  secret: string,
  keepMode?: string,
): Promise<{ configText: string; sourceFile: string; mode: string }> {
  const cache = await findVergeCacheFile();
  if (!cache) {
    throw new Error(
      `No Clash Verge subscription cache found under ${join(VERGE_DATA_DIR, "profiles")}. ` +
        "Open Clash Verge once so it caches the subscription, then retry.",
    );
  }
  const raw = await readFile(cache, "utf-8");
  let redact: string | undefined;
  try { const u = await findVergeSubscriptionUrl(); if (u) redact = new URL(u.url).host; } catch { /* best effort */ }
  const built = buildConfigFromText(raw, settings, secret, keepMode, redact);
  return { ...built, sourceFile: cache };
}

// ------------------------------------------------- subscriptions (self-managed)

/** A VPN subscription stored by the plugin. The URL lives in this local file only — never logged, never sent to the model unmasked. */
interface StoredSubscription {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  addedAt: string;
  updatedAt?: string;
  lastError?: string;
  nodeCount?: number;
}

/** Show protocol+host, mask the token-bearing path: https://host/abc…xyz */
function maskUrl(u: string): string {
  try {
    const parsed = new URL(u);
    const path = parsed.pathname + parsed.search;
    if (path.length <= 12) return `${parsed.protocol}//${parsed.host}${path}`;
    return `${parsed.protocol}//${parsed.host}${path.slice(0, 6)}...${path.slice(-4)}`;
  } catch {
    return "(invalid-url)";
  }
}

function subAge(updatedAt?: string): string {
  if (!updatedAt) return "never";
  const h = Math.max(0, (Date.now() - new Date(updatedAt).getTime()) / 3600000);
  if (h < 1) return "just now";
  if (h < 48) return `${Math.floor(h)}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function loadSubs(p: VpnPaths): Promise<StoredSubscription[]> {
  try {
    const arr = JSON.parse(await readFile(p.subsFile, "utf-8")) as StoredSubscription[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function saveSubs(p: VpnPaths, subs: StoredSubscription[]): Promise<void> {
  await withFileMutationQueue(p.subsFile, async () => {
    await mkdir(p.runtimeDir, { recursive: true });
    const tmp = `${p.subsFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(subs, null, 2), "utf-8");
    await rename(tmp, p.subsFile);
  });
}

async function activeSub(p: VpnPaths): Promise<{ sub?: StoredSubscription; all: StoredSubscription[]; meta: VpnMeta }> {
  const [all, meta] = await Promise.all([loadSubs(p), loadMeta(p)]);
  const sub = all.find((s) => s.id === meta.subscriptionId && s.enabled) ?? all.find((s) => s.enabled);
  return { sub, all, meta };
}

/** Read the active subscription URL out of Clash Verge's own profiles.yaml (local file, never logged). */
async function findVergeSubscriptionUrl(): Promise<{ url: string; name: string } | undefined> {
  try {
    const text = await readFile(join(VERGE_DATA_DIR, "profiles.yaml"), "utf-8");
    const current = text.match(/^\s*current:\s*(\S+)\s*$/m)?.[1];
    if (!current) return undefined;
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.includes(`uid: ${current}`));
    if (at < 0) return undefined;
    let name = "";
    for (const l of lines.slice(at, at + 30)) {
      const nm = l.match(/^\s*name:\s*(\S.*?)\s*$/);
      if (nm && !name) name = nm[1];
      const m = l.match(/^\s*url:\s*(\S+)\s*$/);
      if (m && m[1].startsWith("http")) return { url: m[1], name: name || "verge-import" };
      if (/^\s*-\s*uid:\s*\S/.test(l) && l !== lines[at]) break;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** HTTPS/HTTP GET through an HTTP proxy via CONNECT (node builtins, no deps). Follows redirects. */
async function fetchViaProxy(targetUrl: string, proxyUrl: string, timeoutMs: number, maxRedirects = 3, maxBytes = 8 * 1024 * 1024): Promise<Buffer> {
  const MAX_BYTES = maxBytes;
  const proxy = new URL(proxyUrl);
  const proxyPort = Number(proxy.port || "8080");
  let current = targetUrl;
  for (let redir = 0; redir <= maxRedirects; redir++) {
    const t = new URL(current);
    if (t.protocol !== "http:" && t.protocol !== "https:") throw new Error(`unsupported protocol ${t.protocol}`);
    const destPort = t.port ? Number(t.port) : t.protocol === "https:" ? 443 : 80;
    const out = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
      const timer = setTimeout(() => { try { sock.destroy(); } catch {} done(() => reject(new Error(`proxy fetch timeout after ${timeoutMs}ms`))); }, timeoutMs);
      const sock = connect(proxyPort, proxy.hostname);
      const fail = (e: Error) => done(() => { try { sock.destroy(); } catch {} reject(e); });
      sock.on("error", fail);
      sock.setTimeout(Math.min(timeoutMs, 10000), () => fail(new Error("proxy connect timeout")));
      sock.write(`CONNECT ${t.hostname}:${destPort} HTTP/1.1\r\nHost: ${t.hostname}:${destPort}\r\nProxy-Connection: Keep-Alive\r\n\r\n`);
      let head = Buffer.alloc(0);
      const onHead = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        const statusLine = head.slice(0, head.indexOf("\r\n")).toString("latin1");
        const code = Number(statusLine.split(" ")[1]);
        if (code !== 200) { sock.off("data", onHead); fail(new Error(`proxy CONNECT rejected: ${statusLine}`)); return; }
        sock.off("data", onHead);
        const rest = head.slice(end + 4);
        try { sock.pause(); if (rest.length > 0) (sock as unknown as { unshift: (d: Buffer) => void }).unshift(rest); } catch {}
        const isTls = t.protocol === "https:";
        const lib = isTls ? httpsRequest : httpRequest;
        const req = lib(
          current,
          {
            method: "GET",
            headers: { "User-Agent": "clash-verge/2.0", Accept: "*/*" },
            createConnection: () => (isTls ? tlsConnect({ socket: sock, servername: t.hostname }) : sock),
          } as Record<string, unknown>,
          (res) => {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (c: Buffer) => {
              size += c.length;
              if (size > MAX_BYTES) { try { req.destroy(); } catch {} fail(new Error("subscription body too large (>8MB)")); }
              else chunks.push(c);
            });
            res.on("end", () => done(() => { try { sock.destroy(); } catch {} resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) }); }));
            res.on("error", fail);
          },
        );
        req.on("error", fail);
        req.setTimeout(timeoutMs, () => fail(new Error("request timeout")));
        req.end();
      };
      sock.on("data", onHead);
    });
    if (out.status >= 300 && out.status < 400 && out.headers["location"]) {
      current = new URL(out.headers["location"], current).toString();
      continue;
    }
    if (out.status !== 200) throw new Error(`HTTP ${out.status}: ${out.body.slice(0, 160).toString("utf-8")}`);
    return out.body;
  }
  throw new Error("too many redirects");
}

/** Text wrapper around fetchViaProxy. */
async function fetchViaProxyText(targetUrl: string, proxyUrl: string, timeoutMs: number, maxRedirects = 3): Promise<string> {
  return (await fetchViaProxy(targetUrl, proxyUrl, timeoutMs, maxRedirects)).toString("utf-8");
}

const MIHOMO_VERSION = "v1.19.32";
const MIHOMO_RELEASE_BASE = "https://github.com/MetaCubeX/mihomo/releases/download";

/** Ensure the Mihomo binary exists; auto-download the official build on win32-x64. Returns an error string or undefined. */
async function ensureBinary(p: VpnPaths): Promise<string | undefined> {
  if (await exists(p.binary)) return undefined;
  if (process.platform !== "win32" || process.arch !== "x64") {
    return `No Mihomo binary at ${p.binary} (auto-download supports win32-x64 only; this is ${process.platform}-${process.arch}). Download manually from https://github.com/MetaCubeX/mihomo/releases and place the binary at ${p.binary}.`;
  }
  const asset = `mihomo-windows-amd64-${MIHOMO_VERSION}.zip`;
  const url = `${MIHOMO_RELEASE_BASE}/${MIHOMO_VERSION}/${asset}`;
  await logLine(p, `binary missing, downloading ${url}`);
  const runCurl = (args: string[]): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const ps = spawn("curl.exe", args, { windowsHide: true });
      ps.on("error", reject);
      ps.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`curl.exe exit ${code}`))));
    });
  const zipPath = join(tmpdir(), `mihomo-${Date.now()}.zip`);
  try {
    try {
      await runCurl(["-x", FALLBACK_EGRESS, "-fSL", "--retry", "2", "--max-time", "300", "-o", zipPath, url]);
    } catch {
      await runCurl(["--noproxy", "*", "-fSL", "--retry", "2", "--max-time", "300", "-o", zipPath, url]);
    }
  } catch (e) {
    return `auto-download failed for ${url}: ${(e as Error).message}. curl.exe needs attention or the network is down; place mihomo.exe at ${p.binary} manually.`;
  }
  let zip: Buffer;
  try {
    zip = await readFile(zipPath);
  } catch (e) {
    return `auto-download failed (no file): ${(e as Error).message}`;
  }
  try {
    await mkdir(dirname(p.binary), { recursive: true });
    const workDir = join(tmpdir(), "mihomo-pi-vpn");
    void zip;
    await new Promise<void>((resolve, reject) => {
      const ps = spawn("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -Path ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(workDir)} -Force`], { windowsHide: true });
      ps.on("error", reject);
      ps.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Expand-Archive exit ${code}`))));
    });
    const files = await readdir(workDir);
    const exe = files.find((x) => x.toLowerCase().endsWith(".exe"));
    if (!exe) throw new Error("zip contains no .exe");
    await copyFile(join(workDir, exe), p.binary);
    await rm(zipPath, { force: true });
    await logLine(p, `binary installed at ${p.binary}`);
    return undefined;
  } catch (e) {
    return `auto-download unpack failed: ${(e as Error).message}`;
  }
}

/** Fetch subscription text, preferring the pi sidecar itself, falling back to the system proxy. */
async function fetchSubscriptionText(p: VpnPaths, settings: VpnSettings, url: string, timeoutMs: number): Promise<string> {
  const candidates = [`http://127.0.0.1:${settings.mixedPort}`, FALLBACK_EGRESS];
  const tried: string[] = [];
  for (const proxy of candidates) {
    const port = Number(new URL(proxy).port);
    if (!(await isPortOpen("127.0.0.1", port, 1500))) { tried.push(`${proxy} (closed)`); continue; }
    try {
      return await fetchViaProxyText(url, proxy, timeoutMs);
    } catch (e) {
      tried.push(`${proxy}: ${(e as Error).message}`);
    }
  }
  throw new Error(`fetch failed via all egresses — ${tried.join(" | ")}`);
}

/** The fetched text must look like a Clash YAML with proxies. Returns node names. */
function validateSubscriptionYaml(text: string): { nodeNames: string[] } {
  const idx = text.search(/^\s*proxies\s*:/m);
  if (idx < 0 && !/^\s*proxy-providers\s*:/m.test(text)) {
    throw new Error("not a Clash subscription (no proxies:/proxy-providers: section). Head: " + JSON.stringify(text.slice(0, 120)));
  }
  const names: string[] = [];
  if (idx >= 0) {
    for (const m of text.slice(idx).matchAll(/^\s*-\s*name\s*:\s*(.+?)\s*$/gm)) {
      names.push(m[1].replace(/^['"]|['"]$/g, ""));
      if (names.length >= 5000) break;
    }
    if (names.length === 0) throw new Error("proxies: section has no `- name:` entries.");
  }
  return { nodeNames: names };
}

/**
 * Guardrails for AI hand-edits to config.yaml. Refuse to start when the
 * config would collide with Clash Verge or expose the controller.
 */
function validateConfigText(text: string, settings: VpnSettings): string[] {
  const problems: string[] = [];
  const head = text.slice(0, Math.max(0, text.search(/^\s*proxies\s*:/m)));
  const get = (key: string): string | undefined =>
    head.match(new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)`, "m"))?.[1]?.replace(/['"]/g, "");

  const mixed = Number(get("mixed-port") ?? get("port") ?? NaN);
  const socks = Number(get("socks-port") ?? NaN);
  for (const [name, port] of [
    ["mixed-port", mixed],
    ["socks-port", socks],
  ] as const) {
    if (!Number.isFinite(port)) problems.push(`${name} is missing or not a number.`);
    else if (RESERVED_PORTS.has(port)) problems.push(`${name}=${port} collides with Clash Verge.`);
  }
  if (mixed === settings.mixedPort && socks === settings.socksPort) {
    // expected dedicated ports; fine
  }
  const controller = get("external-controller") ?? "";
  if (!controller) problems.push("external-controller is missing.");
  else if (!controller.startsWith("127.0.0.1:") && !controller.startsWith("localhost:")) {
    problems.push(`external-controller=${controller} must bind 127.0.0.1 only.`);
  } else {
    const cport = Number(controller.split(":").pop());
    if (RESERVED_PORTS.has(cport)) problems.push(`external-controller port ${cport} collides with Clash Verge.`);
  }
  if ((get("allow-lan") ?? "false").toLowerCase() === "true") {
    problems.push("allow-lan must stay false (localhost-only sidecar).");
  }
  const secret = get("secret") ?? "";
  if (!secret || secret === "set-your-secret" || secret === "myssr") {
    problems.push("secret must be a generated value, not a default.");
  }
  if (/^\s*tun:\s*$/m.test(head) && /enable:\s*true/.test(head)) {
    problems.push("tun must stay disabled for the pi sidecar (HTTP/SOCKS only).");
  }
  return problems;
}

async function copyGeoAssets(p: VpnPaths): Promise<string[]> {
  const copied: string[] = [];
  await mkdir(p.runtimeDir, { recursive: true });
  for (const f of GEO_FILES) {
    const src = join(VERGE_DATA_DIR, f);
    const dst = join(p.runtimeDir, f);
    if ((await exists(src)) && !(await exists(dst))) {
      try {
        await copyFile(src, dst);
        copied.push(f);
      } catch {
        // non-fatal; GEOIP rules just won't match until files exist
      }
    }
  }
  return copied;
}

// --------------------------------------------- headless-safe notify (pi-web has no TUI)
function safeNotify(ctx: ExtensionContext, msg: string, level: string = "info"): void {
  try {
    ctx.ui.notify(msg, level);
  } catch {
    // headless/server mode: no UI, tools still work
  }
}

// ------------------------------------------------------- process management

function controllerBase(settings: VpnSettings): string {
  return `http://${PI_CONTROLLER_HOST}:${settings.controllerPort}`;
}

async function apiFetch(
  p: VpnPaths,
  settings: VpnSettings,
  secret: string,
  path: string,
  init?: RequestInit,
  timeoutMs = 8000,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${controllerBase(settings)}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function apiJson<T>(p: VpnPaths, settings: VpnSettings, secret: string, path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  const res = await apiFetch(p, settings, secret, path, init, timeoutMs);
  const body = await res.text(); if (!res.ok) throw new Error(`Mihomo API ${res.status} on ${path}: ${body.slice(0, 200)}`); return (body ? JSON.parse(body) : {}) as T;
}

async function isControllerAlive(p: VpnPaths, settings: VpnSettings, secret: string): Promise<boolean> {
  try {
    await apiJson<{ version: string }>(p, settings, secret, "/version", undefined, 3000);
    return true;
  } catch {
    return false;
  }
}

function isPortOpen(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(port, host);
    const done = (ok: boolean) => {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      resolve(ok);
    };
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

async function readPid(p: VpnPaths): Promise<number | undefined> {
  try {
    const n = Number((await readFile(p.pidFile, "utf-8")).trim());
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killPid(pid: number): Promise<void> {
  if (process.platform === "win32") {
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/F", "/T"], () => resolve());
    });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

async function logLine(p: VpnPaths, line: string): Promise<void> {
  try {
    await appendFile(p.logFile, `[${new Date().toISOString()}] ${line}\n`, "utf-8");
  } catch {
    // logging must never break the extension
  }
}

interface EnsureResult {
  started: boolean; // a new process was spawned
  alive: boolean;
  adopted: boolean; // an existing healthy instance was adopted
  note: string;
}

/** Adopt a healthy instance or spawn a detached sidecar; never throws. */
async function ensureStarted(
  p: VpnPaths,
  settings: VpnSettings,
  secret: string,
  reason: string,
): Promise<EnsureResult> {
  const binErr = await ensureBinary(p);
  if (binErr) {
    return { started: false, alive: false, adopted: false, note: binErr };
  }
  if (await isControllerAlive(p, settings, secret)) {
    return { started: false, alive: true, adopted: true, note: `adopted healthy instance (${reason})` };
  }
  // Stale controller or no process: clear a dead pid file.
  const pid = await readPid(p);
  if (pid !== undefined && !processAlive(pid)) {
    await rm(p.pidFile, { force: true });
  } else if (pid !== undefined && processAlive(pid)) {
    // Process exists but controller not responding yet (starting up?) or wrong secret/port.
    return { started: false, alive: false, adopted: false, note: `pid ${pid} exists but controller is unreachable; check ${p.logFile}` };
  }

  // Fresh config on first run.
  if (!(await exists(p.configFile))) {
    try {
      const built = await buildConfigFromCache(p, settings, secret);
      await mkdir(p.runtimeDir, { recursive: true });
      await writeFile(p.configFile, built.configText, "utf-8");
      await writeFile(p.goodConfigFile, built.configText, "utf-8");
      await saveMeta(p, { sourceFile: built.sourceFile });
      await copyGeoAssets(p);
      await logLine(p, `initial config built from ${built.sourceFile}`);
    } catch (e) {
      return { started: false, alive: false, adopted: false, note: `config build failed: ${(e as Error).message}` };
    }
  }

  // Validate before spawning.
  const problems = validateConfigText(await readFile(p.configFile, "utf-8"), settings);
  if (problems.length > 0) {
    return { started: false, alive: false, adopted: false, note: `config guardrails block start: ${problems.join(" | ")}` };
  }

  await copyGeoAssets(p);
  const logFd = openSync(p.logFile, "a");
  try {
    const child = spawn(p.binary, ["-d", p.runtimeDir, "-f", p.configFile], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    child.unref();
    if (child.pid) await writeFile(p.pidFile, String(child.pid), "utf-8");
    await logLine(p, `spawned pid ${child.pid} (${reason})`);
  } finally {
    try {
      closeSync(logFd);
    } catch {
      // ignore
    }
  }

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isControllerAlive(p, settings, secret)) {
      return { started: true, alive: true, adopted: false, note: "spawned and healthy" };
    }
  }
  return { started: true, alive: false, adopted: false, note: `spawned but controller still unreachable; see ${p.logFile}` };
}

async function stopSidecar(p: VpnPaths): Promise<string> {
  const pid = await readPid(p);
  if (pid === undefined) return "no pid file; nothing to stop";
  if (!processAlive(pid)) {
    await rm(p.pidFile, { force: true });
    return `stale pid ${pid} cleaned up`;
  }
  await killPid(pid);
  await rm(p.pidFile, { force: true });
  await logLine(p, `stopped pid ${pid} on request`);
  await new Promise((r) => setTimeout(r, 1000));
  return `stopped pid ${pid}`;
}

// ------------------------------------------------------------- egress switch

function piProxyUrl(settings: VpnSettings): string {
  return `http://127.0.0.1:${settings.mixedPort}`;
}

async function setEgress(p: VpnPaths, target: "pi" | "system", settings: VpnSettings): Promise<string> {
  const url = target === "pi" ? piProxyUrl(settings) : FALLBACK_EGRESS;
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    process.env[k] = url;
  }
  process.env.NO_PROXY = "localhost,127.0.0.1,::1";
  process.env.no_proxy = "localhost,127.0.0.1,::1";
  const meta = await loadMeta(p);
  await saveMeta(p, { ...meta, egress: target });
  await logLine(p, `egress -> ${target} (${url})`);
  return url;
}// ------------------------------------------------------------------ mihomo data

interface ProxyNode {
  name: string;
  type?: string;
  now?: string;
  all?: string[];
}

interface ProxiesResponse {
  proxies: Record<string, ProxyNode>;
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  return { content: [{ type: "text", text }], details: {} };
}

async function getSelectorState(
  p: VpnPaths,
  settings: VpnSettings,
  secret: string,
): Promise<{ mode: string; selectors: Array<{ name: string; now: string; count: number }>; version: string }> {
  const [cfg, proxies, ver] = await Promise.all([
    apiJson<{ mode: string }>(p, settings, secret, "/configs"),
    apiJson<ProxiesResponse>(p, settings, secret, "/proxies"),
    apiJson<{ version: string }>(p, settings, secret, "/version"),
  ]);
  const selectors: Array<{ name: string; now: string; count: number }> = [];
  for (const [name, node] of Object.entries(proxies.proxies)) {
    if (node.all && node.now !== undefined) {
      selectors.push({ name, now: node.now, count: node.all.length });
    }
  }
  selectors.sort((a, b) => a.name.localeCompare(b.name));
  return { mode: cfg.mode, selectors, version: ver.version };
}

function mainSelector(selectors: Array<{ name: string; now: string; count: number }>): { name: string; now: string; count: number } {
  return selectors.find((s) => s.name === "Proxy") ?? selectors[0];
}

function findNodes(all: string[], query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, limit);
  const starts: string[] = [];
  const contains: string[] = [];
  for (const n of all) {
    const l = n.toLowerCase();
    if (l === q) return [n];
    if (l.startsWith(q)) starts.push(n);
    else if (l.includes(q)) contains.push(n);
    if (starts.length + contains.length >= limit * 3) break;
  }
  return [...starts, ...contains].slice(0, limit);
}

async function statusCard(p: VpnPaths, settings: VpnSettings, secret: string): Promise<string> {
  const alive = await isControllerAlive(p, settings, secret);
  const lines = [
    `pi-vpn sidecar: ${alive ? "RUNNING" : "STOPPED"}`,
    `mixed: 127.0.0.1:${settings.mixedPort}  socks: 127.0.0.1:${settings.socksPort}  api: 127.0.0.1:${settings.controllerPort}`,
    `egress env: ${process.env.HTTP_PROXY ?? process.env.http_proxy ?? "(unset)"}`,
    `config: ${p.configFile} (AI-editable, guarded; use vpn_reload after edits)`,
  ];
  if (!alive) {
    lines.push("Use vpn_start (or /vpn) to start. Clash Verge on :7890 is untouched.");
    return lines.join("\n");
  }
  try {
    const st = await getSelectorState(p, settings, secret);
    const main = mainSelector(st.selectors);
    lines.splice(1, 0, `core: ${st.version}  mode: ${st.mode}`);
    lines.push(`selector: ${main.name} -> ${main.now} (${main.count} nodes)`);
    for (const s of st.selectors.filter((x) => x.name !== main.name).slice(0, 6)) {
      lines.push(`  ${s.name} -> ${s.now} (${s.count})`);
    }
  } catch (e) {
    lines.push(`controller reachable but query failed: ${(e as Error).message}`);
  }
  try {
    const { sub } = await activeSub(p);
    const m = await loadMeta(p);
    lines.push(sub ? `sub: ${sub.name} ${maskUrl(sub.url)} - updated ${subAge(sub.updatedAt)} - ${sub.nodeCount ?? "?"} nodes` + (m.subscriptionId === sub.id ? "" : " (not active)") : "sub: none stored (using Clash Verge cache fallback)");
  } catch {
    // sub info is best-effort
  }
  return lines.join("\n");
}

async function delayTest(
  p: VpnPaths,
  settings: VpnSettings,
  secret: string,
  nodeName: string,
  url: string,
  timeoutMs: number,
): Promise<number | undefined> {
  try {
    const r = await apiJson<{ delay?: number }>(
      p,
      settings,
      secret,
      `/proxies/${encodeURIComponent(nodeName)}/delay?timeout=${timeoutMs}&url=${encodeURIComponent(url)}`,
      undefined,
      timeoutMs + 3000,
    );
    return typeof r.delay === "number" && r.delay > 0 ? r.delay : undefined;
  } catch {
    return undefined;
  }
}

function setStatusBar(ctx: ExtensionContext, text: string): void {
  try {
    ctx.ui.setStatus(EXT_NAME, text);
  } catch {
    // non-TUI modes have no status bar
  }
}

async function refreshStatusBar(ctx: ExtensionContext, p: VpnPaths, settings: VpnSettings, secret: string): Promise<void> {
  try {
    if (!(await isControllerAlive(p, settings, secret))) {
      setStatusBar(ctx, ctx.ui.theme.fg("dim", "VPN: off"));
      return;
    }
    const st = await getSelectorState(p, settings, secret);
    const main = mainSelector(st.selectors);
    setStatusBar(ctx, ctx.ui.theme.fg("accent", `VPN ${main.now}`) + ctx.ui.theme.fg("dim", ` · ${st.mode}`));
  } catch {
    // status bar must never break the session
  }
}
/** Host part of a URL (for token redaction); undefined on failure. */
function hostOf(u?: string): string | undefined {
  if (!u) return undefined;
  try { return new URL(u).host; } catch { return undefined; }
}

/** Refresh nodes from the active stored subscription (or Verge cache fallback). Returns a report. */
async function refreshNodesFromActive(p: VpnPaths, settings: VpnSettings, secret: string, reason: string): Promise<string> {
  const { sub, meta } = await activeSub(p);
  let mode = "rule";
  try {
    mode = (await apiJson<{ mode: string }>(p, settings, secret, "/configs")).mode;
  } catch {
    // sidecar down; fall back to default
  }
  let raw: string;
  let sourceLabel: string;
  let subId: string | undefined;
  if (sub) {
    sourceLabel = `subscription ${sub.name} (${maskUrl(sub.url)})`;
    subId = sub.id;
    try {
      raw = await fetchSubscriptionText(p, settings, sub.url, 25000);
    } catch (e) {
      const all = await loadSubs(p);
      const entry = all.find((s) => s.id === sub.id);
      if (entry) { entry.lastError = (e as Error).message; await saveSubs(p, all); }
      await logLine(p, `update FAILED from ${maskUrl(sub.url)}: ${(e as Error).message}`);
      return `vpn_update: fetch failed for ${sourceLabel}: ${(e as Error).message}\nRunning instance untouched.`;
    }
    try {
      validateSubscriptionYaml(raw);
    } catch (e) {
      await logLine(p, `update FAILED parse from ${maskUrl(sub.url)}: ${(e as Error).message}`);
      return `vpn_update: ${sourceLabel} did not parse: ${(e as Error).message}\nRunning instance untouched.`;
    }
  } else {
    const cache = await findVergeCacheFile();
    if (!cache) return "vpn_update: no stored subscription and no Verge cache. Add one: vpn_sub_add {url} or {fromVerge:true}.";
    raw = await readFile(cache, "utf-8");
    sourceLabel = `Verge cache`;
  }
  let built: { configText: string; mode: string };
  try {
    built = buildConfigFromText(raw, settings, secret, mode, hostOf(sub?.url));
  } catch (e) {
    return `vpn_update: rebuild failed: ${(e as Error).message}`;
  }
  await writeFile(p.configFile, built.configText, "utf-8");
  await writeFile(p.goodConfigFile, built.configText, "utf-8");
  await copyGeoAssets(p);
  await stopSidecar(p);
  const r = await ensureStarted(p, settings, secret, reason);
  let restored = "";
  const prevNode = meta.node;
  if (r.alive && prevNode) {
    try {
      const names = validateSubscriptionYaml(raw).nodeNames;
      const sel = meta.selector ?? "Proxy";
      if (names.includes(prevNode)) {
        const proxies = await apiJson<ProxiesResponse>(p, settings, secret, "/proxies");
        if (proxies.proxies[sel]?.all?.includes(prevNode)) {
          await apiJson(p, settings, secret, `/proxies/${encodeURIComponent(sel)}`, {
            method: "PUT",
            body: JSON.stringify({ name: prevNode }),
          });
          restored = `\nrestored selection: ${sel} -> ${prevNode}`;
        }
      } else {
        restored = `\nprevious node '${prevNode}' gone after update; kept subscription default`;
      }
    } catch {
      // non-fatal
    }
  }
  const nowIso = new Date().toISOString();
  if (subId) {
    const all = await loadSubs(p);
    const entry = all.find((s) => s.id === subId);
    if (entry) {
      entry.updatedAt = nowIso;
      entry.lastError = undefined;
      try { entry.nodeCount = validateSubscriptionYaml(raw).nodeNames.length; } catch { /* keep old */ }
      await saveSubs(p, all);
    }
    await saveMeta(p, { ...(await loadMeta(p)), subscriptionId: subId, subUpdatedAt: nowIso, sourceFile: `subscription:${subId}` });
  } else {
    await saveMeta(p, { ...(await loadMeta(p)), sourceFile: (await findVergeCacheFile()) ?? meta.sourceFile });
  }
  await logLine(p, `update from ${sub ? maskUrl(sub.url) : sourceLabel}: ${r.note}`);
  return `vpn_update from ${sourceLabel}: ${r.note}${restored}\n${await statusCard(p, settings, secret)}`;
}

// ------------------------------------------------------------ extension setup

export default function (pi: ExtensionAPI) {
  const paths = getPaths();

  const ctxOf = async (): Promise<{ settings: VpnSettings; secret: string }> => {
    const settings = await loadSettings(paths);
    const secret = await getSecret(paths);
    return { settings, secret };
  };

  // ---------------------------------------------------------- model tools

  pi.registerTool({
    name: "vpn_status",
    label: "VPN status",
    description: "Show the pi-vpn dedicated Mihomo sidecar status: running state, ports, mode, current node, egress env.",
    parameters: Type.Object({}),
    async execute() {
      const { settings, secret } = await ctxOf();
      return textResult(await statusCard(paths, settings, secret));
    },
  });

  pi.registerTool({
    name: "vpn_start",
    label: "VPN start",
    description: "Start the pi-vpn dedicated Mihomo sidecar (adopts it if already healthy). Does not touch Clash Verge.",
    parameters: Type.Object({}),
    async execute() {
      const { settings, secret } = await ctxOf();
      const r = await ensureStarted(paths, settings, secret, "vpn_start");
      if (r.alive && settings.autoUse) await setEgress(paths, "pi", settings);
      return textResult(`vpn_start: ${r.note}\n${await statusCard(paths, settings, secret)}`);
    },
  });

  pi.registerTool({
    name: "vpn_stop",
    label: "VPN stop",
    description: "Stop the pi-vpn sidecar and fall back to the system proxy (Clash Verge :7890).",
    parameters: Type.Object({}),
    async execute() {
      const { settings } = await ctxOf();
      const msg = await stopSidecar(paths);
      const url = await setEgress(paths, "system", settings);
      return textResult(`vpn_stop: ${msg}\negress fallback -> ${url}`);
    },
  });

  pi.registerTool({
    name: "vpn_restart",
    label: "VPN restart",
    description: "Restart the pi-vpn sidecar.",
    parameters: Type.Object({}),
    async execute() {
      const { settings, secret } = await ctxOf();
      const stopped = await stopSidecar(paths);
      const r = await ensureStarted(paths, settings, secret, "vpn_restart");
      return textResult(`stopped: ${stopped}\nrestart: ${r.note}\n${await statusCard(paths, settings, secret)}`);
    },
  });

  pi.registerTool({
    name: "vpn_proxies",
    label: "VPN list proxies",
    description: "List proxy selector groups with current selection and node counts. Pass group to list its nodes (truncated).",
    parameters: Type.Object({
      group: Type.Optional(Type.String({ description: "Selector group name, e.g. Proxy" })),
    }),
    async execute(_id, params) {
      const { settings, secret } = await ctxOf();
      if (!(await isControllerAlive(paths, settings, secret))) return textResult("sidecar not running; use vpn_start first.");
      const st = await getSelectorState(paths, settings, secret);
      if (!params.group) {
        return textResult(
          [`mode: ${st.mode}`, ...st.selectors.map((s) => `${s.name} -> ${s.now} (${s.count} nodes)`)].join("\n"),
        );
      }
      const proxies = await apiJson<ProxiesResponse>(paths, settings, secret, "/proxies");
      const node = proxies.proxies[params.group];
      if (!node?.all) return textResult(`group '${params.group}' not found. Groups: ${st.selectors.map((s) => s.name).join(", ")}`);
      return textResult(
        [`${params.group} -> ${node.now} (${node.all.length} nodes):`, ...node.all.slice(0, 60).map((n) => `  ${n === node.now ? "*" : "-"} ${n}`)].join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "vpn_switch",
    label: "VPN switch node",
    description: "Switch the exit node. Query fuzzy-matches node names in a selector group (default: Proxy). Ambiguous queries return candidates instead of switching.",
    parameters: Type.Object({
      query: Type.String({ description: "Node name or keyword, e.g. '台湾 Premium 04' or '香港'" }),
      group: Type.Optional(Type.String({ description: "Selector group, default Proxy" })),
    }),
    async execute(_id, params) {
      const { settings, secret } = await ctxOf();
      if (!(await isControllerAlive(paths, settings, secret))) return textResult("sidecar not running; use vpn_start first.");
      const group = params.group ?? "Proxy";
      const proxies = await apiJson<ProxiesResponse>(paths, settings, secret, "/proxies");
      const node = proxies.proxies[group];
      if (!node?.all) return textResult(`group '${group}' not found.`);
      const hits = findNodes(node.all, params.query, 8);
      if (hits.length === 0) return textResult(`no node matches '${params.query}' in ${group} (${node.all.length} nodes).`);
      if (hits.length > 1 && hits[0].toLowerCase() !== params.query.trim().toLowerCase()) {
        return textResult(`ambiguous '${params.query}' in ${group}, candidates:\n${hits.map((h) => `  - ${h}`).join("\n")}\nRe-run vpn_switch with the exact name.`);
      }
      const target = hits[0];
      await apiJson(paths, settings, secret, `/proxies/${encodeURIComponent(group)}`, {
        method: "PUT",
        body: JSON.stringify({ name: target }),
      });
      const delay = await delayTest(paths, settings, secret, target, settings.testUrl, settings.testTimeoutMs);
      const meta = await loadMeta(paths);
      await saveMeta(paths, { ...meta, selector: group, node: target });
      await logLine(paths, `switch ${group} -> ${target} (${delay ?? "timeout"}ms)`);
      return textResult(`switched ${group} -> ${target} [delay ${delay !== undefined ? `${delay}ms` : `timeout>${settings.testTimeoutMs}ms`}]\n${delay !== undefined && delay > settings.delayThresholdMs ? `Note: above ${settings.delayThresholdMs}ms threshold; consider another node.` : "OK"}`);
    },
  });

  pi.registerTool({
    name: "vpn_speedtest",
    label: "VPN speedtest",
    description: "Latency-test nodes in a selector group and rank them. Optionally switch to the fastest with apply_best.",
    parameters: Type.Object({
      group: Type.Optional(Type.String({ description: "Selector group, default Proxy" })),
      limit: Type.Optional(Type.Number({ description: "Max nodes to test (default 8, max 20)" })),
      timeout_ms: Type.Optional(Type.Number({ description: "Per-node timeout ms (default 5000)" })),
      apply_best: Type.Optional(Type.Boolean({ description: "Switch to the fastest node" })),
    }),
    async execute(_id, params) {
      const { settings, secret } = await ctxOf();
      if (!(await isControllerAlive(paths, settings, secret))) return textResult("sidecar not running; use vpn_start first.");
      const group = params.group ?? "Proxy";
      const limit = Math.min(Math.max(params.limit ?? 8, 1), 20);
      const timeout = params.timeout_ms ?? settings.testTimeoutMs;
      const proxies = await apiJson<ProxiesResponse>(paths, settings, secret, "/proxies");
      const node = proxies.proxies[group];
      if (!node?.all) return textResult(`group '${group}' not found.`);
      const current = node.now;
      const candidates = [current, ...node.all.filter((n) => n !== current)].slice(0, limit);
      const results: Array<{ name: string; delay?: number }> = [];
      for (const n of candidates) {
        results.push({ name: n, delay: await delayTest(paths, settings, secret, n, settings.testUrl, timeout) });
      }
      results.sort((a, b) => (a.delay ?? Number.MAX_SAFE_INTEGER) - (b.delay ?? Number.MAX_SAFE_INTEGER));
      const lines = results.map((r, i) => `${i + 1}. ${r.name}${r.name === current ? " (current)" : ""} — ${r.delay !== undefined ? `${r.delay}ms` : "timeout"}`);
      if (params.apply_best && results[0]?.delay !== undefined) {
        await apiJson(paths, settings, secret, `/proxies/${encodeURIComponent(group)}`, {
          method: "PUT",
          body: JSON.stringify({ name: results[0].name }),
        });
        const meta = await loadMeta(paths);
        await saveMeta(paths, { ...meta, selector: group, node: results[0].name });
        lines.push(`switched ${group} -> ${results[0].name}`);
      }
      return textResult(`speedtest ${group} (${candidates.length} nodes, ${settings.testUrl}):\n${lines.join("\n")}`);
    },
  });

  pi.registerTool({
    name: "vpn_health",
    label: "VPN health check",
    description: "Check sidecar health: controller, core version, mode, current node delay, mixed-port reachability, and direct-vs-proxy comparison.",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "URL to probe (default google generate_204)" })),
    }),
    async execute(_id, params) {
      const { settings, secret } = await ctxOf();
      const url = params.target ?? settings.testUrl;
      const lines: string[] = [];
      const alive = await isControllerAlive(paths, settings, secret);
      lines.push(`controller 127.0.0.1:${settings.controllerPort}: ${alive ? "OK" : "UNREACHABLE"}`);
      if (!alive) {
        lines.push("Run vpn_start. Clash Verge (:7890) is a separate process and unaffected.");
        return textResult(lines.join("\n"));
      }
      const st = await getSelectorState(paths, settings, secret);
      const main = mainSelector(st.selectors);
      lines.push(`core: ${st.version}  mode: ${st.mode}`);
      lines.push(`node: ${main.name} -> ${main.now}`);
      const d = await delayTest(paths, settings, secret, main.now, url, settings.testTimeoutMs);
      lines.push(`proxy delay to ${url}: ${d !== undefined ? `${d}ms` : `TIMEOUT>${settings.testTimeoutMs}ms`} (threshold ${settings.delayThresholdMs}ms)`);
      lines.push(`mixed-port 127.0.0.1:${settings.mixedPort}: ${(await isPortOpen("127.0.0.1", settings.mixedPort)) ? "OPEN" : "CLOSED"}`);
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(t);
        lines.push(`direct fetch (no proxy): HTTP ${res.status} — reachable without VPN`);
      } catch {
        lines.push("direct fetch (no proxy): FAILED — expected behind GFW, proxy is required");
      }
      if (d === undefined || d > settings.delayThresholdMs) {
        lines.push("Advice: run vpn_speedtest + vpn_switch to pick a faster node.");
      }
      return textResult(lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "vpn_mode",
    label: "VPN mode",
    description: "Get or set the Mihomo mode (rule|global|direct). Default and recommended: rule.",
    parameters: Type.Object({
      mode: Type.Optional(Type.String({ description: "rule, global or direct; omit to only report" })),
    }),
    async execute(_id, params) {
      const { settings, secret } = await ctxOf();
      if (!(await isControllerAlive(paths, settings, secret))) return textResult("sidecar not running; use vpn_start first.");
      if (!params.mode) {
        const cfg = await apiJson<{ mode: string }>(paths, settings, secret, "/configs");
        return textResult(`mode: ${cfg.mode}`);
      }
      const mode = params.mode.toLowerCase();
      if (!["rule", "global", "direct"].includes(mode)) return textResult(`invalid mode '${params.mode}'; use rule|global|direct`);
      await apiJson(paths, settings, secret, "/configs", { method: "PATCH", body: JSON.stringify({ mode }) });
      await logLine(paths, `mode -> ${mode}`);
      return textResult(`mode -> ${mode}`);
    },
  });

  pi.registerTool({
    name: "vpn_use",
    label: "VPN choose egress",
    description: "Choose which egress new processes use: 'pi' (dedicated sidecar) or 'system' (Clash Verge :7890). For provider (model) traffic to follow, also set settings.json httpProxy to the same URL and /reload.",
    parameters: Type.Object({
      target: Type.String({ description: "'pi' or 'system'" }),
    }),
    async execute(_id, params) {
      const { settings } = await ctxOf();
      const t = params.target.toLowerCase();
      if (t !== "pi" && t !== "system") return textResult("target must be 'pi' or 'system'");
      const url = await setEgress(paths, t, settings);
      return textResult(
        `egress -> ${t} (${url})\nNote: model provider traffic follows settings.json httpProxy (currently independent of this switch); run /vpn to see both. Set "httpProxy": "${url}" in ~/.pi/agent/settings.json + /reload for full cutover.`,
      );
    },
  });

pi.registerTool({
    name: "vpn_update",
    label: "VPN update nodes",
    description: "Refresh nodes from the ACTIVE stored subscription (falls back to Clash Verge cache when none stored): fetch, validate, rebuild, restart, restore selection. Run when nodes widely fail or the sub is stale.",
    parameters: Type.Object({}),
    async execute() {
      const { settings, secret } = await ctxOf();
      return textResult(await refreshNodesFromActive(paths, settings, secret, "vpn_update"));
    },
  });

  pi.registerTool({
    name: "vpn_sub_add",
    label: "VPN add subscription",
    description: "Store a subscription URL ({url}) or import the active Clash Verge one ({fromVerge:true}). Verifies by fetching through the sidecar, then rebuilds and restarts immediately. URLs stay in local subscriptions.json and are always shown masked.",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "Subscription URL (http/https Clash YAML)" })),
      fromVerge: Type.Optional(Type.Boolean({ description: "Import the active Clash Verge subscription URL" })),
      name: Type.Optional(Type.String({ description: "Display name" })),
    }),
    async execute(_id, params) {
      const { settings, secret } = await ctxOf();
      let url = params.url?.trim();
      let name = params.name?.trim() || "";
      if (params.fromVerge) {
        const found = await findVergeSubscriptionUrl();
        if (!found) return textResult("no subscription URL found in Clash Verge profiles.yaml.");
        url = found.url;
        if (!name) name = found.name;
      }
      if (!url || !/^https?:\/\//i.test(url)) return textResult("provide {url:'https://...'} or {fromVerge:true}.");
      if (!name) { try { name = new URL(url).host; } catch { name = "subscription"; } }
      let raw: string;
      try {
        raw = await fetchSubscriptionText(paths, settings, url, 25000);
      } catch (e) {
        return textResult(`verify failed for ${maskUrl(url)}: ${(e as Error).message}\nNot stored. Check the URL and egress, then retry.`);
      }
      let nodeCount = 0;
      try {
        nodeCount = validateSubscriptionYaml(raw).nodeNames.length;
      } catch (e) {
        return textResult(`verify failed: content from ${maskUrl(url)} did not parse: ${(e as Error).message}\nNot stored.`);
      }
      let mode = "rule";
      try { mode = (await apiJson<{ mode: string }>(paths, settings, secret, "/configs")).mode; } catch { /* keep default */ }
      const built = buildConfigFromText(raw, settings, secret, mode, hostOf(url));
      await writeFile(paths.configFile, built.configText, "utf-8");
      await writeFile(paths.goodConfigFile, built.configText, "utf-8");
      await copyGeoAssets(paths);
      await stopSidecar(paths);
      const r = await ensureStarted(paths, settings, secret, "vpn_sub_add");
      const all = await loadSubs(paths);
      const dup = all.find((s) => s.url === url);
      const id = dup?.id ?? `sub-${randomBytes(3).toString("hex")}`;
      const nowIso = new Date().toISOString();
      const entry: StoredSubscription = {
        id, name, url, enabled: true,
        addedAt: dup?.addedAt ?? nowIso,
        updatedAt: nowIso, nodeCount,
      };
      await saveSubs(paths, [...all.filter((s) => s.id !== id), entry]);
      const meta = await loadMeta(paths);
      if (!meta.subscriptionId) await saveMeta(paths, { ...meta, subscriptionId: id, subUpdatedAt: nowIso, sourceFile: `subscription:${id}` });
      await logLine(paths, `sub_add ${name} ${maskUrl(url)} (${nodeCount} nodes): ${r.note}`);
      return textResult(`stored subscription ${name} (${maskUrl(url)}): ${nodeCount} nodes, sidecar ${r.note}\n${await statusCard(paths, settings, secret)}`);
    },
  });

  pi.registerTool({
    name: "vpn_sub_list",
    label: "VPN list subscriptions",
    description: "List stored subscriptions (URLs masked) with active marker, age and node counts.",
    parameters: Type.Object({}),
    async execute() {
      const { sub, all, meta } = await activeSub(paths);
      if (all.length === 0) return textResult("no subscriptions stored. Add one: vpn_sub_add {url} or {fromVerge:true}. Without one, vpn_update falls back to the Clash Verge cache.");
      const activeId = meta.subscriptionId ?? sub?.id;
      return textResult(all.map((s) => `${activeId === s.id ? "*" : "-"} ${s.id} ${s.name} ${maskUrl(s.url)} - ${s.enabled ? "enabled" : "disabled"} - updated ${subAge(s.updatedAt)} - ${s.nodeCount ?? "?"} nodes${s.lastError ? ` - lastError: ${s.lastError.slice(0, 120)}` : ""}`).join("\n"));
    },
  });

  pi.registerTool({
    name: "vpn_sub_use",
    label: "VPN use subscription",
    description: "Set the active subscription by id (see vpn_sub_list). Run vpn_update afterwards to fetch and apply it.",
    parameters: Type.Object({
      id: Type.String({ description: "Subscription id" }),
    }),
    async execute(_id, params) {
      const all = await loadSubs(paths);
      const found = all.find((s) => s.id === params.id);
      if (!found) return textResult(`unknown id '${params.id}'. See vpn_sub_list.`);
      if (!found.enabled) return textResult(`subscription ${found.name} is disabled.`);
      const meta = await loadMeta(paths);
      await saveMeta(paths, { ...meta, subscriptionId: found.id });
      return textResult(`active subscription -> ${found.name} (${maskUrl(found.url)}). Run vpn_update to fetch and apply.`);
    },
  });

  pi.registerTool({
    name: "vpn_sub_remove",
    label: "VPN remove subscription",
    description: "Remove a stored subscription by id. The sidecar keeps running on its current config; vpn_update then falls back to another stored subscription or the Verge cache.",
    parameters: Type.Object({
      id: Type.String({ description: "Subscription id" }),
    }),
    async execute(_id, params) {
      const all = await loadSubs(paths);
      if (!all.some((s) => s.id === params.id)) return textResult(`unknown id '${params.id}'.`);
      await saveSubs(paths, all.filter((s) => s.id !== params.id));
      const meta = await loadMeta(paths);
      if (meta.subscriptionId === params.id) await saveMeta(paths, { ...meta, subscriptionId: undefined });
      await logLine(paths, `sub_remove ${params.id}`);
      return textResult(`removed ${params.id}.`);
    },
  });

  pi.registerTool({
    name: "vpn_reload",
    label: "VPN reload config",
    description: "Restart the sidecar to apply hand-edits made to config.yaml. Guardrails are validated first; on failure the last-good config is restored and the running instance is kept.",
    parameters: Type.Object({}),
    async execute() {
      const { settings, secret } = await ctxOf();
      let text: string;
      try {
        text = await readFile(paths.configFile, "utf-8");
      } catch {
        return textResult(`config not found at ${paths.configFile}; run vpn_start to generate it.`);
      }
      const problems = validateConfigText(text, settings);
      if (problems.length > 0) {
        return textResult(`config rejected, instance untouched:\n- ${problems.join("\n- ")}\nFix ${paths.configFile} and retry vpn_reload.`);
      }
      await stopSidecar(paths);
      const r = await ensureStarted(paths, settings, secret, "vpn_reload");
      if (r.alive) {
        await writeFile(paths.goodConfigFile, text, "utf-8");
        return textResult(`reloaded OK: ${r.note}\n${await statusCard(paths, settings, secret)}`);
      }
      try {
        const good = await readFile(paths.goodConfigFile, "utf-8");
        await writeFile(paths.configFile, good, "utf-8");
        const r2 = await ensureStarted(paths, settings, secret, "vpn_reload-rollback");
        return textResult(`reload failed (${r.note}); rolled back to last-good config: ${r2.note}`);
      } catch (e) {
        return textResult(`reload failed (${r.note}) and rollback failed: ${(e as Error).message}`);
      }
    },
  });

  // ---------------------------------------------------------- slash commands

  pi.registerCommand("vpn", {
    description: "Show pi-vpn sidecar status (dedicated Mihomo for Pi)",
    handler: async (_args, ctx) => {
      const { settings, secret } = await ctxOf();
      safeNotify(ctx, await statusCard(paths, settings, secret), "info");
      await refreshStatusBar(ctx, paths, settings, secret);
    },
  });

  pi.registerCommand("vpn-switch", {
    description: "Switch exit node: /vpn-switch <keyword>",
    handler: async (args, ctx) => {
      const { settings, secret } = await ctxOf();
      if (!args.trim()) {
        safeNotify(ctx, "Usage: /vpn-switch <keyword>  (e.g. /vpn-switch 台湾)", "warning");
        return;
      }
      if (!(await isControllerAlive(paths, settings, secret))) {
        safeNotify(ctx, "sidecar not running; starting…", "info");
        const r = await ensureStarted(paths, settings, secret, "/vpn-switch");
        if (!r.alive) {
          safeNotify(ctx, `start failed: ${r.note}`, "error");
          return;
        }
      }
      const proxies = await apiJson<ProxiesResponse>(paths, settings, secret, "/proxies");
      const node = proxies.proxies["Proxy"];
      if (!node?.all) {
        safeNotify(ctx, "Proxy group not found", "error");
        return;
      }
      const hits = findNodes(node.all, args, 8);
      if (hits.length === 0) {
        safeNotify(ctx, `no node matches '${args}'`, "warning");
        return;
      }
      const target = hits[0];
      await apiJson(paths, settings, secret, "/proxies/Proxy", { method: "PUT", body: JSON.stringify({ name: target }) });
      const delay = await delayTest(paths, settings, secret, target, settings.testUrl, settings.testTimeoutMs);
      const meta = await loadMeta(paths);
      await saveMeta(paths, { ...meta, selector: "Proxy", node: target });
      safeNotify(ctx, `Proxy -> ${target} [${delay !== undefined ? `${delay}ms` : "timeout"}]`, "info");
      await refreshStatusBar(ctx, paths, settings, secret);
    },
  });

  pi.registerCommand("netcheck", {
    description: "One-shot network diagnosis: sidecar, node delay, ports, direct-vs-proxy",
    handler: async (args, ctx) => {
      const { settings, secret } = await ctxOf();
      const url = args.trim() || settings.testUrl;
      const lines: string[] = [];
      const alive = await isControllerAlive(paths, settings, secret);
      lines.push(`sidecar: ${alive ? "RUNNING" : "STOPPED"} (api 127.0.0.1:${settings.controllerPort})`);
      if (alive) {
        const st = await getSelectorState(paths, settings, secret);
        const main = mainSelector(st.selectors);
        const d = await delayTest(paths, settings, secret, main.now, url, settings.testTimeoutMs);
        lines.push(`mode=${st.mode} node=${main.now} delay=${d !== undefined ? `${d}ms` : "TIMEOUT"}`);
      }
      lines.push(`egress env=${process.env.HTTP_PROXY ?? process.env.http_proxy ?? "(unset)"}`);
      safeNotify(ctx, lines.join("\n"), alive ? "info" : "warning");
      await refreshStatusBar(ctx, paths, settings, secret);
    },
  });

  pi.registerCommand("vpn-update", {
    description: "Re-import proxies from Clash Verge cache and restart sidecar",
    handler: async (_args, ctx) => {
      safeNotify(ctx, "re-importing proxies from Clash Verge cache…", "info");
      const { settings, secret } = await ctxOf();
      const meta = await loadMeta(paths);
      let mode = "rule";
      try {
        mode = (await apiJson<{ mode: string }>(paths, settings, secret, "/configs")).mode;
      } catch {
        // ignore
      }
      try {
        const built = await buildConfigFromCache(paths, settings, secret, mode);
        await writeFile(paths.configFile, built.configText, "utf-8");
        await writeFile(paths.goodConfigFile, built.configText, "utf-8");
      } catch (e) {
        safeNotify(ctx, `vpn-update failed: ${(e as Error).message}`, "error");
        return;
      }
      await stopSidecar(paths);
      const r = await ensureStarted(paths, settings, secret, "/vpn-update");
      safeNotify(ctx, `vpn-update: ${r.note}`, r.alive ? "info" : "error");
      await saveMeta(paths, { ...(await loadMeta(paths)), sourceFile: (await findVergeCacheFile()) ?? meta.sourceFile });
      await refreshStatusBar(ctx, paths, settings, secret);
    },
  });

  // ---------------------------------------------------------- lifecycle

  pi.on("session_start", async (_event, ctx) => {
    const { settings, secret } = await ctxOf();
    await mkdir(paths.runtimeDir, { recursive: true });
    if (!settings.autoStart) {
      setStatusBar(ctx, ctx.ui.theme.fg("dim", "VPN: manual"));
      return;
    }
    const r = await ensureStarted(paths, settings, secret, "session_start");
    if (!r.alive) {
      safeNotify(ctx, `pi-vpn: ${r.note} (continuing on system proxy :7890)`, "warning");
      setStatusBar(ctx, ctx.ui.theme.fg("dim", "VPN: off"));
      return;
    }
    if (settings.autoUse) {
      await setEgress(paths, "pi", settings);
    }
    if (r.started) safeNotify(ctx, `pi-vpn sidecar started (${r.note})`, "info");
    if (r.alive && settings.autoUpdateOnStart) {
      try {
        const { sub: stSub } = await activeSub(paths);
        const ageH = stSub?.updatedAt ? (Date.now() - new Date(stSub.updatedAt).getTime()) / 3600000 : 1e9;
        if (stSub && ageH > settings.updateIntervalHours) {
          safeNotify(ctx, `pi-vpn: subscription ${stSub.name} is ${subAge(stSub.updatedAt)} old, refreshing...`, "info");
          const rep = await refreshNodesFromActive(paths, settings, secret, "session_start-auto");
          safeNotify(ctx, rep.slice(0, 600), r.alive ? "info" : "warning");
        }
      } catch (e) {
        safeNotify(ctx, `pi-vpn auto-update skipped: ${(e as Error).message}`.slice(0, 300), "warning");
      }
    }
    await refreshStatusBar(ctx, paths, settings, secret);
  });

  // The sidecar is intentionally a persistent user-level daemon (detached +
  // pid file) so Pi restarts and /reload do not drop connections. It is
  // stopped only via vpn_stop or /vpn … stop. No session_shutdown hook.

  pi.on("before_agent_start", async (event) => {
    try {
      const { settings, secret } = await ctxOf();
      if (!(await isControllerAlive(paths, settings, secret))) return;
      const st = await getSelectorState(paths, settings, secret);
      const main = mainSelector(st.selectors);
      const extra = [
        "",
        "[pi-vpn] Dedicated egress: HTTP/SOCKS http://127.0.0.1:" +
          `${settings.mixedPort} (Mihomo ${st.version}, mode ${st.mode}, node ${main.now}).`,
        "Network tools: vpn_status/vpn_health/vpn_switch/vpn_speedtest/vpn_proxies/vpn_mode/vpn_use/vpn_update/vpn_reload. " +
          `Config: ${paths.configFile} (guarded; vpn_reload applies edits). Never touch Clash Verge (:7890) unless the user asks. Subscriptions are self-managed: vpn_sub_add {url|fromVerge} stores+verifies, vpn_sub_list (masked), vpn_sub_use, vpn_sub_remove, vpn_update refreshes nodes. Never print a full subscription URL.`,
      ].join("\n");
      return { systemPrompt: `${event.systemPrompt}\n${extra}` };
    } catch {
      return;
    }
  });
}
