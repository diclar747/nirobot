// Un panel de Facebook/Instagram POR ORGANIZACIÓN de Niro, dentro de un solo contenedor.
// Niro (nginx auth_request → /api/facebook/authz) decide qué organización es y la manda en el header
// X-Niro-Org; acá se levanta (o se reusa) el server.mjs de esa organización, con su propia base de
// datos, su carpeta de datos y su perfil de Chrome (su propia sesión de Facebook), y se le pasa el pedido.
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, timingSafeEqual } from "node:crypto";
import pg from "pg";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.NIRO_PORT || 8787);
const DATA_ROOT = process.env.NIRO_DATA_ROOT || join(ROOT, "data");
const ORGS_DIR = join(DATA_ROOT, "orgs");
// Organización que ya usaba el panel antes de que fuera por cliente: conserva base "autofacebook" y /app/data.
const LEGACY_ORG_ID = String(process.env.NIRO_LEGACY_ORG_ID || "").trim();
const ADMIN_DB_URL = process.env.NIRO_ADMIN_DATABASE_URL || "";
const LEGACY_DB_URL = process.env.NIRO_DATABASE_URL || "";
const INTERNAL_SECRET = process.env.NIRO_PANEL_PASSWORD || "";
const ORG_ID = /^[A-Za-z0-9_-]{8,64}$/;
const FIRST_CHILD_PORT = 9100;
// Niro dice qué organizaciones tienen la prueba/plan vencido: sus paneles se apagan (no publican solos).
const NIRO_API_URL = String(process.env.NIRO_API_URL || "http://api:4000").replace(/\/+$/, "");
const PLAN_CHECK_MS = 5 * 60_000;

const children = new Map(); // orgId → { port, proc, ready: Promise }
let nextPort = FIRST_CHILD_PORT;

function sameSecret(received, expected) {
  if (!received || !expected) return false;
  const a = createHash("sha256").update(String(received)).digest();
  const b = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

function dbName(orgId) {
  return `af_${orgId.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`.slice(0, 60);
}

function databaseUrlFor(orgId) {
  if (orgId === LEGACY_ORG_ID) return LEGACY_DB_URL;
  const url = new URL(ADMIN_DB_URL);
  url.pathname = `/${dbName(orgId)}`;
  return url.toString();
}

async function ensureDatabase(orgId) {
  if (orgId === LEGACY_ORG_ID) return;
  const client = new pg.Client({ connectionString: ADMIN_DB_URL });
  await client.connect();
  try {
    const name = dbName(orgId);
    const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (!found.rowCount) {
      await client.query(`CREATE DATABASE "${name}"`); // name ya viene saneado por dbName()
      console.log(`[supervisor] base creada para ${orgId}: ${name}`);
    }
  } finally {
    await client.end().catch(() => {});
  }
}

function dataDirFor(orgId) {
  return orgId === LEGACY_ORG_ID ? DATA_ROOT : join(ORGS_DIR, orgId);
}

function waitForPort(port, timeoutMs = 60_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/__alive", timeout: 2_000 }, (res) => { res.resume(); resolve(); });
      req.on("error", () => (Date.now() - started > timeoutMs ? reject(new Error("el panel no arrancó")) : setTimeout(probe, 400)));
      req.on("timeout", () => req.destroy());
    };
    probe();
  });
}

function startChild(orgId) {
  const existing = children.get(orgId);
  if (existing) return existing;
  const port = nextPort++;
  const dataDir = dataDirFor(orgId);
  const entry = { port, proc: null, ready: null };
  entry.ready = (async () => {
    await ensureDatabase(orgId);
    mkdirSync(dataDir, { recursive: true });
    const env = {
      ...process.env,
      NIRO_PORT: String(port),
      NIRO_HOST: "127.0.0.1",
      NIRO_DATA_DIR: dataDir,
      NIRO_BROWSER_PROFILE: join(dataDir, "browser-profile"),
      NIRO_DATABASE_URL: databaseUrlFor(orgId),
      NIRO_ORG_ID: orgId,
      // El panel que ya existía arranca con lo que diga el compose (se revisó con el usuario);
      // los de clientes nuevos publican lo programado solos, como cualquier función del plan.
      NIRO_SCHEDULER_AUTOSTART: orgId === LEGACY_ORG_ID ? String(process.env.NIRO_SCHEDULER_AUTOSTART || "false") : "true",
    };
    const proc = spawn(process.execPath, [join(ROOT, "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    entry.proc = proc;
    const tag = `[org ${orgId.slice(0, 10)}]`;
    proc.stdout.on("data", (chunk) => process.stdout.write(String(chunk).replace(/^(?=.)/gm, `${tag} `)));
    proc.stderr.on("data", (chunk) => process.stderr.write(String(chunk).replace(/^(?=.)/gm, `${tag} `)));
    proc.on("exit", (code) => {
      console.warn(`${tag} panel terminó (código ${code}); se vuelve a levantar en el próximo pedido`);
      if (children.get(orgId) === entry) children.delete(orgId);
    });
    await waitForPort(port);
    console.log(`${tag} panel listo en :${port}`);
  })();
  entry.ready.catch((error) => {
    console.error(`[supervisor] no se pudo levantar el panel de ${orgId}:`, error.message);
    if (children.get(orgId) === entry) children.delete(orgId);
    entry.proc?.kill("SIGTERM");
  });
  children.set(orgId, entry);
  return entry;
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

const server = http.createServer(async (request, response) => {
  // Interno (solo la API de Niro): qué organizaciones tienen panel levantado, para el puente de avisos.
  if (request.url === "/__niro/children") {
    if (!sameSecret(request.headers["x-niro-internal"], INTERNAL_SECRET)) return sendJson(response, 403, { ok: false });
    return sendJson(response, 200, { ok: true, orgs: [...children.keys()] });
  }
  const orgId = String(request.headers["x-niro-org"] || "");
  if (!ORG_ID.test(orgId)) return sendJson(response, 400, { ok: false, error: "Falta la organización de Niro." });
  const entry = startChild(orgId);
  try {
    await entry.ready;
  } catch {
    return sendJson(response, 503, { ok: false, error: "El panel de Facebook no pudo iniciar. Probá de nuevo en unos segundos." });
  }
  const upstream = http.request({ host: "127.0.0.1", port: entry.port, method: request.method, path: request.url, headers: request.headers }, (reply) => {
    response.writeHead(reply.statusCode || 502, reply.headers);
    reply.pipe(response);
  });
  upstream.on("error", () => { if (!response.headersSent) sendJson(response, 502, { ok: false, error: "El panel de Facebook no respondió." }); else response.destroy(); });
  request.pipe(upstream);
  response.on("close", () => upstream.destroy());
});

async function blockedOrgs(orgIds) {
  if (!orgIds.length) return [];
  const response = await fetch(`${NIRO_API_URL}/api/facebook/internal/plan-status`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-niro-internal": INTERNAL_SECRET },
    body: JSON.stringify({ orgIds }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()).blocked || [];
}

function knownOrgs() {
  const known = new Set(LEGACY_ORG_ID ? [LEGACY_ORG_ID] : []);
  if (existsSync(ORGS_DIR)) for (const dir of readdirSync(ORGS_DIR)) if (ORG_ID.test(dir)) known.add(dir);
  return [...known];
}

// Apaga los paneles de organizaciones vencidas. Si Niro no contesta, no se toca nada (mejor no cortar por un error).
async function enforcePlans() {
  try {
    const blocked = new Set(await blockedOrgs([...children.keys()]));
    for (const orgId of blocked) {
      const entry = children.get(orgId);
      if (!entry) continue;
      console.log(`[supervisor] ${orgId}: plan vencido, se apaga su panel`);
      children.delete(orgId);
      entry.proc?.kill("SIGTERM");
    }
  } catch (error) {
    console.warn("[supervisor] no se pudo consultar el plan en Niro:", error.message);
  }
}

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`[supervisor] paneles de Facebook por organización en :${PORT}`);
  // Los que ya tenían panel siguen trabajando solos (monitor, programaciones, IA) tras un reinicio,
  // salvo los que tienen el plan vencido.
  const known = knownOrgs();
  let blocked = new Set();
  try { blocked = new Set(await blockedOrgs(known)); } catch (error) { console.warn("[supervisor] plan sin verificar al iniciar:", error.message); }
  for (const orgId of known) if (!blocked.has(orgId)) startChild(orgId);
  setInterval(enforcePlans, PLAN_CHECK_MS).unref();
});

async function shutdown() {
  for (const { proc } of children.values()) proc?.kill("SIGTERM");
  setTimeout(() => process.exit(0), 4_000).unref();
  server.close(() => { if (![...children.values()].some(({ proc }) => proc && proc.exitCode === null)) process.exit(0); });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
