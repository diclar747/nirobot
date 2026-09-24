import http from "node:http";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import "dotenv/config";
import { chromium } from "playwright";
import { PgStore } from "./db.mjs";
import { contentKey, createAiReplies } from "./ai-replies.mjs";
import { createGroupsExplorer, GROUP_STATUSES } from "./groups-explorer.mjs";
import { createInstagram } from "./instagram.mjs";
import { createCrm } from "./crm.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
// NIRO_DATA_DIR: una carpeta por cliente cuando corre bajo supervisor.mjs (un panel por organización).
const DATA_DIR = resolve(process.env.NIRO_DATA_DIR || join(ROOT, "data"));
const MEDIA_DIR = join(DATA_DIR, "uploads");
const IMAGE_DIR = join(DATA_DIR, "images");
const STORE_PATH = resolve(process.env.NIRO_DATABASE || join(DATA_DIR, "niro.json"));
const PROFILE_PATH = resolve(process.env.NIRO_BROWSER_PROFILE || join(DATA_DIR, "browser-profile"));
const PORT = Number(process.env.NIRO_PORT || 8787);
const HOST = process.env.NIRO_HOST || "127.0.0.1";
// Permite que el panel viva bajo una ruta del sitio principal (ej. niro.com.py/facebook) en vez de
// un subdominio propio: el proxy no reescribe nada, esta única línea le quita el prefijo antes de
// que el resto del router (~150 comparaciones de url.pathname) lo vea, así ese código no cambia.
const BASE_PATH = String(process.env.NIRO_BASE_PATH || "").replace(/\/+$/, "");
// En un servidor (Docker) no hay pantalla: Chrome siempre corre en segundo plano y la persona lo
// maneja desde el panel con la "ventana remota" (/api/browser/screen + /api/browser/input).
const REMOTE_VIEW = /^(1|true)$/i.test(process.env.NIRO_REMOTE_VIEW || "");
const POLL_SECONDS = Math.max(15, Number(process.env.NIRO_POLL_SECONDS || 60));
const SCHEDULE_SECONDS = Math.max(5, Number(process.env.NIRO_SCHEDULE_SECONDS || 15));
const SCHEDULER_AUTOSTART = /^(1|true|yes)$/i.test(process.env.NIRO_SCHEDULER_AUTOSTART || "false");
const DRAFT_WEBHOOK = process.env.NIRO_DRAFT_WEBHOOK || "";
const HEADLESS_DEFAULT = !/^(0|false|no)$/i.test(process.env.NIRO_HEADLESS || "true");
const DATABASE_URL = process.env.NIRO_DATABASE_URL || process.env.DATABASE_URL || "";
const MAX_POST_SCROLLS = Math.max(1, Math.min(60, Number(process.env.NIRO_POST_SCROLLS || 12)));
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MAX_CHATS = Math.max(1, Math.min(1_000, Number(process.env.NIRO_MAX_CHATS || 500)));
const MAX_CHAT_HISTORY_PAGES = Math.max(1, Math.min(100, Number(process.env.NIRO_CHAT_HISTORY_PAGES || 30)));
const MAX_CHAT_MESSAGES = Math.max(100, Math.min(100_000, Number(process.env.NIRO_MAX_CHAT_MESSAGES || 5_000)));
const SYSTEM_BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const BROWSER_EXECUTABLE = process.env.NIRO_BROWSER_EXECUTABLE || SYSTEM_BROWSER_CANDIDATES.find((path) => existsSync(path));
const PRESENCE_LABEL = /^(activ[oa]|active|en l[ií]nea|online)(\s+(ahora|now|hace\s+.+|\d+\s*\S+(\s+ago)?))?$/i;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

let store = {
  events: [],
  drafts: [],
  groups: [],
  pages: [],
  schedules: [],
  media: [],
  chats: [],
  messages: [],
  publications: [],
  posts: [],
  aiInteractions: [],
  aiPrompts: [],
  leads: [],
  aiAudit: [],
  socialAccounts: [],
  groupSegments: [],
  discoveredGroups: [],
  groupJoinTasks: [],
  ...Object.fromEntries(CRM_COLLECTIONS().map((name) => [name, []])),
  profile: null,
  meta: { lastScanAt: null, lastInventoryAt: null, lastChatSyncAt: null, lastPostSyncAt: null },
};
let pgStore = null;
let scanInProgress = false;
let monitorTimer = null;
let schedulerTimer = null;
let scheduleRunInProgress = false;
let actionInProgress = false;
const mediaStore = new Map();
const monitorState = { enabled: false, lastError: null };
const schedulerState = { enabled: false, lastError: null, lastRunAt: null };

function now() {
  return new Date().toISOString();
}

// Colecciones del CRM (tableros, columnas, contactos, tarjetas, actividades…).
function CRM_COLLECTIONS() {
  return ["crmBoards", "crmStages", "crmContacts", "crmIdentities", "crmOpportunities", "crmActivities", "crmTasks", "crmStageHistory", "campaignSources", "crmCampaigns", "campaignRecipients"];
}

function normalizeStore(parsed = {}) {
  return {
    events: Array.isArray(parsed.events) ? parsed.events : [],
    drafts: Array.isArray(parsed.drafts) ? parsed.drafts : [],
    groups: Array.isArray(parsed.groups) ? parsed.groups : [],
    pages: Array.isArray(parsed.pages) ? parsed.pages : [],
    schedules: Array.isArray(parsed.schedules) ? parsed.schedules : [],
    media: Array.isArray(parsed.media) ? parsed.media : [],
    chats: Array.isArray(parsed.chats) ? parsed.chats : [],
    messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    publications: Array.isArray(parsed.publications) ? parsed.publications : [],
    posts: Array.isArray(parsed.posts) ? parsed.posts : [],
    aiInteractions: Array.isArray(parsed.aiInteractions) ? parsed.aiInteractions : [],
    aiPrompts: Array.isArray(parsed.aiPrompts) ? parsed.aiPrompts : [],
    leads: Array.isArray(parsed.leads) ? parsed.leads : [],
    aiAudit: Array.isArray(parsed.aiAudit) ? parsed.aiAudit : [],
    socialAccounts: Array.isArray(parsed.socialAccounts) ? parsed.socialAccounts : [],
    groupSegments: Array.isArray(parsed.groupSegments) ? parsed.groupSegments : [],
    discoveredGroups: Array.isArray(parsed.discoveredGroups) ? parsed.discoveredGroups : [],
    groupJoinTasks: Array.isArray(parsed.groupJoinTasks) ? parsed.groupJoinTasks : [],
    ...Object.fromEntries(CRM_COLLECTIONS().map((name) => [name, Array.isArray(parsed[name]) ? parsed[name] : []])),
    profile: parsed.profile && typeof parsed.profile === "object" ? parsed.profile : null,
    meta: { lastScanAt: null, lastInventoryAt: null, lastChatSyncAt: null, lastPostSyncAt: null, ...(parsed.meta || {}) },
  };
}

async function readJsonStore() {
  if (!existsSync(STORE_PATH)) return null;
  try {
    return JSON.parse(await readFile(STORE_PATH, "utf8"));
  } catch (error) {
    console.warn(`No se pudo leer ${STORE_PATH}; se inicia una bandeja nueva.`, error.message);
    return null;
  }
}

async function loadStore() {
  await mkdir(DATA_DIR, { recursive: true });
  if (DATABASE_URL) {
    pgStore = new PgStore(DATABASE_URL);
    await pgStore.init();
    if (await pgStore.isEmpty()) {
      const legacy = await readJsonStore();
      store = normalizeStore(legacy || {});
      if (legacy) console.log(`[db] primera ejecución: importando ${STORE_PATH} a PostgreSQL`);
    } else {
      store = normalizeStore(await pgStore.load());
      const savedAt = await pgStore.metaUpdatedAt();
      if (existsSync(STORE_PATH) && savedAt && statSync(STORE_PATH).mtime > savedAt) {
        console.warn(`[db] ${STORE_PATH} es más reciente que PostgreSQL. Si otra versión del panel siguió usando el JSON, detené el panel y ejecutá "npm run db:import".`);
      }
    }
  } else {
    const parsed = await readJsonStore();
    if (parsed) store = normalizeStore(parsed);
  }
  for (const media of store.media) {
    if (!media?.id || !media?.path) continue;
    // Tras mover el sistema a otro equipo la ruta absoluta guardada ya no existe:
    // se busca el mismo archivo en data/uploads de esta instalación.
    if (!existsSync(media.path)) {
      const local = join(MEDIA_DIR, String(media.path).split(/[\\/]/).pop());
      if (existsSync(local)) media.path = local;
    }
    if (existsSync(media.path)) mediaStore.set(media.id, media);
  }
  for (const event of store.events) if (!event.kind) event.kind = classifyEvent(event);
  for (const schedule of store.schedules) ensureScheduleJobs(schedule);
  if (pgStore) await pgStore.save(store);
}

async function writeJsonStore() {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

async function persist() {
  if (!pgStore) return writeJsonStore();
  try {
    await pgStore.save(store);
  } catch (error) {
    // Si PostgreSQL falla no se pierde nada: queda una copia JSON de emergencia.
    console.error("[db] no se pudo guardar en PostgreSQL; se escribe copia JSON", error.message);
    await writeJsonStore();
  }
}

function classifyEvent(input) {
  if (input.source === "messenger") return "message";
  let type = "";
  try { type = new URL(input.url || "").searchParams.get("notif_t") || ""; } catch { type = ""; }
  if (/reaction|like/.test(type)) return "reaction";
  if (/mention/.test(type)) return "mention";
  if (/comment|reply/.test(type)) return "comment";
  if (/marketplace|^ma$/.test(type)) return "marketplace";
  if (/login|approval|security|checkpoint/.test(type) || /\/afad\//.test(input.url || "")) return "security";
  const text = String(input.text || "").toLowerCase();
  if (/le gusta tu|les gusta tu|reaccion(ó|aron)|reacted to your/.test(text)) return "reaction";
  if (/inicio de sesión|iniciar sesión|contraseña|login|password|código de seguridad|security/.test(text)) return "security";
  if (/marketplace/.test(text)) return "marketplace";
  if (/coment(ó|o|aron|ario)|respondi(ó|o)|commented|replied|reply/.test(text)) return "comment";
  if (/mencion|etiquet|mentioned|tagged/.test(text)) return "mention";
  if (/reaccion|le gusta|les gusta|reacted|likes? your/.test(text)) return "reaction";
  if (/compart|shared/.test(text)) return "share";
  if (/solicitud de amistad|friend request|aceptó tu solicitud|accepted your/.test(text)) return "friend";
  if (/cumplea|birthday/.test(text)) return "birthday";
  if (/grupo|group/.test(text)) return "group";
  if (/en vivo|live video|transmisi/.test(text)) return "live";
  return "other";
}

const streamClients = new Set();

function broadcast(type, payload = {}) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of streamClients) {
    try { client.write(frame); } catch { streamClients.delete(client); }
  }
}

// Guarda la configuración "Responder interacciones con Niro" de una publicación.
async function publicationAi(input, text) {
  if (!input || typeof input !== "object") return { mode: "inherit", campaign: null, contentKey: contentKey(text), crm: null };
  const key = contentKey(text);
  const mode = ["inherit", "off", "custom"].includes(input.mode) ? input.mode : "inherit";
  const campaign = input.campaign ? String(input.campaign).trim().slice(0, 120) : null;
  if (mode === "custom" && key) {
    await ai.savePrompt({ scope: "publication", scopeId: key, scopeName: cleanText(text, 70), fields: input.fields || {}, mode: input.replyMode || "inherit" });
  }
  // "Enviar interesados al tablero": viaja con la publicación, sus programaciones y envíos masivos.
  return { mode, campaign, contentKey: key, crm: crm.sanitizeRouting(input.crm) };
}

// Mensaje de error legible: sin el registro técnico de Playwright ni códigos de color.
function readableError(error) {
  if (!error) return null;
  return cleanText(String(error).split(/\n\s*Call log:/)[0].replace(/\u001b\[[0-9;]*m/g, ""), 300);
}

function recordPublication({ target, text, media = [], origin = "manual", status = "published", error = null, url = null, scheduleId = null, jobId = null, aiConfig = null }) {
  const publication = {
    id: randomUUID(),
    target: target ? { type: target.type, id: target.id, name: target.name || target.id } : { type: "profile", id: "profile", name: "Tu perfil" },
    text: String(text || "").slice(0, 5_000),
    media: (media || []).map((item) => typeof item === "string" ? item : item?.id).filter(Boolean),
    origin,
    status,
    error: readableError(error),
    url,
    scheduleId,
    jobId,
    ai: aiConfig,
    createdAt: now(),
  };
  store.publications.unshift(publication);
  if (store.publications.length > 5_000) store.publications.length = 5_000;
  if (status === "published") crm.registerPublication(publication);
  broadcast("publication", { publication });
  return publication;
}

function templateDraftFor(event, extra = "") {
  return [
    "BORRADOR PARA REVISIÓN HUMANA",
    "No se envía automáticamente.",
    "",
    `Origen: ${event.source}`,
    `Contexto detectado: ${event.text.slice(0, 500)}`,
    "",
    extra || "[Conectar aquí el generador de Niro antes de usar este borrador.]",
  ].join("\n");
}

async function draftFor(event) {
  if (!DRAFT_WEBHOOK) return templateDraftFor(event);
  try {
    const response = await fetch(DRAFT_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: event.source, text: event.text, url: event.url, externalId: event.externalId }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (typeof payload.draft !== "string" || !payload.draft.trim()) throw new Error("respuesta sin campo draft");
    return payload.draft.trim().slice(0, 20_000);
  } catch (error) {
    return templateDraftFor(event, `No se pudo consultar el generador configurado: ${error.message}`);
  }
}

async function upsertEvent(input) {
  const key = `${input.source}:${input.externalId}`;
  const existing = store.events.find((event) => event.key === key);
  if (existing) {
    existing.lastSeenAt = now();
    existing.text = input.text;
    existing.url = input.url;
    existing.kind = classifyEvent(existing);
    if (input.avatarUrl) existing.avatarUrl = input.avatarUrl;
    if (input.timeLabel) existing.timeLabel = input.timeLabel;
    return { event: existing, isNew: false };
  }

  const event = {
    id: randomUUID(),
    key,
    source: input.source,
    kind: classifyEvent(input),
    externalId: input.externalId,
    text: input.text,
    url: input.url,
    avatarUrl: input.avatarUrl || null,
    timeLabel: input.timeLabel || null,
    read: false,
    firstSeenAt: now(),
    lastSeenAt: now(),
  };
  store.events.unshift(event);
  store.drafts.unshift({
    id: randomUUID(),
    eventId: event.id,
    body: await draftFor(event),
    status: "review",
    createdAt: now(),
  });
  broadcast("event", { event });
  ai.captureEvent(event).catch((error) => console.error("[ai] captura falló", error.message));
  crm.captureEvent(event).catch((error) => console.error("[crm] captura falló", error.message));
  return { event, isNew: true };
}

function absoluteUrl(value, base) {
  try {
    return new URL(value, base).href;
  } catch {
    return base;
  }
}

function cleanText(value, max = 4_000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizedLink(value, base, allowedHosts = ["facebook.com", "www.facebook.com"]) {
  try {
    const target = new URL(value, base);
    if (!allowedHosts.some((host) => target.hostname === host || target.hostname.endsWith(`.${host}`))) return null;
    target.search = "";
    target.hash = "";
    target.pathname = target.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    return target.href;
  } catch {
    return null;
  }
}

function chatIdFromUrl(value) {
  try {
    const target = new URL(value);
    const match = target.pathname.match(/(?:^|\/)t\/([^/]+)/i);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

const MONTHS = { enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
  ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sep: 8, sept: 8, oct: 9, nov: 10, dic: 11,
  january: 0, february: 1, march: 2, april: 3, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };

function parseMessengerDate(label) {
  const text = String(label || "").toLowerCase();
  const time = text.match(/(\d{1,2}):(\d{2})\s*([ap])?\.?\s?m?/);
  const spanish = text.match(/(\d{1,2})\s+(?:de\s+)?([a-záéíóú]+)\.?\s+(?:de\s+)?(\d{4})/);
  const english = text.match(/([a-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  const day = spanish ? Number(spanish[1]) : english ? Number(english[2]) : null;
  const month = spanish ? MONTHS[spanish[2]] : english ? MONTHS[english[1]] : undefined;
  const year = spanish ? Number(spanish[3]) : english ? Number(english[3]) : null;
  if (!day || month === undefined || !year || !time) return null;
  let hours = Number(time[1]);
  if (time[3] === "p" && hours < 12) hours += 12;
  if (time[3] === "a" && hours === 12) hours = 0;
  return new Date(year, month, day, hours, Number(time[2])).toISOString();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
}

function csvCell(value) {
  let text = String(value ?? "").replace(/\r?\n/g, " ");
  // Evita que Excel ejecute fórmulas escritas por terceros (nombres, comentarios,
  // formularios). Un teléfono como +595 981 123456 queda igual.
  if (/^[=@\t\r]/.test(text) || /^[+-](?![\d\s().-]*$)/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function recordsAsCsv(records) {
  if (!records.length) return "";
  const keys = [...new Set(records.flatMap((record) => Object.keys(record)))];
  return [keys.map(csvCell).join(","), ...records.map((record) => keys.map((key) => csvCell(record[key])).join(","))].join("\n");
}

function mergeById(items, incoming, idKey = "id") {
  const index = new Map(items.map((item) => [item?.[idKey], item]));
  for (const item of incoming || []) {
    if (!item?.[idKey]) continue;
    index.set(item[idKey], { ...index.get(item[idKey]), ...item });
  }
  return [...index.values()];
}

class FacebookAgent {
  constructor() {
    this.context = null;
    this.homePage = null;
    this.lastUrl = null;
    this.openPromise = null;
    this.preparedPost = null;
    // La persona puede detener una sincronización larga; los bucles lo revisan.
    this.cancelRequested = false;
  }

  get isOpen() {
    return Boolean(this.context);
  }

  async open() {
    if (this.context) {
      if (this.homePage && !this.homePage.isClosed()) await this.homePage.bringToFront();
      return;
    }
    if (this.openPromise) return this.openPromise;
    this.openPromise = this._open();
    try {
      await this.openPromise;
    } finally {
      this.openPromise = null;
    }
  }

  // true = sin ventana (segundo plano). Se guarda en la base y se puede cambiar desde el panel.
  get headless() {
    if (REMOTE_VIEW) return true;
    const saved = store.meta.browser?.headless;
    return typeof saved === "boolean" ? saved : HEADLESS_DEFAULT;
  }

  async _open() {
    await mkdir(PROFILE_PATH, { recursive: true });
    const headless = this.headless;
    const launchOptions = {
      headless,
      viewport: { width: 1440, height: 1000 },
      locale: "es-419",
      args: ["--disable-notifications", "--disable-quic", "--disable-blink-features=AutomationControlled"],
    };
    // Chrome sin ventana se identifica como "HeadlessChrome": se usa el mismo
    // agente de usuario que el Chrome normal para no llamar la atención.
    if (headless && store.meta.browser?.userAgent) launchOptions.userAgent = store.meta.browser.userAgent;
    if (BROWSER_EXECUTABLE) launchOptions.executablePath = BROWSER_EXECUTABLE;
    console.log(`[browser] iniciando ${BROWSER_EXECUTABLE || "Chromium de Playwright"} ${headless ? "en segundo plano (sin ventana)" : "con ventana"}`);
    try {
      this.context = await chromium.launchPersistentContext(PROFILE_PATH, launchOptions);
      if (headless && !launchOptions.userAgent) {
        const probe = this.context.pages()[0] || await this.context.newPage();
        const agent = await probe.evaluate(() => navigator.userAgent).catch(() => "");
        if (/HeadlessChrome/.test(agent)) {
          store.meta.browser = { ...(store.meta.browser || {}), userAgent: agent.replace("HeadlessChrome", "Chrome") };
          await persist();
          await this.context.close();
          launchOptions.userAgent = store.meta.browser.userAgent;
          this.context = await chromium.launchPersistentContext(PROFILE_PATH, launchOptions);
        }
      }
      // El servidor no tiene huella, cámara ni llave de seguridad: si Facebook cree que hay "llaves de
      // acceso" (WebAuthn) muestra "Creá/Usá una llave de acceso" y la ruedita queda girando para siempre.
      // Sin PublicKeyCredential, Facebook ofrece directo código por WhatsApp/SMS o aprobación en el celular.
      await this.context.addInitScript(() => {
        try { Object.defineProperty(window, "PublicKeyCredential", { value: undefined, configurable: true }); } catch {}
        try {
          const refuse = () => Promise.reject(new DOMException("Sin llaves de acceso en este equipo", "NotAllowedError"));
          if (navigator.credentials) { navigator.credentials.create = refuse; navigator.credentials.get = refuse; }
        } catch {}
      });
      this.mode = headless ? "headless" : "visible";
      this.homePage = this.context.pages()[0] || await this.context.newPage();
      this.homePage.on("dialog", (dialog) => (dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss()).catch(() => {}));
      try {
        await this.homePage.goto("https://www.facebook.com/", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
      } catch (error) {
        if (!/ERR_QUIC_PROTOCOL_ERROR|ERR_HTTP2_PROTOCOL_ERROR/i.test(error.message)) throw error;
        await this.homePage.goto("https://www.facebook.com/", { waitUntil: "commit", timeout: 30_000 });
      }
      this.lastUrl = this.homePage.url();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close() {
    if (this.context) await this.context.close();
    this.context = null;
    this.homePage = null;
    this.preparedPost = null;
    this.mode = null;
  }

  // Responder como página cambia la identidad de TODA la sesión. Esto vuelve al
  // perfil personal con "Cambiar a <nombre>" del menú de cuenta.
  async ensurePersonalProfile() {
    const personal = store.profile?.name;
    if (!personal || !this.isOpen) return { restored: false, reason: "sin perfil" };
    await this.openUrl("https://www.facebook.com/");
    await this.waitForFacebookReady(this.homePage).catch(() => {});
    const account = this.homePage.getByRole("button", { name: /^(Tu perfil|Your profile)$/i }).first();
    if (!(await account.isVisible().catch(() => false))) return { restored: false, reason: "no encontré el menú de cuenta" };
    await account.click();
    const switchBack = this.homePage.getByRole("button", { name: new RegExp(`^(Cambiar a|Switch to) ${escapeRegExp(personal)}$`, "i") }).first();
    if (!(await switchBack.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false))) {
      await this.homePage.keyboard.press("Escape").catch(() => {});
      this.identitySwitched = false;
      return { restored: false, reason: "ya estaba como perfil personal" };
    }
    await switchBack.click();
    await this.homePage.waitForTimeout(4_000);
    await this.waitForFacebookReady(this.homePage).catch(() => {});
    this.identitySwitched = false;
    console.log(`[browser] identidad restaurada a ${personal}`);
    return { restored: true };
  }

  // Cambia entre ventana visible y segundo plano reabriendo el mismo perfil.
  async setHeadless(headless) {
    if (REMOTE_VIEW) {
      // Sin pantalla no hay "ventana visible": se abre (o se deja) en segundo plano y se usa la ventana remota.
      if (!headless) await this.open();
      return;
    }
    store.meta.browser = { ...(store.meta.browser || {}), headless };
    await persist();
    const wasOpen = this.isOpen;
    await this.close();
    if (wasOpen || !headless) await this.open();
  }

  async openUrl(targetUrl) {
    const target = new URL(targetUrl);
    const allowedHosts = ["facebook.com", "www.facebook.com", "business.facebook.com", "messenger.com", "www.messenger.com"];
    if (!allowedHosts.includes(target.hostname)) throw new Error("Solo se pueden abrir enlaces de Facebook o Messenger.");
    await this.open();
    const current = new URL(this.homePage.url());
    const alreadyOnTarget = current.href === target.href || (target.pathname === "/" && current.hostname.endsWith("facebook.com"));
    if (!alreadyOnTarget) {
      try {
        await this.homePage.goto(target.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch (error) {
        if (!/ERR_ABORTED/i.test(error.message)) throw error;
        await this.homePage.waitForTimeout(1_000);
      }
    }
    await this.homePage.bringToFront();
    this.lastUrl = this.homePage.url();
  }

  async clickVisibleButton(pattern) {
    const buttons = await this.homePage.getByRole("button", { name: pattern }).all();
    for (const button of buttons.reverse()) {
      if (await button.isVisible()) {
        await button.click();
        return true;
      }
    }
    return false;
  }

  // dialogOnly: para publicaciones solo vale el editor del diálogo "Crear
  // publicación". Nunca se usa un cuadro de comentario, respuesta o mensaje:
  // escribir ahí y "publicar" comentaría en una publicación ajena.
  async visibleEditor({ dialogOnly = false, attempts = 5 } = {}) {
    const base = "[contenteditable='true'][role='textbox'], [contenteditable='true'], textarea";
    const selector = dialogOnly ? base.split(", ").map((part) => `[role='dialog'] ${part}`).join(", ") : base;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const editors = await this.homePage.locator(selector).all();
      for (const editor of editors.reverse()) {
        try {
          if (!(await editor.isVisible())) continue;
          const info = await editor.evaluate((element) => ({
            label: [element.getAttribute("aria-label"), element.getAttribute("aria-placeholder"), element.getAttribute("placeholder"), element.closest("[aria-label]:not([role='dialog'])")?.getAttribute("aria-label")].filter(Boolean).join(" "),
            dialog: (element.closest("[role='dialog']")?.innerText || "").slice(0, 400),
          }));
          if (/coment|comment|respond|reply|mensaje|message|buscar|search/i.test(info.label)) continue;
          if (dialogOnly && !/crear publicación|create post|publicar en|post to|qué estás pensando|what.?s on your mind/i.test(info.dialog)) continue;
          return editor;
        } catch { /* Facebook puede reemplazar el editor durante la animación. */ }
      }
      await this.homePage.waitForTimeout(750);
    }
    return null;
  }

  async attachMedia(media) {
    if (!media.length) return;
    const inputs = await this.homePage.locator("input[type='file']").all();
    if (inputs.length) {
      await inputs[inputs.length - 1].setInputFiles(media.map((item) => item.path));
      await this.homePage.waitForTimeout(1_500);
      return;
    }
    const mediaButton = this.homePage.getByRole("button", { name: /Foto|video|Photo|Video|archivo|document|file|Agregar a tu publicación|Add to your post/i });
    if (await mediaButton.count()) {
      const fileChooser = this.homePage.waitForEvent("filechooser", { timeout: 5_000 });
      await mediaButton.last().click();
      const chooser = await fileChooser;
      await chooser.setFiles(media.map((item) => item.path));
      await this.homePage.waitForTimeout(1_500);
      return;
    }
    throw new Error("Facebook no mostró el selector para adjuntar archivos.");
  }

  // opener: función opcional que abre el editor correcto (página, historia) en lugar
  // de navegar a destinationUrl y buscar el cuadro "¿Qué estás pensando?".
  async prepareComposer(text, media = [], destinationUrl = "https://www.facebook.com/", kind = "profile", destinationId = null, opener = null) {
    if (!text || text.trim().length < 3) throw new Error("Escribí un texto de al menos 3 caracteres.");
    if (text.length > 5_000) throw new Error("El texto no puede superar 5.000 caracteres.");
    const mediaIds = media.map((item) => typeof item === "string" ? item : item?.id).filter(Boolean);
    const attachments = mediaIds.map((id) => mediaStore.get(id)).filter(Boolean);
    if (attachments.length !== mediaIds.length) throw new Error("Uno de los archivos adjuntos ya no está disponible. Volvé a seleccionarlo.");
    await this.open();
    const currentUrl = this.homePage.url();
    const sameDestination = currentUrl === destinationUrl || (destinationUrl === "https://www.facebook.com/" && new URL(currentUrl).hostname.endsWith("facebook.com"));
    if (!opener && !sameDestination && destinationUrl) await this.homePage.goto(destinationUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await this.homePage.bringToFront();
    if (await this.isLoggedOut(this.homePage)) throw new Error("El perfil conectado no tiene una sesión activa.");
    const samePost = this.preparedPost
      && this.preparedPost.kind === kind
      && this.preparedPost.destinationId === destinationId
      && this.preparedPost.text === text
      && JSON.stringify(this.preparedPost.mediaIds) === JSON.stringify(mediaIds);
    if (samePost) return { prepared: true, url: this.homePage.url(), media: attachments.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })) };
    // Con opener (páginas, historias) la navegación la hace el opener: la pestaña
    // puede estar en blanco tras un envío anterior y no hay que esperar su carga.
    if (!opener) {
      await this.waitForFacebookReady(this.homePage);
      if (await this.isLoggedOut(this.homePage)) throw new Error("El perfil conectado no tiene una sesión activa.");
    }
    let editor = opener ? await opener() : await this.visibleEditor({ dialogOnly: true, attempts: 2 });
    if (!editor && !opener) {
      const composerPattern = /¿?Qué estás pensando(?:,?\s+[^?]+)?|What.?s on your mind|What are you thinking|Crear publicación|Create post|Crear historia|Create story|Escribe algo|Write something/i;
      // Los grupos grandes cargan el cuadro "Escribe algo..." varios segundos
      // después del resto de la página: se reintenta hasta ~15 s.
      for (let round = 0; round < 3 && !editor; round += 1) {
        let clicked = false;
        for (let wait = 0; wait < 10 && !clicked; wait += 1) {
          if (kind === "group" && await this.groupBlocker()) break;
          const candidates = [...await this.homePage.getByRole("button", { name: composerPattern }).all(), ...await this.homePage.getByText(composerPattern).all()];
          for (const candidate of candidates) {
            try {
              if (await candidate.isVisible()) {
                await candidate.click();
                clicked = true;
                break;
              }
            } catch { /* el árbol de Facebook puede cambiar mientras abre el diálogo. */ }
          }
          if (!clicked) await this.homePage.waitForTimeout(1_000);
        }
        if (!clicked) break;
        editor = await this.visibleEditor({ dialogOnly: true, attempts: 8 });
        if (!editor) await this.homePage.keyboard.press("Escape").catch(() => {});
      }
    }
    if (!editor) {
      const blocker = kind === "group" ? await this.groupBlocker() : null;
      throw new Error(blocker || "Facebook no mostró el campo para escribir la publicación.");
    }
    await editor.fill(text);
    await this.attachMedia(attachments);
    await this.clickVisibleButton(/Siguiente|Next/i);
    await this.homePage.waitForTimeout(1_000);
    this.preparedPost = { text, mediaIds, kind, destinationId, destinationUrl };
    return { prepared: true, url: this.homePage.url(), media: attachments.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })) };
  }

  async preparePost(text, media = []) {
    if (this.identitySwitched) await this.ensurePersonalProfile();
    return this.prepareComposer(text, media, "https://www.facebook.com/", "profile", null);
  }

  // Motivo por el que el grupo no permite publicar, leído del propio grupo.
  async groupBlocker() {
    const body = await this.homePage.evaluate(() => (document.querySelector("[role='main']") || document.body)?.innerText?.slice(0, 6000) || "").catch(() => "");
    const rules = [
      [/est[aá] en pausa|paused this group|group is paused/i, "El grupo está en pausa: un administrador desactivó las publicaciones."],
      [/tu solicitud est[aá] pendiente|your request is pending|cancelar solicitud|cancel request/i, "Tu solicitud para unirte todavía está pendiente: no podés publicar hasta que te aprueben."],
      [/solo los administradores (y moderadores )?pueden publicar|only admins (and moderators )?can post/i, "En este grupo solo los administradores pueden publicar."],
      [/^\s*(unirte al grupo|join group)\s*$/im, "La cuenta no es miembro del grupo: primero hay que unirse."],
      [/este contenido no est[aá] disponible|this content isn.t available|no se encontr[oó]/i, "El grupo ya no está disponible o fue eliminado."],
    ];
    return rules.find(([pattern]) => pattern.test(body))?.[1] || null;
  }

  async prepareGroupPost(group, text, media = []) {
    if (this.identitySwitched) await this.ensurePersonalProfile();
    if (!group?.url) throw new Error("El grupo seleccionado no tiene un enlace válido.");
    return this.prepareComposer(text, media, group.url, "group", group.id);
  }

  async publishPrepared(kind = "profile") {
    const finalButton = kind === "story" ? /Compartir en historia|Share to story/i : /^(Publicar|Post)$/i;
    let published = await this.clickVisibleButton(finalButton);
    if (!published) {
      await this.clickVisibleButton(/Siguiente|Next/i);
      await this.homePage.waitForTimeout(1_000);
      published = await this.clickVisibleButton(finalButton);
    }
    if (!published) throw new Error(`Facebook no mostró el botón final para ${kind === "story" ? "la historia" : "la publicación"}.`);
    await this.homePage.waitForTimeout(2_000);
    this.preparedPost = null;
    return { published: true, url: this.homePage.url(), kind };
  }

  async publishPost(text, media = []) {
    await this.preparePost(text, media);
    return this.publishPrepared("perfil");
  }

  async publishGroupPost(group, text, media = []) {
    await this.prepareGroupPost(group, text, media);
    return this.publishPrepared("grupo");
  }

  // Páginas: editor de Meta Business Suite con asset_id = id numérico de la
  // página. Publica como la página sin cambiar la identidad de la sesión.
  async preparePagePost(page, text, media = []) {
    if (!page?.id) throw new Error("La página seleccionada no tiene un identificador válido.");
    if (!/^\d+$/.test(String(page.id))) throw new Error("Actualizá la lista de páginas para obtener su identificador numérico.");
    const opener = async () => {
      await this.openUrl(`https://business.facebook.com/latest/composer/?asset_id=${page.id}`);
      if (await this.isLoggedOut(this.homePage)) throw new Error("El perfil conectado no tiene una sesión activa.");
      const editor = this.homePage.locator("[contenteditable='true'][role='textbox'], [contenteditable='true']")
        .filter({ hasNot: this.homePage.locator("[aria-label*='coment' i]") });
      // Business Suite puede tardar en cargar páginas con mucha actividad (hasta ~40 s).
      for (let attempt = 0; attempt < 50; attempt += 1) {
        // Avisos de bienvenida de Business Suite que tapan el editor.
        for (const name of [/^OK$/, /^Entendido$/, /^Got it$/]) {
          const button = this.homePage.getByRole("button", { name }).first();
          if (await button.isVisible().catch(() => false)) await button.click().catch(() => {});
        }
        const candidate = editor.first();
        if (await candidate.isVisible().catch(() => false)) {
          const label = await candidate.getAttribute("aria-label") || "";
          if (!/coment|comment|mensaje|message/i.test(label)) {
            // Evita la "publicación cruzada": Business Suite marca por defecto
            // también el Instagram vinculado; Instagram tiene su propio trabajo.
            await instagram.selectOnly(this.homePage, (text) => text === page.name);
            const summary = ((await this.homePage.locator("[role='combobox']").first().innerText().catch(() => "")) || "").replace(/[\s\u200b]+/g, " ").trim();
            if (summary && summary !== page.name) throw new Error(`No pude dejar solo la página ${page.name} en "Publicar en" (quedó: ${summary}).`);
            return candidate;
          }
        }
        await this.homePage.waitForTimeout(750);
      }
      throw new Error(`Business Suite no mostró el editor de ${page.name}. Verificá que la cuenta administre la página.`);
    };
    return this.prepareComposer(text, media, null, "page", page.id, opener);
  }

  async publishPagePost(page, text, media = []) {
    await this.preparePagePost(page, text, media);
    return this.publishPrepared("página");
  }

  async prepareTarget(target, text, media = []) {
    if (target.type === "profile") return this.preparePost(text, media);
    if (target.type === "group") return this.prepareGroupPost(target, text, media);
    if (target.type === "page") return this.preparePagePost(target, text, media);
    throw new Error("Destino de publicación no reconocido.");
  }

  async publishTarget(target, text, media = []) {
    if (target.type === "profile") return this.publishPost(text, media);
    if (target.type === "group") return this.publishGroupPost(target, text, media);
    if (target.type === "page") return this.publishPagePost(target, text, media);
    throw new Error("Destino de publicación no reconocido.");
  }

  // Historias: se usa el creador de /stories/create (texto o foto/video), no el
  // cuadro "¿Qué estás pensando?", que publicaría en el muro.
  async prepareStory(text = "", media = []) {
    if (this.identitySwitched) await this.ensurePersonalProfile();
    const cleanTextValue = String(text || "").trim();
    if (cleanTextValue.length > 500) throw new Error("El texto de una historia no puede superar 500 caracteres.");
    const mediaIds = media.map((item) => typeof item === "string" ? item : item?.id).filter(Boolean);
    const attachments = mediaIds.map((id) => mediaStore.get(id)).filter(Boolean);
    if (attachments.length !== mediaIds.length) throw new Error("Uno de los archivos adjuntos ya no está disponible. Volvé a seleccionarlo.");
    const visual = attachments.find((item) => /^(image|video)\//.test(item.mimeType || ""));
    if (!visual && cleanTextValue.length < 3) throw new Error("Escribí el texto de la historia o adjuntá una foto o video.");
    await this.open();
    await this.homePage.goto("https://www.facebook.com/stories/create", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await this.homePage.bringToFront();
    if (await this.isLoggedOut(this.homePage)) throw new Error("El perfil conectado no tiene una sesión activa.");
    await this.homePage.waitForTimeout(2_500);
    if (visual) {
      const input = this.homePage.locator("input[type='file']").first();
      if (!(await input.count())) throw new Error("Facebook no mostró el selector de fotos para la historia.");
      await input.setInputFiles(visual.path);
      await this.homePage.waitForTimeout(visual.mimeType.startsWith("video/") ? 6_000 : 3_000);
      if (cleanTextValue) {
        await this.clickVisibleButton(/Agregar texto|Add text/i);
        await this.homePage.waitForTimeout(800);
        const editor = await this.visibleEditor();
        if (editor) await editor.fill(cleanTextValue);
      }
    } else {
      const textStory = this.homePage.getByRole("button", { name: /Crear una historia de texto|Create a text story/i }).first();
      if (!(await textStory.count())) throw new Error("Facebook no mostró la opción de historia de texto.");
      await textStory.click();
      await this.homePage.waitForTimeout(1_500);
      const editor = await this.visibleEditor();
      if (!editor) throw new Error("Facebook no mostró el campo de texto de la historia.");
      await editor.fill(cleanTextValue);
    }
    await this.homePage.waitForTimeout(800);
    this.preparedPost = { text: cleanTextValue, mediaIds, kind: "story", destinationId: "story", destinationUrl: "https://www.facebook.com/stories/create" };
    return { prepared: true, url: this.homePage.url(), media: attachments.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })) };
  }

  async publishStory(text, media = []) {
    await this.prepareStory(text, media);
    return this.publishPrepared("story");
  }

  async prepareReply(event, text) {
    if (!event?.url) throw new Error("Este aviso no tiene un enlace de origen.");
    if (!text || text.trim().length < 1) throw new Error("Escribí una respuesta antes de continuar.");
    if (text.length > 2_000) throw new Error("La respuesta no puede superar 2.000 caracteres.");
    await this.openUrl(event.url);
    if (await this.isLoggedOut(this.homePage)) throw new Error("El perfil conectado no tiene una sesión activa.");
    await this.homePage.waitForTimeout(3_500);
    const editor = this.homePage.locator(
      "[contenteditable='true'][role='textbox'], [contenteditable='true'], textarea"
    ).last();
    if (!(await editor.count())) throw new Error("No encontré el campo de respuesta en este hilo.");
    await editor.fill(text.trim());
    return { prepared: true, source: event.source, url: this.homePage.url() };
  }

  async replyToEvent(event, text) {
    await this.prepareReply(event, text);
    const sendButton = this.homePage.getByRole("button", { name: /Enviar|Send|Comentar|Comment|Publicar|Post/i });
    if (await sendButton.count()) {
      await sendButton.last().click();
    } else {
      const editor = this.homePage.locator(
        "[contenteditable='true'][role='textbox'], [contenteditable='true'], textarea"
      ).last();
      if (!(await editor.count())) throw new Error("No encontré el botón para enviar la respuesta.");
      await editor.press("Enter");
    }
    await this.homePage.waitForTimeout(2_000);
    return { sent: true, source: event.source, url: this.homePage.url() };
  }

  async isLoggedOut(page) {
    const url = page.url().toLowerCase();
    if (url.includes("login") || url.includes("checkpoint")) return true;
    return page.evaluate(() => {
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const loginFields = Array.from(document.querySelectorAll("input[name='email'], input[name='pass'], input[type='password']")).some(visible);
      if (loginFields) return true;
      const labels = Array.from(document.querySelectorAll("button, a, [role='button']"))
        .filter(visible)
        .map((element) => (element.innerText || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim());
      return labels.some((label) => /^(iniciar sesión|iniciar sesion|log in|log into facebook|crear cuenta nueva|create new account)$/i.test(label));
    }).catch(() => false);
  }

  async waitForContent(page) {
    await page.waitForTimeout(2_000);
  }

  async waitForFacebookReady(page, timeout = 25_000) {
    const attempts = Math.ceil(timeout / 1_000);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const bodyLength = await page.evaluate(() => (document.body?.innerText || "").length).catch(() => 0);
      if (bodyLength > 200) return;
      await page.waitForTimeout(1_000);
    }
    throw new Error("Facebook todavía no terminó de cargar en el perfil conectado.");
  }

  async scrollAndCollectLinks(page, selector, maxRounds = 40) {
    const seen = new Map();
    let unchangedRounds = 0;
    for (let round = 0; round < maxRounds; round += 1) {
      if (this.cancelRequested) break;
      const rows = await page.locator(selector).evaluateAll((elements) => elements.map((element) => ({
        url: element.href || element.getAttribute("href") || "",
        text: element.innerText || "",
        ariaLabel: element.getAttribute("aria-label") || "",
        title: element.getAttribute("title") || "",
        image: (() => {
          const node = element.querySelector("img, svg image");
          return node ? node.getAttribute("xlink:href") || node.getAttribute("href") || node.src || "" : "";
        })(),
      })));
      const before = seen.size;
      for (const row of rows) {
        if (!row.url) continue;
        const key = row.url.split("#")[0];
        const existing = seen.get(key);
        // Facebook repite el enlace (foto y nombre): se combinan ambos.
        if (!existing) seen.set(key, row);
        else {
          if (!existing.image && row.image) existing.image = row.image;
          if (!existing.text.trim() && row.text.trim()) existing.text = row.text;
        }
      }
      const metrics = await page.evaluate(() => {
        const roots = [
          document.scrollingElement,
          document.querySelector("main"),
          document.querySelector("[role='main']"),
          document.querySelector("nav"),
          document.querySelector("[role='navigation']"),
          document.querySelector("[role='list']"),
          ...Array.from(document.querySelectorAll("div")),
        ].filter(Boolean);
        const scrollables = roots.filter((element, index) => roots.indexOf(element) === index && element.scrollHeight - element.clientHeight > 80);
        let moved = false;
        let atEnd = true;
        for (const element of scrollables.slice(0, 30)) {
          const previous = element.scrollTop;
          const next = Math.min(element.scrollHeight - element.clientHeight, previous + Math.max(450, element.clientHeight * 0.85));
          if (next > previous + 2) moved = true;
          element.scrollTop = next;
          if (element.scrollTop < element.scrollHeight - element.clientHeight - 4) atEnd = false;
        }
        const documentScroller = document.scrollingElement;
        if (documentScroller && documentScroller.scrollHeight > documentScroller.clientHeight) {
          const previous = documentScroller.scrollTop;
          window.scrollTo(0, documentScroller.scrollHeight);
          if (documentScroller.scrollTop > previous + 2) moved = true;
          if (documentScroller.scrollTop < documentScroller.scrollHeight - documentScroller.clientHeight - 4) atEnd = false;
        }
        return { moved, atEnd, scrollableCount: scrollables.length };
      }).catch(() => ({ moved: false, atEnd: true, scrollableCount: 0 }));
      unchangedRounds = seen.size === before ? unchangedRounds + 1 : 0;
      await page.waitForTimeout(700);
      if (!metrics.moved && unchangedRounds >= 2) break;
      if (metrics.atEnd && unchangedRounds >= 3) break;
    }
    return [...seen.values()];
  }

  async collectMessengerThreads(page) {
    const rows = await this.scrollAndCollectLinks(page, "a[href*='/messages/'], a[href*='/t/']", 50);
    console.log(`[scan/messenger] url=${page.url()} title=${await page.title()} candidates=${rows.length}`);
    const chats = [];
    const seen = new Set();
    for (const row of rows) {
      const url = normalizedLink(row.url, page.url(), ["messenger.com", "www.messenger.com", "facebook.com", "www.facebook.com"]);
      const id = url ? chatIdFromUrl(url) : null;
      if (!url || !id || seen.has(id)) continue;
      const rawText = String(row.text || row.ariaLabel || row.title || "");
      const raw = cleanText(rawText);
      if (!raw) continue;
      // Separar antes de limpiar: cleanText colapsa los saltos de línea que dividen nombre y vista previa.
      // "Activo ahora", "Activa hace 5 min"… son el estado de conexión, no el nombre ni el mensaje.
      const parts = rawText.split(/\n+|\s{2,}/).map((part) => cleanText(part)).filter((part) => part && !PRESENCE_LABEL.test(part));
      const name = (parts[0] || id).slice(0, 200);
      const preview = cleanText(parts.slice(1).join(" ") || raw, 2_000);
      const unreadMatch = raw.match(/(\d+)\s+(?:no\s+le[ií]dos?|unread)/i);
      seen.add(id);
      chats.push({
        id,
        externalId: id,
        name,
        preview,
        unreadCount: unreadMatch ? Number(unreadMatch[1]) : 0,
        url,
        kind: /e2ee/i.test(url) ? "encrypted" : "standard",
        avatarUrl: await this.cacheImage(row.image, `chat-${id}`),
        observedAt: now(),
      });
      if (chats.length >= MAX_CHATS) break;
    }
    return chats;
  }

  async extractMessageRows(page) {
    return page.evaluate(() => {
      const rows = [];
      const seen = new Set();
      for (const element of document.querySelectorAll("[aria-roledescription][aria-label]")) {
        const label = element.getAttribute("aria-label") || "";
        const match = label.match(/^(?:A las|At)\s+(.+?\d{1,2}:\d{2}(?:\s*[ap]\.?\s?m\.?)?),\s+(.+?):\s([\s\S]*)$/i);
        if (!match || seen.has(label)) continue;
        seen.add(label);
        rows.push({ marker: label.slice(0, 300), timestamp: match[1].trim(), sender: match[2].trim(), text: match[3].trim() });
      }
      return rows;
    }).catch(() => []);
  }

  async collectChatMessages(page, chat) {
    await page.goto(chat.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await this.waitForContent(page);
    if (await this.isLoggedOut(page)) throw new Error("La sesión de Messenger no está activa.");
    await page.waitForSelector("[aria-roledescription][aria-label]", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1_000);
    const messages = new Map();
    let unchangedRounds = 0;
    for (let round = 0; round < MAX_CHAT_HISTORY_PAGES; round += 1) {
      if (this.cancelRequested) break;
      const rows = await this.extractMessageRows(page);
      const before = messages.size;
      rows.forEach((row) => {
        const externalId = `${chat.id}:${row.marker || `${row.timestamp || ""}:${row.text.slice(0, 240)}`}`;
        messages.set(externalId, {
          id: externalId,
          externalId,
          chatId: chat.id,
          text: row.text,
          sender: row.sender || null,
          fromMe: /^(tú|you)$/i.test(row.sender || ""),
          timestamp: row.timestamp || null,
          sentAt: parseMessengerDate(row.timestamp),
          url: page.url(),
          observedAt: now(),
        });
      });
      const scroll = await page.evaluate(() => {
        // Contenedor desplazable más cercano a las burbujas de mensajes.
        let target = document.querySelector("[aria-roledescription][aria-label]")?.parentElement || null;
        while (target && !(target.scrollHeight - target.clientHeight > 40 && /auto|scroll/.test(getComputedStyle(target).overflowY))) target = target.parentElement;
        if (!target) {
          const previous = document.scrollingElement?.scrollTop || 0;
          window.scrollBy(0, -Math.max(500, window.innerHeight * 0.85));
          return { atTop: (document.scrollingElement?.scrollTop || 0) <= 4, moved: previous - (document.scrollingElement?.scrollTop || 0) > 2 };
        }
        const previous = target.scrollTop;
        target.scrollTop = Math.max(0, previous - Math.max(500, target.clientHeight * 0.85));
        return { atTop: target.scrollTop <= 4, moved: previous - target.scrollTop > 2 };
      }).catch(() => ({ atTop: true, moved: false }));
      unchangedRounds = messages.size === before ? unchangedRounds + 1 : 0;
      await page.waitForTimeout(1_200);
      if ((scroll.atTop && unchangedRounds >= 2) || (!scroll.moved && unchangedRounds >= 3)) break;
    }
    // Al desplazarse hacia arriba llegan primero los recientes: se ordena por fecha.
    const fullMessages = [...messages.values()]
      .sort((x, y) => String(x.sentAt || "").localeCompare(String(y.sentAt || "")))
      .slice(-MAX_CHAT_MESSAGES);
    const latest = fullMessages.at(-1);
    return {
      chat: {
        ...chat,
        messageCount: fullMessages.length,
        lastMessage: latest?.text || chat.preview,
        lastMessageAt: latest?.sentAt || latest?.timestamp || null,
        syncedAt: now(),
      },
      messages: fullMessages,
    };
  }

  async collectMessenger(page, { deep = false } = {}) {
    const chats = await this.collectMessengerThreads(page);
    const messages = [];
    if (deep) {
      for (let index = 0; index < chats.length; index += 1) {
        if (this.cancelRequested) break;
        try {
          const detail = await this.collectChatMessages(page, chats[index]);
          chats[index] = detail.chat;
          messages.push(...detail.messages);
        } catch (error) {
          chats[index] = { ...chats[index], syncError: error.message, syncedAt: now() };
          console.warn(`[scan/messenger] no se pudo sincronizar ${chats[index].id}: ${error.message}`);
        }
      }
    }
    return {
      chats,
      messages,
      events: chats.map((chat) => ({
        source: "messenger",
        externalId: `${chat.id}:${chat.lastMessage || chat.preview || chat.name}`,
        text: cleanText([chat.name, chat.lastMessage || chat.preview, chat.unreadCount ? `${chat.unreadCount} no leídos` : ""].filter(Boolean).join(" · ")),
        url: chat.url,
        chatId: chat.id,
        avatarUrl: chat.avatarUrl || null,
      })),
    };
  }

  async collectNotifications(page) {
    for (let round = 0; round < 4; round += 1) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight)).catch(() => {});
      await page.waitForTimeout(900);
    }
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll("a[href*='notif_id']")).map((anchor) => {
      const image = anchor.querySelector("img, svg image");
      return {
        url: anchor.href,
        text: anchor.innerText || anchor.getAttribute("aria-label") || "",
        image: image ? image.getAttribute("xlink:href") || image.getAttribute("href") || image.src || "" : "",
      };
    })).catch(() => []);
    console.log(`[scan/notifications] url=${page.url()} candidates=${rows.length}`);
    const result = [];
    const seen = new Set();
    for (const row of rows) {
      let notifId = null;
      try { notifId = new URL(row.url).searchParams.get("notif_id"); } catch { notifId = null; }
      const lines = row.text.split("\n").map((line) => line.trim()).filter(Boolean)
        .filter((line) => !/^(no leída|unread|nueva|new)$/i.test(line));
      const timeLabel = lines.length > 1 && /^(\d+\s*(s|min|h|d|sem|m|a)|ayer|yesterday|hace|justo ahora|just now)/i.test(lines.at(-1)) ? lines.pop() : null;
      const text = cleanText(lines.join(" "), 1_000);
      if (!text) continue;
      const externalId = notifId || `${row.url}::${text.slice(0, 160)}`;
      if (seen.has(externalId)) continue;
      seen.add(externalId);
      const avatarUrl = await this.cacheImage(row.image, `notif-${createHash("sha1").update(externalId).digest("hex").slice(0, 20)}`);
      result.push({ source: "facebook_notification", externalId, text, url: row.url, timeLabel, avatarUrl, unreadOnFacebook: /no leída|unread/i.test(row.text) });
    }
    return result;
  }

  // Guarda una imagen de Facebook en disco: las URLs del CDN caducan a los pocos días.
  async cacheImage(sourceUrl, key, { refresh = false } = {}) {
    const base = key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
    if (!refresh) {
      const cached = [".jpg", ".png", ".webp"].map((extension) => base + extension).find((file) => existsSync(join(IMAGE_DIR, file)));
      if (cached) return `${BASE_PATH}/api/images/${cached}`;
    }
    if (!sourceUrl || !/^https:\/\//.test(sourceUrl)) return null;
    try {
      const response = await this.context.request.get(sourceUrl, { timeout: 20_000 });
      if (!response.ok()) return null;
      const type = response.headers()["content-type"] || "image/jpeg";
      const extension = type.includes("png") ? ".png" : type.includes("webp") ? ".webp" : ".jpg";
      const file = `${base}${extension}`;
      await mkdir(IMAGE_DIR, { recursive: true });
      await writeFile(join(IMAGE_DIR, file), await response.body());
      return `${BASE_PATH}/api/images/${file}`;
    } catch (error) {
      console.warn(`[images] no se pudo guardar ${key}: ${error.message}`);
      return null;
    }
  }

  async collectProfile() {
    await this.openUrl("https://www.facebook.com/me");
    await this.waitForFacebookReady(this.homePage);
    if (await this.isLoggedOut(this.homePage)) throw new Error("El perfil conectado no tiene una sesión activa.");
    await this.homePage.waitForTimeout(2_000);
    const profile = await this.homePage.evaluate(() => {
      const main = document.querySelector("[role='main']") || document.body;
      const lines = (main.innerText || "").split("\n").map((line) => line.trim()).filter(Boolean);
      // El nombre es la línea anterior al contador de seguidores/amigos.
      const statsIndex = lines.findIndex((line) => /seguidores|seguidos|amigos|followers|following|friends/i.test(line) && line.length < 120);
      const heading = document.querySelector("[role='main'] h1")?.innerText?.trim();
      const imageFor = (pattern) => {
        const holder = Array.from(document.querySelectorAll("[aria-label]")).find((element) => pattern.test(element.getAttribute("aria-label") || "") && element.querySelector("image, img"));
        const image = holder?.querySelector("image, img");
        return image ? image.getAttribute("xlink:href") || image.getAttribute("href") || image.src : null;
      };
      const largestAvatar = Array.from(main.querySelectorAll("svg image"))
        .map((image) => ({ src: image.getAttribute("xlink:href") || "", size: image.getBoundingClientRect().width }))
        .filter((image) => /t39\.30808-1/.test(image.src) && image.size >= 100)
        .sort((a, b) => b.size - a.size)[0]?.src || null;
      return {
        canonical: document.querySelector("link[rel='canonical']")?.href || location.href,
        name: heading || (statsIndex > 0 ? lines[statsIndex - 1] : "") || document.querySelector("meta[property='og:title']")?.content || "",
        stats: statsIndex >= 0 ? lines[statsIndex] : null,
        avatar: imageFor(/acciones de foto del perfil|profile picture actions|foto del perfil/i) || largestAvatar || document.querySelector("meta[property='og:image']")?.content || null,
        cover: imageFor(/foto de portada|cover photo/i),
        details: lines.slice(Math.max(0, statsIndex + 1), statsIndex + 14)
          .filter((line) => !/^(panel|editar|más|todo|información|reels|fotos|amigos|edit|more|all|about|photos|friends|datos personales)$/i.test(line))
          .slice(0, 6),
      };
    });
    const url = normalizedLink(profile.canonical, this.homePage.url()) || this.homePage.url();
    const id = url.match(/[?&]id=([^&]+)/i)?.[1] || url.split("/").filter(Boolean).at(-1) || "profile";
    const fullName = cleanText(profile.name || "Perfil de Facebook", 200);
    const alias = fullName.match(/^(.*?)\s*\((.+)\)\s*$/);
    return {
      id,
      name: alias ? alias[1] : fullName,
      alternateName: alias ? alias[2] : null,
      url,
      stats: profile.stats ? cleanText(profile.stats, 200) : null,
      details: profile.details || [],
      avatarUrl: await this.cacheImage(profile.avatar, `profile-avatar-${id}`, { refresh: true }) || profile.avatar,
      coverUrl: await this.cacheImage(profile.cover, `profile-cover-${id}`, { refresh: true }) || profile.cover,
      syncedAt: now(),
    };
  }

  async collectGroups() {
    const sources = ["https://www.facebook.com/groups/joins", "https://www.facebook.com/groups/feed"];
    const rows = [];
    for (const source of sources) {
      if (this.cancelRequested) break;
      await this.openUrl(source);
      await this.waitForFacebookReady(this.homePage);
      if (await this.isLoggedOut(this.homePage)) throw new Error("El perfil conectado no tiene una sesión activa.");
      rows.push(...await this.scrollAndCollectLinks(this.homePage, "a[href*='/groups/']", 150));
    }
    const groups = [];
    const seen = new Set();
    for (const row of rows) {
      const url = normalizedLink(row.url, this.homePage.url());
      if (!url) continue;
      const parts = new URL(url).pathname.split("/").filter(Boolean);
      const groupId = parts[0] === "groups" ? parts[1] : null;
      if (!groupId || ["joins", "feed", "discover", "search", "create"].includes(groupId) || seen.has(groupId)) continue;
      const rawName = cleanText(row.text || row.ariaLabel || row.title || groupId, 160);
      // Facebook agrega "Activo por última vez hace…" al texto del enlace; se guarda aparte.
      const activity = rawName.match(/\s*((?:Activo por última vez|Última actividad|Last active)\b.*)$/i);
      const name = activity ? rawName.slice(0, activity.index).trim() || rawName : rawName;
      if (name.length < 2) continue;
      seen.add(groupId);
      groups.push({ id: groupId, name, url, lastActive: activity ? activity[1].trim() : null, avatarUrl: await this.cacheImage(row.image, `group-${groupId}`), syncedAt: now() });
    }
    return groups.slice(0, 3_000);
  }

  async collectPages() {
    await this.openUrl("https://www.facebook.com/pages/?category=your_pages");
    await this.waitForFacebookReady(this.homePage);
    if (await this.isLoggedOut(this.homePage)) throw new Error("El perfil conectado no tiene una sesión activa.");
    let previous = -1;
    for (let round = 0; round < 15; round += 1) {
      if (this.cancelRequested) break;
      const count = await this.homePage.locator("a[href*='ad_center'][href*='page_id=']").count();
      if (count === previous) break;
      previous = count;
      await this.homePage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await this.homePage.waitForTimeout(1_200);
    }
    // Cada tarjeta de "Páginas que administras" tiene el enlace a la página y
    // uno de "Promocionar" con el page_id numérico.
    const rows = await this.homePage.evaluate(() => {
      const main = document.querySelector("[role='main']") || document.body;
      const isPageLink = (anchor) => !/ad_center|\/latest\/|business\.facebook|\/settings|\/notifications/.test(anchor.href) && (anchor.innerText || "").trim().length > 1;
      return Array.from(main.querySelectorAll("a[href*='ad_center'][href*='page_id=']")).map((ad) => {
        let card = ad.parentElement;
        while (card && card !== main && !Array.from(card.querySelectorAll("a[href]")).some(isPageLink)) card = card.parentElement;
        const pageLink = card ? Array.from(card.querySelectorAll("a[href]")).find(isPageLink) : null;
        const text = card?.innerText || "";
        const image = card?.querySelector("svg image, img");
        return {
          pageId: new URL(ad.href).searchParams.get("page_id"),
          url: pageLink?.href || null,
          name: (pageLink?.innerText || "").trim(),
          notifications: Number(text.match(/(\d+)\s+notificaci/i)?.[1] || 0),
          messages: Number(text.match(/(\d+)\s+mensaje/i)?.[1] || 0),
          avatar: image ? image.getAttribute("xlink:href") || image.src : null,
        };
      });
    });
    const pages = [];
    const seen = new Set();
    for (const row of rows) {
      if (!row.pageId || !row.url || seen.has(row.pageId)) continue;
      seen.add(row.pageId);
      const link = new URL(row.url);
      const url = link.pathname.includes("profile.php")
        ? `https://www.facebook.com/profile.php?id=${link.searchParams.get("id")}`
        : normalizedLink(row.url, this.homePage.url());
      pages.push({
        id: row.pageId,
        name: cleanText(row.name, 160),
        url,
        notificationCount: row.notifications,
        messageCount: row.messages,
        avatarUrl: await this.cacheImage(row.avatar, `page-${row.pageId}`, { refresh: true }) || row.avatar,
        syncedAt: now(),
      });
    }
    return pages.slice(0, 500);
  }

  async collectFacebookNotifications() {
    const notifications = await this.context.newPage();
    try {
      await notifications.goto("https://www.facebook.com/notifications", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await this.waitForContent(notifications);
      if (await this.isLoggedOut(notifications)) throw new Error("Facebook pide iniciar sesión o completar una verificación.");
      return await this.collectNotifications(notifications);
    } finally {
      await notifications.close();
    }
  }

  async openMessengerPage() {
    await this.open();
    const messenger = await this.context.newPage();
    try {
      await messenger.goto("https://www.messenger.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
      await this.waitForContent(messenger);
      const continueButton = messenger.getByRole("button", { name: /Continuar como/i });
      if (await continueButton.count()) {
        console.log("[scan/messenger] pantalla de bienvenida detectada; continuando la sesión ya autenticada");
        await continueButton.first().click();
        await this.waitForContent(messenger);
      }
      if (await this.isLoggedOut(messenger)) throw new Error(this.mode === "headless" ? "La sesión de Facebook no está activa. Usá “Mostrar navegador” para iniciar sesión." : "No hay una sesión activa. Iniciá sesión en la ventana de Facebook y volvé a escanear.");
      return messenger;
    } catch (error) {
      await messenger.close().catch(() => {});
      throw error;
    }
  }

  // chats/notifications permiten que el monitoreo respete lo elegido en Sincronización.
  async scan({ deep = false, chats = true, notifications = true } = {}) {
    await this.open();
    const empty = { chats: [], messages: [], events: [] };
    let messengerData = empty;
    if (chats) {
      const messenger = await this.openMessengerPage();
      try {
        messengerData = await this.collectMessenger(messenger, { deep });
      } finally {
        await messenger.close();
        this.lastUrl = this.homePage?.url() || this.lastUrl;
      }
    }
    return { ...messengerData, notifications: notifications ? await this.collectFacebookNotifications() : [] };
  }

  async syncAll() {
    await this.open();
    const profile = await this.collectProfile();
    const groups = await this.collectGroups();
    const pages = await this.collectPages();
    const messenger = await this.context.newPage();
    try {
      await messenger.goto("https://www.messenger.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
      await this.waitForContent(messenger);
      const continueButton = messenger.getByRole("button", { name: /Continuar como/i });
      if (await continueButton.count()) {
        await continueButton.first().click();
        await this.waitForContent(messenger);
      }
      if (await this.isLoggedOut(messenger)) throw new Error("No hay una sesión activa de Messenger.");
      const messengerData = await this.collectMessenger(messenger, { deep: true });
      return { profile, groups, pages, messenger: messengerData, notifications: await this.collectFacebookNotifications() };
    } finally {
      await messenger.close();
    }
  }

  // Descarta un editor a medio abrir para que el siguiente destino empiece limpio.
  async resetComposer() {
    this.preparedPost = null;
    if (!this.homePage || this.homePage.isClosed()) return;
    await this.homePage.keyboard.press("Escape").catch(() => {});
    await this.homePage.goto("about:blank").catch(() => {});
  }

  // Lectura de publicaciones visibles del perfil, una página o un grupo.
  // Solo guarda lo que la sesión muestra al desplazarse; no usa APIs privadas.
  // Facebook ofusca el texto de los contenedores, así que se leen los nodos del
  // mensaje (story_message) y el enlace permanente, que se genera al pasar el mouse.
  async collectPosts(owner, maxRounds = MAX_POST_SCROLLS) {
    if (!owner?.url) throw new Error("El destino no tiene un enlace para leer publicaciones.");
    await this.openUrl(owner.url);
    await this.waitForFacebookReady(this.homePage);
    if (await this.isLoggedOut(this.homePage)) throw new Error("El perfil conectado no tiene una sesión activa.");
    await this.homePage.waitForTimeout(1_500);
    const found = new Map();
    let unchangedRounds = 0;
    for (let round = 0; round < maxRounds; round += 1) {
      if (this.cancelRequested) break;
      await this.homePage.evaluate(() => {
        for (const post of document.querySelectorAll("[aria-posinset]")) {
          const message = post.querySelector("[data-ad-rendering-role='story_message'], [data-ad-preview='message'], [data-ad-comet-preview='message']");
          const more = message && Array.from(message.querySelectorAll("[role='button']")).find((button) => /^(ver más|see more)$/i.test(button.innerText.trim()));
          if (more) more.click();
          for (const anchor of post.querySelectorAll("a[href]")) {
            anchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
            anchor.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
          }
        }
      }).catch(() => {});
      await this.homePage.waitForTimeout(700);
      const rows = await this.homePage.evaluate(() => Array.from(document.querySelectorAll("[aria-posinset]")).map((post) => {
        const message = post.querySelector("[data-ad-rendering-role='story_message'], [data-ad-preview='message'], [data-ad-comet-preview='message']");
        const links = Array.from(post.querySelectorAll("a[href]"));
        const permalink = links.find((anchor) => /\/posts\/|\/permalink|story_fbid=|pfbid/i.test(anchor.href))
          || links.find((anchor) => /\/videos\/|\/photo|\/reel\//i.test(anchor.href));
        const images = Array.from(post.querySelectorAll("img"))
          .filter((image) => image.getBoundingClientRect().width > 180 && /scontent|fbcdn/.test(image.src))
          .map((image) => image.src);
        return {
          text: (message?.innerText || "").trim(),
          author: (post.querySelector("h2, h3, h4, strong")?.innerText || "").trim(),
          permalink: permalink?.href || null,
          timeLabel: permalink?.getAttribute("aria-label") || null,
          images,
        };
      })).catch(() => []);
      const before = found.size;
      for (const row of rows) {
        const text = cleanText(row.text, 5_000);
        if (!text && !row.images.length) continue;
        let key = null;
        if (row.permalink) {
          try {
            const link = new URL(row.permalink);
            key = link.searchParams.get("story_fbid") || link.searchParams.get("fbid") || link.pathname.replace(/\/$/, "");
          } catch { key = null; }
        }
        key ||= createHash("sha1").update(`${row.author}|${text.slice(0, 400)}|${row.images[0] || ""}`).digest("hex").slice(0, 20);
        const id = `${owner.type}:${owner.id}:${key}`;
        if (found.has(id)) continue;
        let url = owner.url;
        if (row.permalink) {
          try {
            const link = new URL(row.permalink);
            for (const param of [...link.searchParams.keys()]) if (param.startsWith("__")) link.searchParams.delete(param);
            link.hash = "";
            url = link.href;
          } catch { url = row.permalink; }
        }
        found.set(id, {
          id,
          ownerType: owner.type,
          ownerId: owner.id,
          ownerName: owner.name,
          author: cleanText(row.author, 200) || owner.name,
          url,
          text,
          postedLabel: row.timeLabel ? cleanText(row.timeLabel, 120) : null,
          imageUrl: row.images[0] || null,
          imageCount: row.images.length,
          observedAt: now(),
        });
      }
      unchangedRounds = found.size === before ? unchangedRounds + 1 : 0;
      if (unchangedRounds >= 3) break;
      await this.homePage.evaluate(() => window.scrollBy(0, Math.max(900, window.innerHeight * 1.2))).catch(() => {});
      await this.homePage.waitForTimeout(1_800);
    }
    const posts = [...found.values()];
    // Las imágenes del CDN caducan: se guarda una copia local de cada una.
    for (const post of posts) {
      if (post.imageUrl) post.imageUrl = await this.cacheImage(post.imageUrl, `post-${createHash("sha1").update(post.id).digest("hex").slice(0, 24)}`) || post.imageUrl;
    }
    return posts;
  }
}

const facebook = new FacebookAgent();

// Ejecuta una tarea con el navegador solo si está libre; si no, devuelve null
// y la cola de IA lo reintenta en el próximo ciclo.
async function withBrowser(task) {
  if (!facebook.isOpen || busyMessage() || facebook.preparedPost) return null;
  actionInProgress = true;
  actionStartedAt = Date.now();
  try {
    return await task();
  } finally {
    actionInProgress = false;
  }
}

const ai = createAiReplies({ getStore: () => store, persist, broadcast, facebook, now, cleanText, withBrowser, onInteraction: (interaction) => crm.onInteraction(interaction) });
const crm = createCrm({ getStore: () => store, persist, broadcast, now, cleanText });
const explorerJob = { running: false, kind: null, detail: null, error: null, result: null };
const explorer = createGroupsExplorer({ getStore: () => store, persist, broadcast, facebook, now, cleanText, withBrowser });
const instagram = createInstagram({ getStore: () => store, persist, broadcast, facebook, now, cleanText, withBrowser, mediaById: (id) => mediaStore.get(id) });
const instagramState = { running: false, detail: null, finishedAt: null, error: null };

function applyMessengerData(messenger = {}) {
  const chats = (messenger.chats || []).map((chat) => ({
    ...chat,
    firstSeenAt: store.chats.find((item) => item.id === chat.id)?.firstSeenAt || now(),
    lastSeenAt: now(),
  }));
  store.chats = mergeById(store.chats, chats);
  crm.syncChatNames(chats);
  const incomingMessages = (messenger.messages || []).map((message) => ({
    ...message,
    firstSeenAt: store.messages.find((item) => item.id === message.id)?.firstSeenAt || now(),
    lastSeenAt: now(),
  }));
  store.messages = mergeById(store.messages, incomingMessages);
  store.meta.lastChatSyncAt = now();
  return { chatCount: chats.length, messageCount: incomingMessages.length };
}

function exportCollection(kind) {
  switch (kind) {
    case "groups": return store.groups;
    case "pages": return store.pages;
    case "profile": return store.profile ? [store.profile] : [];
    case "chats": return store.chats;
    case "messages": return store.messages;
    case "events": return store.events;
    case "drafts": return store.drafts;
    case "schedules": return store.schedules;
    case "publications": return store.publications.map(({ target, ...rest }) => ({ ...rest, targetType: target?.type, targetId: target?.id, targetName: target?.name, media: (rest.media || []).join(" ") }));
    case "posts": return store.posts;
    case "crm-contacts": return store.crmContacts.map((item) => ({ id: item.id, nombre: item.name, telefono: item.phone || "", correo: item.email || "", empresa: item.company || "", etiquetas: (item.tags || []).join(" "), canales: store.crmIdentities.filter((identity) => identity.contactId === item.id).map((identity) => identity.channel).join(" "), creado: item.createdAt }));
    case "crm-opportunities": return store.crmOpportunities.map((item) => ({
      id: item.id,
      tablero: store.crmBoards.find((board) => board.id === item.boardId)?.name || "",
      columna: store.crmStages.find((stage) => stage.id === item.stageId)?.name || "",
      estado: item.status,
      titulo: item.title,
      contacto: store.crmContacts.find((contact) => contact.id === item.contactId)?.name || "",
      telefono: store.crmContacts.find((contact) => contact.id === item.contactId)?.phone || "",
      valor: item.value ?? "",
      producto: item.product || "",
      responsable: item.agent || "",
      canal: item.source?.channel || "",
      campana: item.source?.campaign || "",
      publicacion: item.source?.publicationId || "",
      creada: item.createdAt,
    }));
    case "all":
    default:
      return {
        exportedAt: now(),
        profile: store.profile,
        groups: store.groups,
        pages: store.pages,
        chats: store.chats,
        messages: store.messages,
        events: store.events,
        drafts: store.drafts,
        schedules: store.schedules,
        publications: store.publications,
        posts: store.posts,
      };
  }
}

function scheduleTargets(schedule) {
  if (Array.isArray(schedule.targets) && schedule.targets.length) return schedule.targets;
  if (schedule.destination === "profile") return [{ type: "profile", id: "profile", name: "Tu perfil" }];
  if (schedule.destination === "story") return [{ type: "story", id: "story", name: "Historia / estado" }];
  return [
    ...(schedule.includeProfile ? [{ type: "profile", id: "profile", name: "Tu perfil" }] : []),
    ...(schedule.groupIds || []).map((id) => ({ type: "group", id, name: store.groups.find((group) => group.id === id)?.name || id })),
    ...(schedule.pageIds || []).map((id) => ({ type: "page", id, name: store.pages.find((page) => page.id === id)?.name || id })),
  ];
}

const INSTAGRAM_FORMATS = { post: "Publicación", reel: "Reel", story: "Historia" };

function instagramTargetsFrom(list) {
  return (Array.isArray(list) ? list : []).map((item) => {
    const account = instagram.accounts().find((candidate) => candidate.id === item?.id && candidate.status === "connected");
    const format = INSTAGRAM_FORMATS[item?.format] ? item.format : "post";
    return account ? { type: "instagram", id: account.id, format, name: `@${account.username} · ${INSTAGRAM_FORMATS[format]}` } : null;
  }).filter(Boolean);
}

function storedTarget(target) {
  if (!target) return null;
  if (target.type === "instagram") return instagram.accounts().find((item) => item.id === target.id) || null;
  if (target.type === "profile") return store.profile || { id: "profile", name: "Tu perfil", url: "https://www.facebook.com/" };
  if (target.type === "story") return { id: "story", name: "Historia / estado", url: "https://www.facebook.com/" };
  if (target.type === "group") return store.groups.find((item) => item.id === target.id) || null;
  if (target.type === "page") return store.pages.find((item) => item.id === target.id) || null;
  return null;
}

function mediaIdsFrom(value) {
  return Array.isArray(value)
    ? value.map((item) => typeof item === "string" ? item : item?.id).filter((id) => mediaStore.has(id))
    : [];
}

function scheduleJob(target, runAt, text, index = 0, media = []) {
  return {
    id: randomUUID(),
    target,
    text: String(text || "").trim().slice(0, 5_000),
    media: Array.isArray(media) ? media : [],
    runAt,
    status: "queued",
    attempts: 0,
    order: index,
    createdAt: now(),
    lastError: null,
    publishedAt: null,
  };
}

function refreshScheduleState(schedule) {
  if (!Array.isArray(schedule.jobs)) return schedule;
  const jobs = schedule.jobs;
  const pending = jobs.filter((job) => ["queued", "running"].includes(job.status));
  const failed = jobs.filter((job) => job.status === "failed");
  schedule.completedCount = jobs.filter((job) => job.status === "published").length;
  schedule.failedCount = failed.length;
  schedule.nextRunAt = pending
    .map((job) => job.runAt)
    .filter(Boolean)
    .sort()[0] || null;
  const nextIndex = jobs.findIndex((job) => job.status !== "published");
  schedule.nextIndex = nextIndex === -1 ? jobs.length : nextIndex;
  if (schedule.status !== "paused") {
    schedule.status = pending.length ? "queued" : failed.length ? "failed" : "completed";
  }
  return schedule;
}

function ensureScheduleJobs(schedule) {
  if (Array.isArray(schedule.jobs)) {
    refreshScheduleState(schedule);
    return schedule.jobs;
  }
  const targets = scheduleTargets(schedule);
  const intervalMinutes = Math.max(1, Number(schedule.intervalMinutes) || 60);
  const startTimestamp = Date.parse(schedule.startAt || schedule.nextRunAt || now()) || Date.now();
  const publishedCount = Math.max(0, Math.min(targets.length, Number(schedule.nextIndex) || 0));
  schedule.targets = targets;
  schedule.jobs = targets.map((target, index) => ({
    ...scheduleJob(target, new Date(startTimestamp + index * intervalMinutes * 60_000).toISOString(), schedule.text, index, schedule.media || []),
    status: index < publishedCount ? "published" : "queued",
    attempts: index < publishedCount ? 1 : 0,
    publishedAt: index < publishedCount ? schedule.updatedAt || schedule.createdAt || now() : null,
  }));
  refreshScheduleState(schedule);
  return schedule.jobs;
}

function findScheduleJob(schedule, requestedId, requestedTargetId) {
  const jobs = ensureScheduleJobs(schedule);
  if (requestedId) return jobs.find((job) => job.id === requestedId) || null;
  if (requestedTargetId) {
    const matching = jobs.filter((job) => job.target?.id === requestedTargetId && job.status === "queued");
    if (matching.length) return matching.sort((a, b) => String(a.runAt).localeCompare(String(b.runAt)))[0];
  }
  return jobs.find((job) => job.status === "queued") || jobs.find((job) => job.status === "failed") || null;
}

function pendingScheduleCount() {
  return store.schedules.reduce((count, schedule) => count + ensureScheduleJobs(schedule).filter((job) => ["queued", "running"].includes(job.status)).length, 0);
}

async function publishScheduleJob(schedule, job) {
  const target = storedTarget(job.target);
  if (!target) throw new Error("El destino de la programación ya no está disponible.");
  const text = job.text || schedule.text;
  const media = job.media || schedule.media || [];
  if (job.target.type === "story") {
    return facebook.publishStory(text, media);
  }
  if (job.target.type === "instagram") {
    if (target.status !== "connected") throw new Error(`Requiere reconexión: @${target.username || target.pageName} no está conectada.`);
    return instagram.publish({ accountId: target.id, format: job.target.format || "post", media, caption: job.caption || text });
  }
  return facebook.publishTarget({ ...job.target, ...target }, text, media);
}

// Ejecuta un trabajo de la cola con el candado tomado por quien llama.
// Registra el resultado en el historial y avisa a los paneles abiertos.
async function executeScheduleJob(schedule, job, origin) {
  job.status = "running";
  job.attempts = (job.attempts || 0) + 1;
  job.startedAt = now();
  await persist();
  broadcast("schedule", { scheduleId: schedule.id, jobId: job.id, status: "running" });
  const text = job.text || schedule.text;
  const media = job.media || schedule.media || [];
  try {
    const limit = job.target?.type === "instagram" ? 6 * 60_000 : job.target?.type === "group" ? 75_000 : 45_000;
    const result = await runWithTimeout(() => publishScheduleJob(schedule, job), limit, job.target?.type === "instagram" ? "Instagram sigue procesando: revisá antes de reintentar para no duplicar." : "Facebook tardó demasiado en publicar la programación.");
    job.status = "published";
    job.publishedAt = now();
    job.lastError = null;
    recordPublication({ target: job.target, text, media, origin, url: result?.url, scheduleId: schedule.id, jobId: job.id, aiConfig: schedule.ai || null });
    return result;
  } catch (error) {
    job.status = "failed";
    job.failedAt = now();
    job.lastError = error.message;
    recordPublication({ target: job.target, text, media, origin, status: "failed", error: error.message, scheduleId: schedule.id, jobId: job.id });
    await facebook.resetComposer();
    throw error;
  } finally {
    refreshScheduleState(schedule);
    if (job.status === "failed" && schedule.status !== "paused") schedule.status = "failed";
    await persist();
    broadcast("schedule", { scheduleId: schedule.id, jobId: job.id, status: job.status });
  }
}

const bulkRuns = new Set();

// "Publicar en todo ahora": recorre los destinos uno por uno, sin depender del
// programador global. La confirmación la da la persona en el panel.
async function runScheduleNow(schedule) {
  if (bulkRuns.has(schedule.id)) return;
  bulkRuns.add(schedule.id);
  try {
    for (;;) {
      if (schedule.status === "paused" || !store.schedules.includes(schedule)) break;
      const job = schedule.jobs.find((item) => item.status === "queued");
      if (!job) break;
      const wait = Date.parse(job.runAt) - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 5_000)));
      if (Date.parse(job.runAt) > Date.now()) continue;
      if (actionInProgress || scanInProgress || scheduleRunInProgress || facebook.preparedPost) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        continue;
      }
      actionInProgress = true;
      actionStartedAt = Date.now();
      try {
        await executeScheduleJob(schedule, job, "bulk");
      } catch (error) {
        console.error(`[bulk] ${job.target?.name}: ${error.message}`);
      } finally {
        actionInProgress = false;
      }
    }
  } finally {
    bulkRuns.delete(schedule.id);
    broadcast("schedule", { scheduleId: schedule.id, status: schedule.status, finished: true });
  }
}

function busyMessage() {
  if (scanInProgress) return "Hay una sincronización en curso. Intentá de nuevo cuando termine.";
  if (actionInProgress) return "Facebook está ocupado con otra publicación. Intentá de nuevo en unos segundos.";
  return null;
}

// Evita que dos acciones usen la misma pestaña de Facebook a la vez.
// Ninguna tarea puede retener el navegador más de 6 minutos: si se cuelga,
// se libera el candado para que la cola (envíos masivos, IA) siga.
const ACTION_MAX_MS = 6 * 60_000;
let actionStartedAt = 0;
setInterval(() => {
  if (actionInProgress && actionStartedAt && Date.now() - actionStartedAt > ACTION_MAX_MS) {
    console.error("[lock] una tarea retuvo el navegador demasiado tiempo; se libera el candado");
    actionInProgress = false;
    actionStartedAt = 0;
    facebook.preparedPost = null;
  }
}, 30_000).unref();

async function exclusive(response, task) {
  const busy = busyMessage();
  if (busy) return sendJson(response, 409, { ok: false, error: busy });
  actionInProgress = true;
  actionStartedAt = Date.now();
  facebook.cancelRequested = false;
  try {
    return await task();
  } finally {
    actionInProgress = false;
    actionStartedAt = 0;
    facebook.cancelRequested = false;
  }
}

function dashboardSummary() {
  const days = 14;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const buckets = Array.from({ length: days }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return { date: day.toISOString().slice(0, 10), label: day.toLocaleDateString("es", { day: "2-digit", month: "short" }), events: 0, messages: 0, publications: 0 };
  });
  const bucketFor = (value) => {
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp) || timestamp < start.getTime()) return null;
    return buckets[Math.floor((timestamp - start.getTime()) / 86_400_000)] || null;
  };
  const kinds = {};
  for (const event of store.events) {
    kinds[event.kind || "other"] = (kinds[event.kind || "other"] || 0) + 1;
    const bucket = bucketFor(event.firstSeenAt);
    if (bucket) bucket[event.source === "messenger" ? "messages" : "events"] += 1;
  }
  for (const publication of store.publications) {
    const bucket = bucketFor(publication.createdAt);
    if (bucket && publication.status === "published") bucket.publications += 1;
  }
  const upcoming = store.schedules
    .flatMap((schedule) => (schedule.jobs || [])
      .filter((job) => job.status === "queued")
      .map((job) => ({ scheduleId: schedule.id, jobId: job.id, target: job.target, text: job.text || schedule.text, runAt: job.runAt, autoPublish: schedule.autoPublish === true, paused: schedule.status === "paused" })))
    .sort((a, b) => String(a.runAt).localeCompare(String(b.runAt)))
    .slice(0, 8);
  return {
    activity: buckets,
    kinds,
    upcoming,
    recentPublications: store.publications.slice(0, 8),
    totals: {
      publications: store.publications.filter((item) => item.status === "published").length,
      failedPublications: store.publications.filter((item) => item.status === "failed").length,
      posts: store.posts.length,
      unread: store.events.filter((event) => event.read !== true).length,
    },
  };
}

/* ------------------------------------------------------- Sincronización a pedido */
// Por defecto Niro solo publica: la descarga de información de Facebook ocurre
// únicamente con lo que la persona elige en "Sincronización".
const DEFAULT_SYNC_SETTINGS = {
  profile: true,
  pages: true,
  groups: true,
  notifications: false,
  chats: false,
  chatHistory: false,
  postsProfile: false,
  postPageIds: [],
  postGroupIds: [],
  monitorNotifications: true,
  monitorChats: true,
};

const SYNC_LABELS = {
  profile: "Perfil",
  pages: "Lista de páginas",
  groups: "Lista de grupos",
  notifications: "Notificaciones",
  chats: "Lista de chats",
  chatHistory: "Historial de mensajes",
  posts: "Publicaciones",
};

function syncSettings() {
  return { ...DEFAULT_SYNC_SETTINGS, ...(store.meta.syncSettings || {}) };
}

const syncState = {
  running: false,
  cancelRequested: false,
  items: [],
  current: null,
  detail: null,
  done: 0,
  total: 0,
  results: [],
  startedAt: null,
  finishedAt: null,
  error: null,
};

function publicSyncState() {
  return { ...syncState, results: [...syncState.results] };
}

function syncProgress(patch) {
  Object.assign(syncState, patch);
  broadcast("sync-progress", publicSyncState());
}

function mergePosts(posts) {
  const existing = new Map(store.posts.map((post) => [post.id, post]));
  for (const post of posts) existing.set(post.id, { ...existing.get(post.id), ...post, firstSeenAt: existing.get(post.id)?.firstSeenAt || now() });
  store.posts = [...existing.values()].sort((a, b) => String(b.firstSeenAt).localeCompare(String(a.firstSeenAt)));
}

async function upsertMany(inputs) {
  let newCount = 0;
  for (const input of inputs || []) if ((await upsertEvent(input)).isNew) newCount += 1;
  return newCount;
}

function postOwners(plan) {
  const owners = [];
  if (plan.postsProfile) owners.push({ type: "profile", id: store.profile?.id || "me", name: store.profile?.name || "Tu perfil", url: store.profile?.url || "https://www.facebook.com/me" });
  for (const id of plan.postPageIds || []) {
    const page = store.pages.find((item) => item.id === id);
    if (page) owners.push({ type: "page", id: page.id, name: page.name, url: page.url });
  }
  for (const id of (plan.postGroupIds || []).slice(0, 50)) {
    const group = store.groups.find((item) => item.id === id);
    if (group) owners.push({ type: "group", id: group.id, name: group.name, url: group.url });
  }
  return owners;
}

const SYNC_STEPS = {
  async profile() {
    store.profile = await facebook.collectProfile();
    return "perfil actualizado";
  },
  async pages() {
    const pages = await facebook.collectPages();
    store.pages = facebook.cancelRequested ? mergeById(store.pages, pages) : pages;
    store.meta.lastInventoryAt = now();
    return `${pages.length} páginas`;
  },
  async groups() {
    const groups = await facebook.collectGroups();
    // Si se detuvo a mitad se conservan los grupos ya guardados.
    store.groups = facebook.cancelRequested ? mergeById(store.groups, groups) : groups;
    store.meta.lastInventoryAt = now();
    return `${groups.length} grupos`;
  },
  async notifications() {
    const notifications = await facebook.collectFacebookNotifications();
    const newCount = await upsertMany(notifications);
    store.meta.lastScanAt = now();
    return `${notifications.length} notificaciones (${newCount} nuevas)`;
  },
  async chats() {
    const page = await facebook.openMessengerPage();
    try {
      const data = await facebook.collectMessenger(page, { deep: false });
      applyMessengerData(data);
      const newCount = await upsertMany(data.events);
      return `${data.chats.length} chats (${newCount} con novedades)`;
    } finally {
      await page.close().catch(() => {});
    }
  },
  async chatHistory(plan) {
    const chats = (plan.chatIds?.length ? store.chats.filter((chat) => plan.chatIds.includes(chat.id)) : store.chats);
    if (!chats.length) return "no hay chats: sincronizá primero la lista de chats";
    const page = await facebook.context.newPage();
    let messageCount = 0;
    try {
      for (let index = 0; index < chats.length; index += 1) {
        if (facebook.cancelRequested) break;
        syncProgress({ detail: `${index + 1}/${chats.length} · ${chats[index].name}` });
        try {
          const detail = await facebook.collectChatMessages(page, chats[index]);
          applyMessengerData({ chats: [detail.chat], messages: detail.messages });
          messageCount += detail.messages.length;
          await persist();
        } catch (error) {
          console.warn(`[sync/chatHistory] ${chats[index].id}: ${error.message}`);
        }
      }
    } finally {
      await page.close().catch(() => {});
    }
    store.meta.lastChatSyncAt = now();
    return `${messageCount} mensajes`;
  },
  async posts(plan) {
    const owners = postOwners(plan);
    if (!owners.length) return "no se eligió ningún perfil, página o grupo";
    let collected = 0;
    const errors = [];
    for (let index = 0; index < owners.length; index += 1) {
      if (facebook.cancelRequested) break;
      syncProgress({ detail: `${index + 1}/${owners.length} · ${owners[index].name}` });
      try {
        const posts = await facebook.collectPosts(owners[index]);
        mergePosts(posts);
        collected += posts.length;
        await persist();
      } catch (error) {
        errors.push(`${owners[index].name}: ${error.message}`);
      }
    }
    store.meta.lastPostSyncAt = now();
    return `${collected} publicaciones${errors.length ? ` · ${errors.length} con error` : ""}`;
  },
};

// Ejecuta en segundo plano los pasos elegidos, en orden, con progreso y cancelación.
async function runSyncPlan(plan) {
  const order = ["profile", "pages", "groups", "notifications", "chats", "chatHistory", "posts"];
  const items = order.filter((key) => plan.items.includes(key));
  scanInProgress = true;
  facebook.cancelRequested = false;
  syncProgress({ running: true, cancelRequested: false, items, current: null, detail: null, done: 0, total: items.length, results: [], startedAt: now(), finishedAt: null, error: null });
  try {
    await facebook.open();
    for (const key of items) {
      if (facebook.cancelRequested) break;
      syncProgress({ current: key, detail: SYNC_LABELS[key] });
      try {
        const summary = await SYNC_STEPS[key](plan);
        syncState.results.push({ key, label: SYNC_LABELS[key], ok: true, summary });
      } catch (error) {
        console.error(`[sync/${key}] falló`, error.message);
        syncState.results.push({ key, label: SYNC_LABELS[key], ok: false, summary: error.message });
      }
      await persist();
      syncProgress({ done: syncState.done + 1 });
    }
  } catch (error) {
    syncProgress({ error: error.message });
  } finally {
    const cancelled = facebook.cancelRequested;
    facebook.cancelRequested = false;
    scanInProgress = false;
    await persist();
    syncProgress({ running: false, current: null, detail: cancelled ? "Detenida por la persona" : null, cancelRequested: cancelled, finishedAt: now() });
    broadcast("sync", { kind: "plan", cancelled });
  }
}

/* ---------------------------------------------------------------- Seguridad */
// Contraseña opcional del panel (obligatoria si se expone fuera de este equipo).
const PANEL_PASSWORD = process.env.NIRO_PANEL_PASSWORD || "";
const SESSION_SECRET = process.env.NIRO_SESSION_SECRET || createHash("sha256").update(`niro:${PANEL_PASSWORD}:${PROFILE_PATH}`).digest("hex");
const SESSION_DAYS = 14;
// Hosts aceptados en la cabecera Host: evita ataques de DNS rebinding.
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", HOST, ...(process.env.NIRO_ALLOWED_HOSTS || "").split(",").map((item) => item.trim()).filter(Boolean)]);
const loginAttempts = new Map();

function signSession(issuedAt) {
  return `${issuedAt}.${createHmac("sha256", SESSION_SECRET).update(`session:${issuedAt}`).digest("hex")}`;
}

function validSession(token) {
  const [issuedAt, signature] = String(token || "").split(".");
  if (!issuedAt || !signature || Date.now() - Number(issuedAt) > SESSION_DAYS * 86_400_000) return false;
  const expected = Buffer.from(signSession(issuedAt).split(".")[1]);
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function cookieValue(request, name) {
  const match = String(request.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function isAuthenticated(request) {
  return !PANEL_PASSWORD || validSession(cookieValue(request, "niro_session"));
}

function applySecurityHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  // SAMEORIGIN: Niro (mismo dominio) muestra el panel dentro de su propio layout en un iframe.
  response.setHeader("x-frame-options", "SAMEORIGIN");
  response.setHeader("content-security-policy", "frame-ancestors 'self'");
  response.setHeader("referrer-policy", "same-origin");
  response.setHeader("cross-origin-opener-policy", "same-origin");
}

// Devuelve un mensaje de rechazo o null si la petición es aceptable.
function rejectRequest(request, url) {
  const hostname = String(request.headers.host || "").replace(/:\d+$/, "");
  if (!ALLOWED_HOSTS.has(hostname)) return [421, "Host no permitido."];
  if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method)) {
    // Solo JSON: obliga a un preflight CORS, que este servidor nunca aprueba.
    if (!/^application\/json\b/i.test(request.headers["content-type"] || "")) return [415, "Las acciones deben enviarse como JSON."];
    const origin = request.headers.origin;
    // `url` siempre se arma con base "http://..." (ver más abajo), así que su protocolo no sirve
    // acá detrás de un proxy HTTPS: se usa el que puso el proxy (X-Forwarded-Proto) si vino.
    const proto = request.headers["x-forwarded-proto"] || url.protocol.replace(/:$/, "");
    if (origin && origin !== `${proto}://${request.headers.host}`) return [403, "Origen no permitido."];
  }
  return null;
}

async function handleLogin(request, response) {
  const ip = request.socket.remoteAddress || "local";
  const attempts = (loginAttempts.get(ip) || []).filter((time) => Date.now() - time < 15 * 60_000);
  if (attempts.length >= 8) return sendJson(response, 429, { ok: false, error: "Demasiados intentos. Esperá unos minutos." });
  const body = await readJson(request);
  const expected = Buffer.from(createHash("sha256").update(PANEL_PASSWORD).digest("hex"));
  const received = Buffer.from(createHash("sha256").update(String(body.password || "")).digest("hex"));
  if (!PANEL_PASSWORD || !timingSafeEqual(expected, received)) {
    loginAttempts.set(ip, [...attempts, Date.now()]);
    return sendJson(response, 401, { ok: false, error: "Contraseña incorrecta." });
  }
  loginAttempts.delete(ip);
  const secure = request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  response.setHeader("set-cookie", `niro_session=${encodeURIComponent(signSession(Date.now()))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86_400}${secure}`);
  return sendJson(response, 200, { ok: true });
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

// Une los fragmentos como bytes: un carácter UTF-8 puede quedar partido entre dos.
async function readRaw(request, limit = Infinity) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("El cuerpo de la petición es demasiado grande.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(request) {
  const body = await readRaw(request);
  return body ? JSON.parse(body) : {};
}

// Compara secretos sin filtrar su largo ni su contenido por tiempos de respuesta.
function sameSecret(received, expected) {
  if (!received || !expected) return false;
  const left = createHash("sha256").update(String(received)).digest();
  const right = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(left, right);
}

async function runWithTimeout(task, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      task(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------ CRM: webhooks de formularios */
const META_GRAPH_VERSION = process.env.NIRO_META_GRAPH_VERSION || "v23.0";

function leadContactFields(fields) {
  const find = (pattern) => fields.find((field) => pattern.test(field.name))?.value || null;
  const first = find(/^(first_name|nombre)$/i);
  const last = find(/^(last_name|apellido)$/i);
  return {
    name: find(/^(full_name|nombre_completo|name|fullname)$/i) || [first, last].filter(Boolean).join(" ") || null,
    phone: find(/phone|tel[eé]fono|celular|whatsapp/i),
    email: find(/e-?mail|correo/i),
  };
}

// Meta solo avisa el leadgen_id: los datos se piden a la Graph API con el token de la página.
async function receiveMetaLead(value) {
  const token = process.env.NIRO_META_PAGE_TOKEN;
  let fields = [];
  let attribution = { pageId: value.page_id || null, formId: value.form_id ? String(value.form_id) : null, adId: value.ad_id ? String(value.ad_id) : null };
  if (token && value.leadgen_id) {
    const response = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(value.leadgen_id)}?fields=created_time,field_data,ad_id,ad_name,adset_name,campaign_id,campaign_name,form_id&access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(20_000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `Graph API HTTP ${response.status}`);
    fields = (data.field_data || []).map((field) => ({ name: String(field.name), value: (field.values || []).join(", ") }));
    attribution = { ...attribution, campaign: data.campaign_name || null, campaignId: data.campaign_id || null, adName: data.ad_name || null, adsetName: data.adset_name || null, formId: data.form_id || attribution.formId };
  } else {
    fields = [{ name: "Aviso", value: "Definí NIRO_META_PAGE_TOKEN para traer nombre, teléfono y correo del formulario." }];
  }
  const person = leadContactFields(fields);
  return crm.captureLead({ provider: "meta", leadId: String(value.leadgen_id || ""), ...person, fields, attribution, receivedAt: value.created_time ? new Date(Number(value.created_time) * 1000).toISOString() : null });
}

async function crmWebhook(request, response, url, path) {
  if (path === "/webhooks/meta" && request.method === "GET") {
    const token = process.env.NIRO_META_VERIFY_TOKEN;
    if (!token) return sendJson(response, 503, { ok: false, error: "Webhook de Meta no configurado (NIRO_META_VERIFY_TOKEN)." });
    if (url.searchParams.get("hub.mode") !== "subscribe" || !sameSecret(url.searchParams.get("hub.verify_token"), token)) return sendJson(response, 403, { ok: false, error: "Token de verificación inválido." });
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return response.end(url.searchParams.get("hub.challenge") || "");
  }
  if (request.method !== "POST") return sendJson(response, 405, { ok: false, error: "Método no permitido." });
  let raw;
  try {
    raw = await readRaw(request, 1_000_000);
    JSON.parse(raw || "{}");
  } catch (error) {
    return sendJson(response, /grande/.test(error.message) ? 413 : 400, { ok: false, error: /grande/.test(error.message) ? error.message : "El cuerpo no es JSON válido." });
  }
  if (path === "/webhooks/meta") {
    const secret = process.env.NIRO_META_APP_SECRET;
    if (!secret) return sendJson(response, 503, { ok: false, error: "Webhook de Meta no configurado (NIRO_META_APP_SECRET)." });
    const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    if (!sameSecret(request.headers["x-hub-signature-256"], expected)) return sendJson(response, 401, { ok: false, error: "Firma inválida." });
    const payload = JSON.parse(raw || "{}");
    const leads = (payload.entry || []).flatMap((entry) => (entry.changes || []).filter((change) => change.field === "leadgen").map((change) => change.value || {}));
    // Meta espera la respuesta en segundos: los datos se buscan después.
    sendJson(response, 200, { ok: true, received: leads.length });
    for (const lead of leads) await receiveMetaLead(lead).catch((error) => console.error("[crm] formulario de Meta", error.message));
    return;
  }
  if (path === "/webhooks/google") {
    const key = process.env.NIRO_GOOGLE_LEAD_KEY;
    if (!key) return sendJson(response, 503, { ok: false, error: "Webhook de Google Ads no configurado (NIRO_GOOGLE_LEAD_KEY)." });
    const payload = JSON.parse(raw || "{}");
    if (!sameSecret(payload.google_key, key)) return sendJson(response, 401, { ok: false, error: "Clave inválida." });
    const fields = (payload.user_column_data || []).map((column) => ({ name: String(column.column_id || column.column_name || "campo").toLowerCase(), value: String(column.string_value ?? "") }));
    const person = leadContactFields(fields);
    await crm.captureLead({ provider: "google", leadId: String(payload.lead_id || ""), ...person, fields: payload.is_test ? [...fields, { name: "Prueba", value: "Lead de prueba de Google Ads" }] : fields, attribution: { campaignId: payload.campaign_id ? String(payload.campaign_id) : null, formId: payload.form_id ? String(payload.form_id) : null, adId: payload.creative_id ? String(payload.creative_id) : null, adgroupId: payload.adgroup_id ? String(payload.adgroup_id) : null, gclid: payload.gcl_id || null } });
    return sendJson(response, 200, {});
  }
  if (path === "/webhooks/web") {
    const token = process.env.NIRO_WEB_FORM_TOKEN;
    if (!token) return sendJson(response, 503, { ok: false, error: "Formulario web no configurado (NIRO_WEB_FORM_TOKEN)." });
    const payload = JSON.parse(raw || "{}");
    if (!sameSecret(request.headers["x-niro-token"] || payload.token, token)) return sendJson(response, 401, { ok: false, error: "Token inválido." });
    const fields = Object.entries(payload.fields && typeof payload.fields === "object" ? payload.fields : {}).map(([name, value]) => ({ name: cleanText(name, 60), value: cleanText(value, 500) }));
    if (payload.message) fields.unshift({ name: "Mensaje", value: cleanText(payload.message, 1_000) });
    const result = await crm.captureLead({ provider: "web", leadId: payload.id ? String(payload.id) : null, name: payload.name, phone: payload.phone, email: payload.email, fields, attribution: { campaign: payload.campaign || null, formName: payload.form || payload.source || "Formulario web", boardId: payload.boardId || null } });
    return sendJson(response, 200, { ok: true, duplicate: Boolean(result.duplicate) });
  }
  return sendJson(response, 404, { ok: false, error: "Webhook no encontrado." });
}

async function crmApi(request, response, url) {
  const path = url.pathname.replace(/^\/api\/crm/, "");
  if (path.startsWith("/webhooks/")) return crmWebhook(request, response, url, path);
  const body = ["POST", "PATCH", "DELETE"].includes(request.method) ? await readJson(request) : {};
  const attempt = async (task, status = 400) => {
    try {
      return sendJson(response, 200, { ok: true, ...(await task()) });
    } catch (error) {
      return sendJson(response, status, { ok: false, error: error.message });
    }
  };
  const { method } = request;
  if (method === "GET" && path === "/state") return sendJson(response, 200, { ok: true, ...crm.boardState(url.searchParams.get("boardId")) });
  if (method === "PATCH" && path === "/settings") return attempt(async () => ({ settings: await crm.updateSettings(body) }));
  if (method === "POST" && path === "/boards") return attempt(async () => ({ board: await crm.saveBoard(body) }));
  if (method === "POST" && path === "/stages") return attempt(async () => ({ stage: await crm.saveStage(body) }));
  if (method === "POST" && path === "/stages/reorder") return attempt(async () => { await crm.reorderStages(Array.isArray(body.ids) ? body.ids : []); return {}; });
  if (method === "POST" && path === "/opportunities") return attempt(async () => ({ opportunity: await crm.createManual(body, body.actor) }));
  if (method === "GET" && path === "/tasks") return sendJson(response, 200, { ok: true, tasks: crm.tasksList({ scope: url.searchParams.get("scope") || "open" }) });
  if (method === "POST" && path === "/tasks") return attempt(async () => ({ task: await crm.saveTask(body, body.actor) }));
  if (method === "GET" && path === "/contacts") return sendJson(response, 200, { ok: true, contacts: crm.contactsList({ q: url.searchParams.get("q") || "", duplicates: url.searchParams.get("duplicates") === "1" }) });
  if (method === "POST" && path === "/contacts/merge") return attempt(async () => ({ contact: await crm.mergeContacts(body.targetId, body.sourceId, body.actor) }));
  if (method === "POST" && path === "/contacts/dismiss-duplicate") return attempt(async () => { await crm.dismissDuplicate(body.contactId, body.otherId); return {}; });
  if (method === "POST" && path === "/capture/chat") return attempt(async () => crm.captureChat(body.chatId, { boardId: body.boardId, actor: body.actor }));
  if (method === "POST" && path === "/capture/event") return attempt(async () => crm.captureEventManual(body.eventId, { boardId: body.boardId, actor: body.actor }));
  if (method === "POST" && path === "/campaigns/preview") return attempt(async () => crm.previewCampaign(body));
  if (method === "GET" && path === "/campaigns") return sendJson(response, 200, { ok: true, campaigns: store.crmCampaigns.slice(0, 200) });
  if (method === "POST" && path === "/campaigns") return attempt(async () => ({ campaign: await crm.saveCampaign(body, body.actor) }));
  if (method === "GET" && path === "/reports") return sendJson(response, 200, { ok: true, report: crm.reports({ boardId: url.searchParams.get("boardId"), from: url.searchParams.get("from"), to: url.searchParams.get("to") }) });
  if (method === "GET" && path === "/webhooks-status") {
    return sendJson(response, 200, { ok: true, meta: Boolean(process.env.NIRO_META_VERIFY_TOKEN && process.env.NIRO_META_APP_SECRET), metaToken: Boolean(process.env.NIRO_META_PAGE_TOKEN), google: Boolean(process.env.NIRO_GOOGLE_LEAD_KEY), web: Boolean(process.env.NIRO_WEB_FORM_TOKEN) });
  }
  let match = path.match(/^\/boards\/([\w-]+)$/);
  if (method === "DELETE" && match) return attempt(async () => { await crm.deleteBoard(match[1]); return {}; });
  match = path.match(/^\/stages\/([\w-]+)$/);
  if (method === "DELETE" && match) return attempt(async () => { await crm.deleteStage(match[1], body.moveTo || null, body.actor); return {}; });
  match = path.match(/^\/opportunities\/([\w-]+)$/);
  if (match && method === "GET") {
    const detail = crm.opportunityDetail(match[1]);
    return detail ? sendJson(response, 200, { ok: true, ...detail }) : sendJson(response, 404, { ok: false, error: "Tarjeta no encontrada." });
  }
  if (match && method === "PATCH") return attempt(async () => ({ opportunity: await crm.updateOpportunity(match[1], body, body.actor) }));
  if (match && method === "DELETE") return attempt(async () => { await crm.deleteOpportunity(match[1]); return {}; });
  match = path.match(/^\/opportunities\/([\w-]+)\/(move|notes)$/);
  if (match && method === "POST") return attempt(async () => (match[2] === "move" ? crm.moveOpportunity(match[1], body) : { activity: await crm.addNote(match[1], { ...body, mediaIds: mediaIdsFrom(body.mediaIds || []) }) }));
  match = path.match(/^\/history\/([\w-]+)$/);
  if (match && method === "PATCH") return attempt(async () => ({ history: await crm.setHistoryReason(match[1], body.reason) }));
  match = path.match(/^\/tasks\/([\w-]+)$/);
  if (match && method === "PATCH") return attempt(async () => ({ task: await crm.saveTask({ ...body, id: match[1] }, body.actor) }));
  match = path.match(/^\/contacts\/([\w-]+)$/);
  if (match && method === "PATCH") return attempt(async () => ({ contact: await crm.updateContact(match[1], body, body.actor) }));
  if (match && method === "DELETE") return attempt(async () => crm.deleteContact(match[1]));
  match = path.match(/^\/campaigns\/([\w-]+)\/recipients$/);
  if (match && method === "GET") {
    const rows = crm.campaignRecipients(match[1]);
    if (url.searchParams.get("format") !== "csv") return sendJson(response, 200, { ok: true, recipients: rows });
    const records = rows.map((row) => ({ nombre: row.name, telefono: row.phone || "", correo: row.email || "", canal: row.channel, estado: row.status === "eligible" ? "disponible" : "excluido", motivo: row.reason || "" }));
    response.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="niro-campana-${match[1].slice(0, 8)}.csv"`, "cache-control": "no-store" });
    return response.end(`﻿${recordsAsCsv(records)}`);
  }
  return sendJson(response, 404, { ok: false, error: "Ruta del CRM no encontrada." });
}

async function api(request, response, url) {
  console.log(`[api] ${request.method} ${url.pathname}`);
  if (url.pathname.startsWith("/api/crm/")) return crmApi(request, response, url);
  if (request.method === "GET" && url.pathname === "/api/status") {
    return sendJson(response, 200, {
      ok: true,
      browserOpen: facebook.isOpen,
      browserMode: facebook.mode || null,
      headless: facebook.headless,
      remoteView: REMOTE_VIEW,
      browserUrl: facebook.lastUrl,
      profilePath: PROFILE_PATH,
      lastScanAt: store.meta.lastScanAt,
      eventCount: store.events.length,
      draftCount: store.drafts.length,
      groupCount: store.groups.length,
      pageCount: store.pages.length,
      chatCount: store.chats.length,
      messageCount: store.messages.length,
      profile: store.profile,
      scheduleCount: store.schedules.length,
      pendingScheduleCount: pendingScheduleCount(),
      lastInventoryAt: store.meta.lastInventoryAt,
      lastChatSyncAt: store.meta.lastChatSyncAt,
      scanInProgress,
      monitor: { ...monitorState, intervalSeconds: POLL_SECONDS },
      scheduler: { ...schedulerState, intervalSeconds: SCHEDULE_SECONDS },
      publicationCount: store.publications.length,
      postCount: store.posts.length,
      lastPostSyncAt: store.meta.lastPostSyncAt,
      actionInProgress,
      bulkRunning: bulkRuns.size,
      storage: pgStore
        ? { engine: "postgresql", lastSavedAt: pgStore.lastSavedAt, lastError: pgStore.lastError }
        : { engine: "json", path: STORE_PATH },
      authEnabled: Boolean(PANEL_PASSWORD),
      ai: { enabled: ai.settings().enabled, emergencyStop: ai.settings().emergencyStop, mode: ai.settings().mode, pending: store.aiInteractions.filter((item) => item.status === "pending").length },
      sync: { running: syncState.running, current: syncState.current, detail: syncState.detail, done: syncState.done, total: syncState.total },
      explorer: {
        attention: store.discoveredGroups.filter((group) => group.status === "attention").length,
        scheduled: store.groupJoinTasks.filter((task) => task.status === "scheduled").length,
        running: explorerJob.running,
      },
      crm: {
        open: store.crmOpportunities.filter((item) => item.status === "open").length,
        tasksOverdue: store.crmTasks.filter((task) => task.status === "open" && Date.parse(task.dueAt) <= Date.now()).length,
      },
      safeMode: true,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/stream") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    response.write(": conectado\n\n");
    streamClients.add(response);
    const heartbeat = setInterval(() => response.write(": ping\n\n"), 25_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      streamClients.delete(response);
    });
    return;
  }

  /* ------------------------------------------------ Instagram */
  /* ---------------------------------------------------------- Explorar grupos */
  if (request.method === "GET" && url.pathname === "/api/explorer/state") {
    return sendJson(response, 200, {
      ok: true,
      statuses: GROUP_STATUSES,
      segments: store.groupSegments,
      groups: store.discoveredGroups,
      tasks: [...store.groupJoinTasks].sort((a, b) => String(b.runAt).localeCompare(String(a.runAt))).slice(0, 500),
      settings: { paused: Boolean(store.meta.groupsExplorer?.paused) },
      job: explorerJob,
      account: store.profile?.name || null,
    });
  }
  if (request.method === "POST" && url.pathname === "/api/explorer/segments") {
    try {
      const segment = await explorer.saveSegment(await readJson(request));
      broadcast("groups-explorer", { kind: "segments" });
      return sendJson(response, 200, { ok: true, segment });
    } catch (error) {
      return sendJson(response, 400, { ok: false, error: error.message });
    }
  }
  const segmentMatch = url.pathname.match(/^\/api\/explorer\/segments\/([\w-]+)$/);
  if (request.method === "DELETE" && segmentMatch) {
    try {
      await explorer.deleteSegment(segmentMatch[1]);
      broadcast("groups-explorer", { kind: "segments" });
      return sendJson(response, 200, { ok: true });
    } catch (error) {
      return sendJson(response, 404, { ok: false, error: error.message });
    }
  }
  if (request.method === "POST" && ["/api/explorer/search", "/api/explorer/check", "/api/explorer/about"].includes(url.pathname)) {
    if (explorerJob.running) return sendJson(response, 409, { ok: false, error: "Ya hay una búsqueda o revisión en curso." });
    if (syncState.running) return sendJson(response, 409, { ok: false, error: "Esperá a que termine la sincronización." });
    if (!facebook.isOpen) return sendJson(response, 409, { ok: false, error: "Conectá Facebook antes de explorar grupos." });
    const body = await readJson(request);
    const kind = url.pathname.split("/").pop();
    const onProgress = (detail) => { explorerJob.detail = detail; broadcast("groups-explorer", { kind: "progress", detail }); };
    let task;
    if (kind === "search") {
      const ids = Array.isArray(body.segmentIds) ? body.segmentIds : [body.segmentId];
      const segments = ids.map((id) => store.groupSegments.find((item) => item.id === id)).filter(Boolean);
      if (!segments.length) return sendJson(response, 404, { ok: false, error: "Elegí un segmento para buscar." });
      task = async () => {
        const totals = { added: 0, seen: 0 };
        for (const segment of segments) {
          if (facebook.cancelRequested) break;
          const result = await explorer.searchSegment(segment.id, { onProgress: (detail) => onProgress(`${segment.name} · ${detail}`) });
          totals.added += result.added;
          totals.seen += result.seen;
        }
        return totals;
      };
    } else if (kind === "check") {
      task = () => explorer.checkMemberships({ onProgress });
    } else {
      const ids = (Array.isArray(body.groupIds) ? body.groupIds : []).slice(0, 50);
      const groups = ids.map((id) => store.discoveredGroups.find((item) => item.id === id)).filter(Boolean);
      if (!groups.length) return sendJson(response, 404, { ok: false, error: "Elegí al menos un grupo." });
      task = async () => {
        for (let index = 0; index < groups.length; index += 1) {
          if (facebook.cancelRequested) break;
          onProgress(`${index + 1}/${groups.length} · ${groups[index].name}`);
          await explorer.waitForBrowser(() => explorer.readAbout(groups[index]));
          await persist();
        }
        return { read: groups.length };
      };
    }
    facebook.cancelRequested = false;
    Object.assign(explorerJob, { running: true, kind, detail: "Iniciando…", error: null, result: null, startedAt: now() });
    broadcast("groups-explorer", { kind: "job" });
    task()
      .then((result) => { explorerJob.result = result; })
      .catch((error) => { explorerJob.error = readableError(error); })
      .finally(async () => {
        facebook.cancelRequested = false;
        Object.assign(explorerJob, { running: false, detail: null, finishedAt: now() });
        await persist().catch(() => {});
        broadcast("groups-explorer", { kind: "job" });
      });
    return sendJson(response, 202, { ok: true, job: explorerJob });
  }
  if (request.method === "POST" && url.pathname === "/api/explorer/cancel") {
    if (!explorerJob.running) return sendJson(response, 200, { ok: true, idle: true });
    facebook.cancelRequested = true;
    explorerJob.detail = "Deteniendo…";
    broadcast("groups-explorer", { kind: "progress", detail: explorerJob.detail });
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === "POST" && url.pathname === "/api/explorer/groups/status") {
    const body = await readJson(request);
    const allowed = ["review", "selected", "discarded", "rejected", "member", "requested"];
    if (!allowed.includes(body.status)) return sendJson(response, 400, { ok: false, error: "Estado no válido." });
    const ids = new Set(Array.isArray(body.groupIds) ? body.groupIds : []);
    let changed = 0;
    for (const group of store.discoveredGroups) {
      if (!ids.has(group.id)) continue;
      group.status = body.status;
      group.updatedAt = now();
      if (body.status === "requested") group.requestedAt = group.requestedAt || now();
      if (body.status === "member") {
        group.memberSince = group.memberSince || now();
        explorer.adoptGroup(group);
      }
      changed += 1;
    }
    // Un grupo descartado o ya resuelto no debe seguir en la agenda.
    if (body.status !== "selected") {
      for (const task of store.groupJoinTasks) if (ids.has(task.groupId) && task.status === "scheduled") Object.assign(task, { status: "cancelled", note: "Cancelada al cambiar el estado del grupo." });
    }
    await persist();
    broadcast("groups-explorer", { kind: "groups" });
    return sendJson(response, 200, { ok: true, changed });
  }
  if (request.method === "POST" && url.pathname === "/api/explorer/groups/delete") {
    const body = await readJson(request);
    const ids = new Set(Array.isArray(body.groupIds) ? body.groupIds : []);
    const before = store.discoveredGroups.length;
    store.discoveredGroups = store.discoveredGroups.filter((group) => !ids.has(group.id));
    store.groupJoinTasks = store.groupJoinTasks.filter((task) => !(ids.has(task.groupId) && task.status === "scheduled"));
    await persist();
    broadcast("groups-explorer", { kind: "groups" });
    return sendJson(response, 200, { ok: true, removed: before - store.discoveredGroups.length });
  }
  if (request.method === "POST" && url.pathname === "/api/explorer/schedule") {
    try {
      const body = await readJson(request);
      const tasks = await explorer.scheduleJoins({ groupIds: Array.isArray(body.groupIds) ? body.groupIds : [], startDate: body.startDate, perDay: body.perDay, fromHour: body.fromHour, toHour: body.toHour });
      return sendJson(response, 200, { ok: true, tasks });
    } catch (error) {
      return sendJson(response, 400, { ok: false, error: error.message });
    }
  }
  if (request.method === "POST" && url.pathname === "/api/explorer/tasks/cancel") {
    const body = await readJson(request);
    const ids = new Set(Array.isArray(body.taskIds) ? body.taskIds : []);
    let cancelled = 0;
    for (const task of store.groupJoinTasks) {
      if (!ids.has(task.id) || task.status !== "scheduled") continue;
      Object.assign(task, { status: "cancelled", note: "Cancelada por el usuario." });
      const group = store.discoveredGroups.find((item) => item.id === task.groupId);
      if (group?.status === "scheduled") group.status = "selected";
      cancelled += 1;
    }
    await persist();
    broadcast("groups-explorer", { kind: "tasks" });
    return sendJson(response, 200, { ok: true, cancelled });
  }
  if (request.method === "POST" && url.pathname === "/api/explorer/tasks/clear") {
    const before = store.groupJoinTasks.length;
    store.groupJoinTasks = store.groupJoinTasks.filter((task) => task.status === "scheduled");
    await persist();
    broadcast("groups-explorer", { kind: "tasks" });
    return sendJson(response, 200, { ok: true, removed: before - store.groupJoinTasks.length });
  }
  // Preguntas de ingreso y reglas las completa la persona: se abre el grupo con ventana visible.
  if (request.method === "POST" && url.pathname === "/api/explorer/open") {
    const body = await readJson(request);
    const group = store.discoveredGroups.find((item) => item.id === body.groupId);
    if (!group) return sendJson(response, 404, { ok: false, error: "Grupo no encontrado." });
    const busy = busyMessage();
    if (busy) return sendJson(response, 409, { ok: false, error: busy });
    try {
      if (facebook.headless) await facebook.setHeadless(false);
      await facebook.openUrl(group.url);
      return sendJson(response, 200, { ok: true, message: `Se abrió ${group.name} en la ventana de Niro. Completá las preguntas o reglas, enviá la solicitud y después volvé a segundo plano y presioná “Revisar ahora”.` });
    } catch (error) {
      return sendJson(response, 500, { ok: false, error: readableError(error) });
    }
  }
  if (request.method === "POST" && url.pathname === "/api/explorer/settings") {
    const body = await readJson(request);
    store.meta.groupsExplorer = { ...(store.meta.groupsExplorer || {}), paused: Boolean(body.paused) };
    await persist();
    broadcast("groups-explorer", { kind: "settings" });
    return sendJson(response, 200, { ok: true, settings: store.meta.groupsExplorer });
  }

  if (request.method === "GET" && url.pathname === "/api/instagram/accounts") {
    return sendJson(response, 200, { ok: true, accounts: instagram.accounts(), state: instagramState });
  }
  if (request.method === "POST" && url.pathname === "/api/instagram/discover") {
    if (instagramState.running) return sendJson(response, 409, { ok: false, error: "Ya se están revisando las cuentas." });
    if (!facebook.isOpen) return sendJson(response, 409, { ok: false, error: "Conectá Facebook antes de revisar Instagram." });
    const body = await readJson(request);
    Object.assign(instagramState, { running: true, detail: "Iniciando…", error: null });
    instagram.discover({ pageIds: Array.isArray(body.pageIds) ? body.pageIds : null, onProgress: (detail) => { instagramState.detail = detail; broadcast("instagram", { kind: "progress", detail }); } })
      .catch((error) => { instagramState.error = error.message; })
      .finally(() => { Object.assign(instagramState, { running: false, detail: null, finishedAt: now() }); broadcast("instagram", { kind: "done" }); });
    return sendJson(response, 202, { ok: true, state: instagramState });
  }
  if (request.method === "POST" && url.pathname === "/api/instagram/publish") {
    return exclusive(response, async () => {
      const body = await readJson(request);
      const [target] = instagramTargetsFrom([{ id: body.accountId, format: body.format }]);
      if (!target) return sendJson(response, 404, { ok: false, error: "La cuenta de Instagram no está conectada." });
      const caption = String(body.caption || "").trim().slice(0, 2_200);
      try {
        const result = await runWithTimeout(() => instagram.publish({ accountId: target.id, format: target.format, media: mediaIdsFrom(body.media), caption }), 6 * 60_000, "Instagram sigue procesando: revisá antes de reintentar para no duplicar.");
        recordPublication({ target, text: caption, media: body.media, url: result.url, aiConfig: await publicationAi(body.ai, caption) });
        await persist();
        return sendJson(response, 200, { ok: true, ...result });
      } catch (error) {
        recordPublication({ target, text: caption, media: body.media, status: "failed", error: error.message });
        await persist();
        await facebook.resetComposer().catch(() => {});
        return sendJson(response, 409, { ok: false, error: error.message, reconnect: Boolean(error.reconnect) });
      }
    });
  }

  // Prepara en Business Suite sin publicar (vista previa real / prueba).
  if (request.method === "POST" && url.pathname === "/api/instagram/prepare") {
    return exclusive(response, async () => {
      try {
        const body = await readJson(request);
        const result = await runWithTimeout(() => instagram.prepare(body), 180_000, "Business Suite tardó demasiado en preparar Instagram.");
        facebook.preparedPost = { kind: "instagram", accountId: body.accountId };
        return sendJson(response, 200, { ok: true, format: result.format, account: result.account.username, url: result.url });
      } catch (error) {
        if (/^(1|true)$/i.test(process.env.NIRO_DEBUG || "")) await facebook.homePage?.screenshot({ path: join(DATA_DIR, "debug-snapshot.png") }).catch(() => {});
        await facebook.resetComposer().catch(() => {});
        return sendJson(response, 409, { ok: false, error: error.message });
      }
    });
  }
  if (request.method === "POST" && url.pathname === "/api/instagram/connect") {
    // La vinculación la completa la persona en Business Suite (inicio de sesión de Instagram incluido).
    const body = await readJson(request);
    const page = store.pages.find((item) => item.id === body.pageId);
    if (!page) return sendJson(response, 404, { ok: false, error: "Página no encontrada." });
    const busy = busyMessage();
    if (busy) return sendJson(response, 409, { ok: false, error: busy });
    try {
      if (facebook.headless) await facebook.setHeadless(false);
      await facebook.openUrl(`https://business.facebook.com/latest/settings/instagram_account?asset_id=${page.id}`);
      return sendJson(response, 200, { ok: true, message: `Se abrió Business Suite para vincular Instagram a ${page.name}. Al terminar, volvé a segundo plano y presioná “Revisar cuentas”.` });
    } catch (error) {
      return sendJson(response, 500, { ok: false, error: error.message });
    }
  }

  /* ------------------------------------------------ Respuestas inteligentes */
  if (request.method === "GET" && url.pathname === "/api/ai/state") {
    return sendJson(response, 200, { ok: true, settings: ai.settings(), stats: ai.stats(), prompts: ai.prompts(), departments: await ai.departments() });
  }
  if (request.method === "PATCH" && url.pathname === "/api/ai/settings") {
    return sendJson(response, 200, { ok: true, settings: await ai.updateSettings(await readJson(request)) });
  }
  if (request.method === "GET" && url.pathname === "/api/ai/interactions") {
    const status = url.searchParams.get("status");
    const category = url.searchParams.get("category");
    const channel = url.searchParams.get("channel");
    const items = store.aiInteractions.filter((item) => (!status || item.status === status) && (!category || item.category === category) && (!channel || item.channel === channel));
    return sendJson(response, 200, { ok: true, interactions: items.slice(0, 300), total: items.length });
  }
  const aiActionMatch = url.pathname.match(/^\/api\/ai\/interactions\/([^/]+)\/(approve|edit|ignore|derive|regenerate|retry|takeover|release)$/);
  if (request.method === "POST" && aiActionMatch) {
    try {
      const interaction = await ai.act(aiActionMatch[1], aiActionMatch[2], await readJson(request));
      return sendJson(response, 200, { ok: true, interaction });
    } catch (error) {
      return sendJson(response, 400, { ok: false, error: error.message });
    }
  }
  if (request.method === "POST" && url.pathname === "/api/ai/prompts") {
    try {
      return sendJson(response, 200, { ok: true, prompt: await ai.savePrompt(await readJson(request)) });
    } catch (error) {
      return sendJson(response, 400, { ok: false, error: error.message });
    }
  }
  const aiPromptMatch = url.pathname.match(/^\/api\/ai\/prompts\/([^/]+)$/);
  if (request.method === "DELETE" && aiPromptMatch) {
    try {
      return sendJson(response, 200, { ok: true, prompt: await ai.deletePrompt(aiPromptMatch[1]) });
    } catch (error) {
      return sendJson(response, 404, { ok: false, error: error.message });
    }
  }
  if (request.method === "POST" && url.pathname === "/api/ai/test") {
    try {
      return sendJson(response, 200, { ok: true, ...(await ai.test(await readJson(request))) });
    } catch (error) {
      return sendJson(response, 502, { ok: false, error: error.message });
    }
  }
  if (request.method === "POST" && url.pathname === "/api/ai/backfill") {
    if (!ai.settings().enabled) return sendJson(response, 409, { ok: false, error: "Activá primero las respuestas con IA." });
    const body = await readJson(request);
    return sendJson(response, 200, { ok: true, added: await ai.backfill(body.hours) });
  }
  if (request.method === "GET" && url.pathname === "/api/ai/leads") {
    return sendJson(response, 200, { ok: true, leads: store.leads.slice(0, 500) });
  }
  if (request.method === "GET" && url.pathname === "/api/ai/audit") {
    const id = url.searchParams.get("interaction");
    return sendJson(response, 200, { ok: true, audit: store.aiAudit.filter((item) => !id || item.interactionId === id).slice(0, 300) });
  }

  if (request.method === "GET" && url.pathname === "/api/sync/state") {
    return sendJson(response, 200, { ok: true, state: publicSyncState(), settings: syncSettings(), busy: busyMessage() });
  }

  if (request.method === "PATCH" && url.pathname === "/api/sync/settings") {
    const body = await readJson(request);
    const next = syncSettings();
    for (const key of ["profile", "pages", "groups", "notifications", "chats", "chatHistory", "postsProfile", "monitorNotifications", "monitorChats"]) {
      if (typeof body[key] === "boolean") next[key] = body[key];
    }
    if (Array.isArray(body.postPageIds)) next.postPageIds = body.postPageIds.filter((id) => store.pages.some((page) => page.id === id));
    if (Array.isArray(body.postGroupIds)) next.postGroupIds = body.postGroupIds.filter((id) => store.groups.some((group) => group.id === id)).slice(0, 50);
    store.meta.syncSettings = next;
    await persist();
    return sendJson(response, 200, { ok: true, settings: next });
  }

  if (request.method === "POST" && url.pathname === "/api/sync/run") {
    const busy = busyMessage();
    if (busy) return sendJson(response, 409, { ok: false, error: busy });
    if (!facebook.isOpen) return sendJson(response, 409, { ok: false, error: "Conectá Facebook antes de sincronizar." });
    const body = await readJson(request);
    const settings = syncSettings();
    const valid = ["profile", "pages", "groups", "notifications", "chats", "chatHistory", "posts"];
    // Sin lista explícita se usa lo marcado en la configuración.
    const items = Array.isArray(body.items)
      ? body.items.filter((item) => valid.includes(item))
      : valid.filter((item) => item === "posts" ? settings.postsProfile || settings.postPageIds.length || settings.postGroupIds.length : settings[item]);
    if (!items.length) return sendJson(response, 400, { ok: false, error: "Elegí al menos un tipo de información para sincronizar." });
    const plan = {
      items,
      chatIds: Array.isArray(body.chatIds) ? body.chatIds : null,
      postsProfile: typeof body.postsProfile === "boolean" ? body.postsProfile : settings.postsProfile,
      postPageIds: Array.isArray(body.postPageIds) ? body.postPageIds : settings.postPageIds,
      postGroupIds: Array.isArray(body.postGroupIds) ? body.postGroupIds : settings.postGroupIds,
    };
    runSyncPlan(plan).catch((error) => console.error("[sync] falló", error.stack || error.message));
    return sendJson(response, 202, { ok: true, state: publicSyncState() });
  }

  if (request.method === "POST" && url.pathname === "/api/sync/cancel") {
    if (!scanInProgress && !actionInProgress && !syncState.running) return sendJson(response, 200, { ok: true, idle: true });
    facebook.cancelRequested = true;
    syncProgress({ cancelRequested: true, detail: "Deteniendo…" });
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    return sendJson(response, 200, { ok: true, ...dashboardSummary() });
  }

  if (request.method === "GET" && url.pathname === "/api/db/status") {
    if (!pgStore) return sendJson(response, 200, { ok: true, engine: "json", path: STORE_PATH });
    try {
      return sendJson(response, 200, { ok: true, engine: "postgresql", ...(await pgStore.stats()), lastSavedAt: pgStore.lastSavedAt, lastError: pgStore.lastError });
    } catch (error) {
      return sendJson(response, 503, { ok: false, engine: "postgresql", error: error.message });
    }
  }

  if (request.method === "GET" && url.pathname === "/api/publications") {
    const limit = Math.max(1, Math.min(1_000, Number(url.searchParams.get("limit") || 200)));
    return sendJson(response, 200, { publications: store.publications.slice(0, limit) });
  }

  // Limpieza del historial: solo borra registros de Niro, no publicaciones en las redes.
  if (request.method === "POST" && url.pathname === "/api/publications/delete") {
    const body = await readJson(request);
    const ids = new Set(Array.isArray(body.ids) ? body.ids.map(String) : []);
    if (!ids.size) return sendJson(response, 400, { ok: false, error: "No se indicó qué eliminar." });
    const before = store.publications.length;
    store.publications = store.publications.filter((item) => !ids.has(item.id));
    await persist();
    broadcast("publication", { deleted: before - store.publications.length });
    return sendJson(response, 200, { ok: true, deleted: before - store.publications.length, remaining: store.publications.length });
  }

  if (request.method === "POST" && url.pathname === "/api/posts/delete") {
    const body = await readJson(request);
    const ids = new Set(Array.isArray(body.ids) ? body.ids.map(String) : []);
    if (!ids.size) return sendJson(response, 400, { ok: false, error: "No se indicó qué eliminar." });
    const removed = store.posts.filter((item) => ids.has(item.id));
    store.posts = store.posts.filter((item) => !ids.has(item.id));
    // Las imágenes guardadas localmente de esas publicaciones también se borran.
    for (const post of removed) {
      const file = /^\/api\/images\/([a-zA-Z0-9_.-]+)$/.exec(post.imageUrl || "")?.[1];
      if (file && file.startsWith("post-")) await unlink(join(IMAGE_DIR, file)).catch(() => {});
    }
    await persist();
    return sendJson(response, 200, { ok: true, deleted: removed.length, remaining: store.posts.length });
  }

  const publicationStatusMatch = url.pathname.match(/^\/api\/publications\/([^/]+)\/status$/);
  if (request.method === "POST" && publicationStatusMatch) {
    const publication = store.publications.find((item) => item.id === publicationStatusMatch[1]);
    if (!publication) return sendJson(response, 404, { ok: false, error: "Publicación no encontrada." });
    const body = await readJson(request);
    if (!["published", "failed"].includes(body.status)) return sendJson(response, 400, { ok: false, error: "Estado inválido." });
    publication.status = body.status;
    publication.correctedAt = now();
    publication.note = body.status === "published" ? "Marcada como publicada desde el panel (verificada en la red)." : "Marcada como fallida desde el panel.";
    await persist();
    return sendJson(response, 200, { ok: true, publication });
  }

  if (request.method === "GET" && url.pathname === "/api/posts") {
    const ownerType = url.searchParams.get("ownerType");
    const ownerId = url.searchParams.get("ownerId");
    const posts = store.posts.filter((post) => (!ownerType || post.ownerType === ownerType) && (!ownerId || post.ownerId === ownerId));
    return sendJson(response, 200, { posts: posts.slice(0, 1_000), total: posts.length, lastPostSyncAt: store.meta.lastPostSyncAt });
  }

  if (request.method === "POST" && url.pathname === "/api/posts/scan") {
    return exclusive(response, async () => {
      try {
        const body = await readJson(request);
        const owners = [];
        if (body.profile !== false) owners.push({ type: "profile", id: store.profile?.id || "me", name: store.profile?.name || "Tu perfil", url: store.profile?.url || "https://www.facebook.com/me" });
        const pageIds = Array.isArray(body.pageIds) ? body.pageIds : body.allPages === false ? [] : store.pages.map((page) => page.id);
        for (const id of pageIds) {
          const page = store.pages.find((item) => item.id === id);
          if (page) owners.push({ type: "page", id: page.id, name: page.name, url: page.url });
        }
        for (const id of (Array.isArray(body.groupIds) ? body.groupIds : []).slice(0, 25)) {
          const group = store.groups.find((item) => item.id === id);
          if (group) owners.push({ type: "group", id: group.id, name: group.name, url: group.url });
        }
        if (!owners.length) throw new Error("Elegí al menos un perfil, página o grupo para leer publicaciones.");
        const errors = [];
        let collected = 0;
        await runWithTimeout(async () => {
          for (const owner of owners) {
            try {
              const posts = await facebook.collectPosts(owner);
              const existing = new Map(store.posts.map((post) => [post.id, post]));
              for (const post of posts) existing.set(post.id, { ...existing.get(post.id), ...post, firstSeenAt: existing.get(post.id)?.firstSeenAt || now() });
              store.posts = [...existing.values()].sort((a, b) => String(b.firstSeenAt).localeCompare(String(a.firstSeenAt)));
              collected += posts.length;
              broadcast("posts", { owner: owner.name, count: posts.length });
            } catch (error) {
              errors.push(`${owner.name}: ${error.message}`);
            }
          }
        }, 15 * 60_000, "La lectura de publicaciones tardó demasiado.");
        store.meta.lastPostSyncAt = now();
        await persist();
        return sendJson(response, 200, { ok: true, owners: owners.length, collected, total: store.posts.length, errors });
      } catch (error) {
        console.error("[api/posts/scan] falló", error.stack || error.message);
        return sendJson(response, 409, { ok: false, error: error.message });
      }
    });
  }

  if (request.method === "POST" && url.pathname === "/api/publish/bulk") {
    try {
      const body = await readJson(request);
      const text = String(body.text || "").trim();
      if (text.length < 3) throw new Error("Escribí un texto de al menos 3 caracteres.");
      const requested = Array.isArray(body.targets) ? body.targets : [];
      const targets = [];
      for (const target of requested) {
        if (target?.type === "profile") targets.push({ type: "profile", id: "profile", name: "Tu perfil" });
        else if (target?.type === "story") targets.push({ type: "story", id: "story", name: "Historia / estado" });
        else if (target?.type === "group") {
          const group = store.groups.find((item) => item.id === target.id);
          if (group) targets.push({ type: "group", id: group.id, name: group.name });
        } else if (target?.type === "page") {
          const page = store.pages.find((item) => item.id === target.id);
          if (page) targets.push({ type: "page", id: page.id, name: page.name });
        }
      }
      targets.push(...instagramTargetsFrom(body.instagramTargets));
      const unique = targets.filter((target, index) => targets.findIndex((item) => item.type === target.type && item.id === target.id && item.format === target.format) === index);
      if (!unique.length) throw new Error("Elegí al menos un destino.");
      if (unique.some((target) => target.type === "instagram") && !mediaIdsFrom(body.media).length) throw new Error("Instagram necesita una imagen o video.");
      if (!facebook.isOpen) throw new Error("Conectá Facebook antes de publicar en varios destinos.");
      const spacingSeconds = Math.max(20, Math.min(3_600, Number(body.spacingSeconds) || 45));
      const media = mediaIdsFrom(body.media);
      const start = Date.now();
      const jobs = unique.map((target, index) => scheduleJob(target, new Date(start + index * spacingSeconds * 1_000).toISOString(), text, index, media));
      for (const job of jobs) if (job.target.type === "instagram") job.caption = String(body.instagramCaption || "").trim().slice(0, 2_200) || text;
      const schedule = {
        id: randomUUID(),
        destination: "all",
        groupIds: unique.filter((target) => target.type === "group").map((target) => target.id),
        pageIds: unique.filter((target) => target.type === "page").map((target) => target.id),
        includeProfile: unique.some((target) => target.type === "profile"),
        targets: unique,
        text,
        media,
        startAt: new Date(start).toISOString(),
        intervalMinutes: Math.max(1, Math.round(spacingSeconds / 60)),
        spacingSeconds,
        nextIndex: 0,
        status: "queued",
        autoPublish: false,
        mode: "bulk",
        ai: await publicationAi(body.ai, text),
        jobs,
        completedCount: 0,
        failedCount: 0,
        createdAt: now(),
      };
      refreshScheduleState(schedule);
      store.schedules.unshift(schedule);
      await persist();
      runScheduleNow(schedule).catch((error) => console.error("[bulk] falló", error.stack || error.message));
      return sendJson(response, 202, { ok: true, schedule });
    } catch (error) {
      return sendJson(response, 400, { ok: false, error: error.message });
    }
  }

  const runNowMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)\/run$/);
  if (request.method === "POST" && runNowMatch) {
    const schedule = store.schedules.find((item) => item.id === runNowMatch[1]);
    if (!schedule) return sendJson(response, 404, { ok: false, error: "Programación no encontrada." });
    if (!facebook.isOpen) return sendJson(response, 409, { ok: false, error: "Conectá Facebook antes de ejecutar la programación." });
    ensureScheduleJobs(schedule);
    const pending = schedule.jobs.filter((job) => job.status === "queued");
    if (!pending.length) return sendJson(response, 409, { ok: false, error: "Esta programación no tiene publicaciones pendientes." });
    pending.forEach((job, index) => { job.runAt = new Date(Date.now() + index * 45_000).toISOString(); });
    if (schedule.status === "paused") schedule.status = "queued";
    refreshScheduleState(schedule);
    await persist();
    runScheduleNow(schedule).catch((error) => console.error("[run-now] falló", error.stack || error.message));
    return sendJson(response, 202, { ok: true, schedule });
  }

  if (request.method === "POST" && url.pathname === "/api/publish/cancel") {
    if (actionInProgress) return sendJson(response, 409, { ok: false, error: busyMessage() });
    if (facebook.preparedPost) await facebook.resetComposer();
    return sendJson(response, 200, { ok: true });
  }

  const imageMatch = url.pathname.match(/^\/api\/images\/([a-zA-Z0-9_.-]+)$/);
  if (request.method === "GET" && imageMatch) {
    const file = join(IMAGE_DIR, imageMatch[1]);
    if (!existsSync(file)) return sendJson(response, 404, { ok: false, error: "Imagen no encontrada." });
    const type = { ".png": "image/png", ".webp": "image/webp" }[extname(file)] || "image/jpeg";
    response.writeHead(200, { "content-type": type, "cache-control": "private, max-age=3600" });
    return response.end(await readFile(file));
  }

  const mediaFileMatch = url.pathname.match(/^\/api\/media\/([^/]+)\/file$/);
  if (request.method === "GET" && mediaFileMatch) {
    const media = mediaStore.get(decodeURIComponent(mediaFileMatch[1]));
    if (!media || !existsSync(media.path)) return sendJson(response, 404, { ok: false, error: "Archivo no encontrado." });
    response.writeHead(200, { "content-type": media.mimeType || "application/octet-stream", "cache-control": "private, max-age=86400" });
    return response.end(await readFile(media.path));
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    const limit = Math.max(1, Math.min(2_000, Number(url.searchParams.get("limit") || 100)));
    return sendJson(response, 200, { events: store.events.slice(0, limit) });
  }

  if (request.method === "GET" && url.pathname === "/api/drafts") {
    const drafts = store.drafts.slice(0, 100).map((draft) => ({
      ...draft,
      event: store.events.find((event) => event.id === draft.eventId) || null,
    }));
    return sendJson(response, 200, { drafts });
  }

  if (request.method === "GET" && url.pathname === "/api/groups") {
    return sendJson(response, 200, { groups: store.groups });
  }

  if (request.method === "GET" && url.pathname === "/api/profile") {
    return sendJson(response, 200, { profile: store.profile });
  }

  if (request.method === "POST" && url.pathname === "/api/profile/scan") {
    return exclusive(response, async () => {
    try {
      const profile = await runWithTimeout(() => facebook.collectProfile(), 45_000, "Facebook tardó demasiado en cargar el perfil.");
      store.profile = profile;
      store.meta.lastInventoryAt = now();
      await persist();
      return sendJson(response, 200, { ok: true, profile });
    } catch (error) {
      console.error("[api/profile/scan] falló", error.stack || error.message);
      return sendJson(response, 409, { ok: false, error: error.message });
    }
    });
  }

  if (request.method === "POST" && url.pathname === "/api/groups/scan") {
    return exclusive(response, async () => {
    try {
      const groups = await runWithTimeout(() => facebook.collectGroups(), 12 * 60_000, "Facebook tardó demasiado en cargar tus grupos.");
      store.groups = groups;
      store.meta.lastInventoryAt = now();
      await persist();
      return sendJson(response, 200, { ok: true, groups });
    } catch (error) {
      console.error("[api/groups/scan] falló", error.stack || error.message);
      return sendJson(response, 409, { ok: false, error: error.message });
    }
    });
  }

  if (request.method === "GET" && url.pathname === "/api/pages") {
    return sendJson(response, 200, { pages: store.pages });
  }

  if (request.method === "POST" && url.pathname === "/api/pages/scan") {
    return exclusive(response, async () => {
    try {
      const pages = await runWithTimeout(() => facebook.collectPages(), 150_000, "Facebook tardó demasiado en cargar tus páginas.");
      store.pages = pages;
      store.meta.lastInventoryAt = now();
      await persist();
      return sendJson(response, 200, { ok: true, pages });
    } catch (error) {
      console.error("[api/pages/scan] falló", error.stack || error.message);
      return sendJson(response, 409, { ok: false, error: error.message });
    }
    });
  }

  if (request.method === "GET" && url.pathname === "/api/chats") {
    const limit = Math.max(1, Math.min(MAX_CHATS, Number(url.searchParams.get("limit") || MAX_CHATS)));
    return sendJson(response, 200, {
      chats: store.chats.slice(0, limit),
      messageCount: store.messages.length,
      lastChatSyncAt: store.meta.lastChatSyncAt,
    });
  }

  const chatMessagesMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
  if (request.method === "GET" && chatMessagesMatch) {
    const chatId = decodeURIComponent(chatMessagesMatch[1]);
    const chat = store.chats.find((item) => item.id === chatId);
    if (!chat) return sendJson(response, 404, { ok: false, error: "Chat no encontrado." });
    const messages = store.messages.filter((item) => item.chatId === chatId).sort((x, y) => String(x.sentAt || "").localeCompare(String(y.sentAt || "")));
    return sendJson(response, 200, { chat, messages });
  }

  const chatSyncMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/sync$/);
  if (request.method === "POST" && chatSyncMatch) {
    const chat = store.chats.find((item) => item.id === decodeURIComponent(chatSyncMatch[1]));
    if (!chat) return sendJson(response, 404, { ok: false, error: "Chat no encontrado." });
    return exclusive(response, async () => {
      await facebook.open();
      const page = await facebook.context.newPage();
      try {
        const detail = await runWithTimeout(() => facebook.collectChatMessages(page, chat), 120_000, "Messenger tardó demasiado en cargar el chat.");
        applyMessengerData({ chats: [detail.chat], messages: detail.messages });
        await persist();
        return sendJson(response, 200, { ok: true, chat: detail.chat, messageCount: detail.messages.length });
      } catch (error) {
        return sendJson(response, 409, { ok: false, error: error.message });
      } finally {
        await page.close().catch(() => {});
      }
    });
  }

  if (request.method === "POST" && url.pathname === "/api/chats/scan") {
    if (scanInProgress || actionInProgress) return sendJson(response, 409, { ok: false, error: "Ya hay una sincronización en curso." });
    scanInProgress = true;
    try {
      const body = await readJson(request);
      const result = await runWithTimeout(() => facebook.scan({ deep: body.deep !== false }), 15 * 60_000, "La sincronización completa de chats tardó demasiado.");
      const merge = applyMessengerData(result);
      let newCount = 0;
      for (const input of result.events || []) {
        const upserted = await upsertEvent(input);
        if (upserted.isNew) newCount += 1;
      }
      for (const input of result.notifications || []) {
        const upserted = await upsertEvent(input);
        if (upserted.isNew) newCount += 1;
      }
      store.meta.lastScanAt = now();
      await persist();
      return sendJson(response, 200, { ok: true, ...merge, newCount, deep: body.deep !== false });
    } catch (error) {
      monitorState.lastError = error.message;
      console.error("[api/chats/scan] falló", error.stack || error.message);
      return sendJson(response, 409, { ok: false, error: error.message });
    } finally {
      scanInProgress = false;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/sync/all") {
    if (scanInProgress || actionInProgress) return sendJson(response, 409, { ok: false, error: "Ya hay una sincronización en curso." });
    scanInProgress = true;
    try {
      const result = await runWithTimeout(() => facebook.syncAll(), 20 * 60_000, "La sincronización completa tardó demasiado.");
      store.profile = result.profile;
      store.groups = result.groups;
      store.pages = result.pages;
      const merge = applyMessengerData(result.messenger);
      let newCount = 0;
      for (const input of [...(result.messenger?.events || []), ...(result.notifications || [])]) {
        const upserted = await upsertEvent(input);
        if (upserted.isNew) newCount += 1;
      }
      store.meta.lastScanAt = now();
      store.meta.lastInventoryAt = now();
      await persist();
      return sendJson(response, 200, {
        ok: true,
        profile: result.profile,
        groups: result.groups,
        pages: result.pages,
        ...merge,
        newCount,
      });
    } catch (error) {
      monitorState.lastError = error.message;
      console.error("[api/sync/all] falló", error.stack || error.message);
      return sendJson(response, 409, { ok: false, error: error.message });
    } finally {
      scanInProgress = false;
    }
  }

  if (request.method === "GET" && url.pathname === "/api/export") {
    const kind = ["all", "profile", "groups", "pages", "chats", "messages", "events", "drafts", "schedules", "publications", "posts", "crm-contacts", "crm-opportunities"].includes(url.searchParams.get("kind"))
      ? url.searchParams.get("kind")
      : "all";
    const format = url.searchParams.get("format") === "csv" && kind !== "all" ? "csv" : "json";
    const payload = exportCollection(kind);
    const body = format === "csv" ? recordsAsCsv(payload) : JSON.stringify(payload, null, 2);
    const extension = format === "csv" ? "csv" : "json";
    response.writeHead(200, {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="niro-${kind}.${extension}"`,
      "cache-control": "no-store",
    });
    return response.end(body);
  }

  if (request.method === "GET" && url.pathname === "/api/schedules") {
    return sendJson(response, 200, { schedules: store.schedules });
  }

  if (request.method === "POST" && url.pathname === "/api/schedules") {
    try {
      const body = await readJson(request);
      const groupIds = Array.isArray(body.groupIds) ? body.groupIds.filter((id) => store.groups.some((group) => group.id === id)) : [];
      const pageIds = Array.isArray(body.pageIds) ? body.pageIds.filter((id) => store.pages.some((page) => page.id === id)) : [];
      const destination = ["profile", "story", "groups", "pages", "all", "instagram"].includes(body.destination) ? body.destination : "groups";
      const instagramTargets = instagramTargetsFrom(body.instagramTargets);
      if (destination === "instagram" && !instagramTargets.length) throw new Error("Elegí al menos una cuenta de Instagram conectada.");
      const includeProfile = destination === "profile" || Boolean(body.includeProfile && destination === "all");
      const includeStory = destination === "story" || Boolean(body.includeStory && destination === "all");
      if (destination === "groups" && !groupIds.length) throw new Error("Seleccioná al menos un grupo.");
      if (destination === "pages" && !pageIds.length) throw new Error("Seleccioná al menos una página.");
      if (destination === "story" && body.text?.trim().length < 3) throw new Error("Escribí el texto de la historia.");
      if (destination === "all" && !groupIds.length && !pageIds.length && !includeProfile && !includeStory && !instagramTargets.length) throw new Error("Seleccioná al menos un grupo, página, historia o tu perfil.");
      if (!body.text || body.text.trim().length < 3) throw new Error("Escribí el texto de la publicación.");
      const intervalMinutes = Math.max(1, Math.min(10_080, Number(body.intervalMinutes) || 60));
      const startAt = body.startAt && !Number.isNaN(Date.parse(body.startAt)) ? new Date(body.startAt).toISOString() : now();
      const targets = [
        ...((destination === "profile" || includeProfile) ? [{ type: "profile", id: "profile", name: "Tu perfil" }] : []),
        ...(includeStory ? [{ type: "story", id: "story", name: "Historia / estado" }] : []),
        ...groupIds.map((id) => ({ type: "group", id, name: store.groups.find((group) => group.id === id)?.name || id })),
        ...pageIds.map((id) => ({ type: "page", id, name: store.pages.find((page) => page.id === id)?.name || id })),
        ...instagramTargets,
      ];
      const baseText = body.text.trim().slice(0, 5_000);
      const defaultMedia = mediaIdsFrom(body.media);
      const entries = Array.isArray(body.entries) ? body.entries : [];
      const jobs = [];
      if (entries.length) {
        entries.forEach((entry, entryIndex) => {
          const timestamp = Date.parse(entry?.runAt);
          if (Number.isNaN(timestamp)) return;
          const selectedTargetIds = Array.isArray(entry.targetIds) && entry.targetIds.length ? entry.targetIds : targets.map((target) => target.id);
          const entryTargets = targets.filter((target) => selectedTargetIds.includes(target.id));
          const entryText = String(entry.text || baseText).trim().slice(0, 5_000);
          const entryMedia = mediaIdsFrom(entry.media);
          if (entryText.length < 3) return;
          entryTargets.forEach((target, targetIndex) => jobs.push(scheduleJob(target, new Date(timestamp + targetIndex * intervalMinutes * 60_000).toISOString(), entryText, entryIndex * 1000 + targetIndex, entryMedia.length ? entryMedia : defaultMedia)));
        });
      }
      if (!jobs.length) {
        targets.forEach((target, index) => jobs.push(scheduleJob(target, new Date(Date.parse(startAt) + index * intervalMinutes * 60_000).toISOString(), baseText, index, defaultMedia)));
      }
      if (!jobs.length) throw new Error("Agregá al menos una fecha y hora válida.");
      for (const job of jobs) {
        if (job.target.type !== "instagram") continue;
        job.caption = String(body.instagramCaption || "").trim().slice(0, 2_200) || job.text;
        if (!job.media.length) throw new Error("Instagram necesita una imagen o video en cada fecha (o en los adjuntos generales).");
      }
      const schedule = {
        id: randomUUID(),
        destination,
        groupIds,
        pageIds,
        includeProfile,
        targets,
        text: baseText,
        media: defaultMedia,
        startAt,
        intervalMinutes,
        nextIndex: 0,
        nextRunAt: jobs.map((job) => job.runAt).sort()[0] || startAt,
        status: "queued",
        autoPublish: body.autoPublish === true,
        mode: body.autoPublish === true ? "automatic" : "manual",
        ai: await publicationAi(body.ai, baseText),
        jobs,
        completedCount: 0,
        failedCount: 0,
        createdAt: now(),
      };
      refreshScheduleState(schedule);
      store.schedules.unshift(schedule);
      await persist();
      return sendJson(response, 201, { ok: true, schedule });
    } catch (error) {
      return sendJson(response, 400, { ok: false, error: error.message });
    }
  }

  if (request.method === "POST" && url.pathname === "/api/browser/open") {
    try {
      await facebook.open();
      console.log("[browser] perfil persistente abierto");
      return sendJson(response, 200, { ok: true, message: "Perfil separado abierto. Iniciá sesión manualmente si hace falta." });
    } catch (error) {
      console.error("[api/browser/open] falló", error.stack || error.message);
      return sendJson(response, 500, { ok: false, error: error.message });
    }
  }

  if (request.method === "PATCH" && url.pathname === "/api/browser/mode") {
    const body = await readJson(request);
    if (typeof body.headless !== "boolean") return sendJson(response, 400, { ok: false, error: "Indicá headless: true o false." });
    const busy = busyMessage();
    if (busy) return sendJson(response, 409, { ok: false, error: busy });
    try {
      await facebook.setHeadless(body.headless);
      return sendJson(response, 200, { ok: true, headless: facebook.headless, browserOpen: facebook.isOpen });
    } catch (error) {
      return sendJson(response, 500, { ok: false, error: error.message });
    }
  }

  /* ------------------------------------------------ Ventana remota (login en servidor sin pantalla) */
  if (request.method === "GET" && url.pathname === "/api/browser/screen") {
    try {
      await facebook.open();
      const page = facebook.homePage;
      const image = await page.screenshot({ type: "jpeg", quality: 60, timeout: 10_000 });
      response.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
        "x-page-url": encodeURI(page.url()).slice(0, 500),
      });
      return response.end(image);
    } catch (error) {
      return sendJson(response, 500, { ok: false, error: error.message });
    }
  }
  if (request.method === "POST" && url.pathname === "/api/browser/input") {
    const busy = busyMessage();
    if (busy) return sendJson(response, 409, { ok: false, error: busy });
    const body = await readJson(request);
    const REMOTE_KEYS = new Set(["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
    try {
      await facebook.open();
      const page = facebook.homePage;
      const viewport = page.viewportSize() || { width: 1440, height: 1000 };
      if (body.action === "click") {
        const x = Math.min(Math.max(Number(body.x) || 0, 0), 1) * viewport.width;
        const y = Math.min(Math.max(Number(body.y) || 0, 0), 1) * viewport.height;
        await page.mouse.click(x, y);
      } else if (body.action === "type") {
        await page.keyboard.insertText(String(body.text || "").slice(0, 500));
      } else if (body.action === "key") {
        if (!REMOTE_KEYS.has(body.key)) return sendJson(response, 400, { ok: false, error: "Tecla no permitida." });
        await page.keyboard.press(body.key);
      } else if (body.action === "scroll") {
        await page.mouse.wheel(0, Math.max(-3000, Math.min(3000, Number(body.dy) || 0)));
      } else if (body.action === "selectAll") {
        await page.keyboard.press("ControlOrMeta+A");
      } else if (body.action === "back") {
        await page.goBack({ timeout: 15_000 }).catch(() => {});
      } else if (body.action === "home") {
        // goto directo: openUrl no navega si ya está en cualquier página de facebook.com.
        await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      } else {
        return sendJson(response, 400, { ok: false, error: "Acción desconocida." });
      }
      // Tipear no cambia de página: se contesta al toque; clics y teclas esperan un poco a que Facebook reaccione.
      if (body.action !== "type") await page.waitForTimeout(250);
      return sendJson(response, 200, { ok: true, url: page.url() });
    } catch (error) {
      return sendJson(response, 500, { ok: false, error: error.message });
    }
  }

  if (request.method === "POST" && url.pathname === "/api/browser/restore-profile") {
    return exclusive(response, async () => {
      try {
        return sendJson(response, 200, { ok: true, ...(await facebook.ensurePersonalProfile()) });
      } catch (error) {
        return sendJson(response, 409, { ok: false, error: error.message });
      }
    });
  }

  if (request.method === "POST" && url.pathname === "/api/browser/close") {
    stopMonitor();
    stopScheduler();
    await facebook.close();
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/browser/open-url") {
    try {
      const body = await readJson(request);
      await facebook.openUrl(body.url);
      return sendJson(response, 200, { ok: true, url: facebook.lastUrl });
    } catch (error) {
      console.error("[api/browser/open-url] falló", error.stack || error.message);
      return sendJson(response, 400, { ok: false, error: error.message });
    }
  }

  if (request.method === "GET" && url.pathname === "/api/browser/debug") {
    try {
      await facebook.open();
      const page = facebook.homePage;
      const diagnostics = await page.evaluate(() => {
        const visible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const bodyText = document.body?.innerText || "";
        const buttons = Array.from(document.querySelectorAll("button,[role='button']"));
        return {
          url: location.href,
          title: document.title,
          bodyLength: bodyText.length,
          visibleButtons: buttons.filter(visible).length,
          visibleEditors: Array.from(document.querySelectorAll("[contenteditable='true'], textarea")).filter(visible).length,
          hasComposerLabel: /qué estás pensando|what.?s on your mind|crear publicación|create post/i.test(bodyText),
          hasNextLabel: /siguiente|next/i.test(bodyText),
          hasPublishLabel: /publicar|post/i.test(bodyText),
          hasLoginLabel: /iniciar sesión|log in|checkpoint/i.test(bodyText),
        };
      });
      return sendJson(response, 200, { ok: true, diagnostics });
    } catch (error) {
      return sendJson(response, 409, { ok: false, error: error.message });
    }
  }

  // Diagnóstico de solo lectura para ajustar selectores cuando Facebook cambia.
  if (request.method === "POST" && url.pathname === "/api/browser/snapshot" && /^(1|true)$/i.test(process.env.NIRO_DEBUG || "")) {
    return exclusive(response, async () => {
      try {
        const body = await readJson(request);
        return await runWithTimeout(async () => {
        if (body.url) await facebook.openUrl(body.url);
        await facebook.waitForFacebookReady(facebook.homePage, 8_000).catch(() => {});
        for (let index = 0; index < (Number(body.scrolls) || 0); index += 1) {
          await facebook.homePage.evaluate(() => window.scrollBy(0, window.innerHeight));
          await facebook.homePage.waitForTimeout(1_500);
        }
        if (body.click) await facebook.homePage.getByRole("button", { name: body.click }).first().click({ timeout: 8_000 });
        if (body.clickSelector) { await facebook.homePage.locator(body.clickSelector).first().click({ timeout: 8_000 }); await facebook.homePage.waitForTimeout(2_000); }
        await facebook.homePage.waitForTimeout(Number(body.waitMs) || 2_500);
        const snapshot = await facebook.homePage.evaluate((selector) => {
          const main = document.querySelector("[role='main']") || document.body;
          const root = selector && selector.startsWith("document:") ? document : main;
          const links = Array.from(root.querySelectorAll((selector || "a[href]").replace(/^document:/, ""))).slice(0, 150).map((element) => ({
            href: element.href || element.getAttribute("href"),
            text: (element.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120),
            aria: element.getAttribute("aria-label"),
            role: element.getAttribute("role"),
            tag: element.tagName,
            visible: element.getBoundingClientRect().width > 0,
            top: Math.round(element.getBoundingClientRect().top + window.scrollY),
            container: element.closest("[aria-label]:not([role='button'])")?.getAttribute("aria-label")?.slice(0, 80) || null,
          }));
          const images = Array.from(document.querySelectorAll("svg image, img")).slice(0, 30).map((element) => ({
            src: (element.getAttribute("xlink:href") || element.getAttribute("href") || element.src || "").slice(0, 160),
            aria: element.closest("[aria-label]")?.getAttribute("aria-label") || null,
            size: Math.round(element.getBoundingClientRect().width),
          }));
          return {
            url: location.href,
            title: document.title,
            h1: Array.from(document.querySelectorAll("h1")).map((element) => element.innerText.trim()).slice(0, 5),
            mainText: (main.innerText || "").slice(0, 1_500),
            links,
            images,
          };
        }, body.selector || null);
        if (body.screenshot) await facebook.homePage.screenshot({ path: join(DATA_DIR, "debug-snapshot.png") });
        return sendJson(response, 200, { ok: true, snapshot });
        }, 90_000, "El diagnóstico tardó demasiado.");
      } catch (error) {
        return sendJson(response, 409, { ok: false, error: error.message });
      }
    });
  }

  if (request.method === "POST" && url.pathname === "/api/media") {
    try {
      const body = await readJson(request);
      if (typeof body.data !== "string" || !body.data) throw new Error("El archivo adjunto está vacío.");
      const rawData = body.data.replace(/^data:[^;]+;base64,/, "");
      const buffer = Buffer.from(rawData, "base64");
      if (!buffer.length) throw new Error("No se pudo leer el archivo adjunto.");
      if (buffer.length > MAX_MEDIA_BYTES) throw new Error("Cada archivo puede pesar como máximo 100 MB.");
      const id = randomUUID();
      const safeName = String(body.name || "archivo").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
      const extension = extname(safeName).slice(0, 12);
      const path = join(MEDIA_DIR, `${id}${extension}`);
      await mkdir(MEDIA_DIR, { recursive: true });
      await writeFile(path, buffer);
      const media = { id, path, name: safeName, mimeType: String(body.mimeType || "application/octet-stream"), size: buffer.length, createdAt: now() };
      mediaStore.set(id, media);
      store.media = [...(store.media || []), media];
      await persist();
      return sendJson(response, 201, { ok: true, media: { id, name: media.name, mimeType: media.mimeType, size: media.size } });
    } catch (error) {
      console.error("[api/media] falló", error.stack || error.message);
      return sendJson(response, 400, { ok: false, error: error.message });
    }
  }

  if (request.method === "POST" && url.pathname === "/api/story/prepare") {
    return exclusive(response, async () => {
    try {
      const body = await readJson(request);
      const result = await runWithTimeout(() => facebook.prepareStory(body.text, Array.isArray(body.media) ? body.media : []), 35_000, "Facebook tardó demasiado en preparar la historia.");
      return sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      await facebook.close();
      console.error("[api/story/prepare] falló", error.stack || error.message);
      return sendJson(response, 409, { ok: false, error: error.message });
    }
    });
  }

  if (request.method === "POST" && url.pathname === "/api/story") {
    return exclusive(response, async () => {
    try {
      const body = await readJson(request);
      const result = await runWithTimeout(() => facebook.publishStory(body.text, Array.isArray(body.media) ? body.media : []), 35_000, "Facebook tardó demasiado en mostrar el botón de historia.");
      recordPublication({ target: { type: "story", id: "story", name: "Historia / estado" }, text: body.text, media: body.media, url: result.url, aiConfig: await publicationAi(body.ai, body.text) });
      await persist();
      return sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      await facebook.close();
      console.error("[api/story] falló", error.stack || error.message);
      return sendJson(response, 409, { ok: false, error: error.message });
    }
    });
  }

  if (request.method === "POST" && url.pathname === "/api/group-post/prepare") {
    return exclusive(response, async () => {
    try {
      const body = await readJson(request);
      const group = store.groups.find((item) => item.id === body.groupId);
      if (!group) return sendJson(response, 404, { ok: false, error: "Grupo no encontrado. Actualizá la lista de grupos." });
      const result = await runWithTimeout(() => facebook.prepareGroupPost(group, body.text, Array.isArray(body.media) ? body.media : []), 70_000, "Facebook tardó demasiado en preparar el grupo.");
      return sendJson(response, 200, { ok: true, group, ...result });
    } catch (error) {
      await facebook.close();
      console.error("[api/group-post/prepare] falló", error.stack || error.message);
      return sendJson(response, 409, { ok: false, error: error.message });
    }
    });
  }

  if (request.method === "POST" && url.pathname === "/api/group-post") {
    return exclusive(response, async () => {
    try {
      const body = await readJson(request);
      const group = store.groups.find((item) => item.id === body.groupId);
      if (!group) return sendJson(response, 404, { ok: false, error: "Grupo no encontrado." });
      const result = await runWithTimeout(() => facebook.publishGroupPost(group, body.text, Array.isArray(body.media) ? body.media : []), 70_000, "Facebook tardó demasiado en publicar en el grupo.");
      recordPublication({ target: { type: "group", id: group.id, name: group.name }, text: body.text, media: body.media, url: result.url, aiConfig: await publicationAi(body.ai, body.text) });
      await persist();
      return sendJson(response, 200, { ok: true, group, ...result });
    } catch (error) {
      await facebook.close();
      console.error("[api/group-post] falló", error.stack || error.message);
      return sendJson(response, 409, { ok: false, error: error.message });
    }
    });
  }

  if (request.method === "POST" && url.pathname === "/api/page-post/prepare") {
    return exclusive(response, async () => {
    try {
      const body = await readJson(request);
      const page = store.pages.find((item) => item.id === body.pageId);
      if (!page) return sendJson(response, 404, { ok: false, error: "Página no encontrada. Actualizá la lista de páginas." });
      const result = await runWithTimeout(() => facebook.preparePagePost(page, body.text, Array.isArray(body.media) ? body.media : []), 35_000, "Facebook tardó demasiado en preparar la página.");
      return sendJson(response, 200, { ok: true, page, ...result });
    } catch (error) {
      await facebook.close();
      console.error("[api/page-post/prepare] falló", error.stack || error.message);
      return sendJson(response, 409, { ok: false, error: error.message });
    }
    });
  }

  if (request.method === "POST" && url.pathname === "/api/page-post") {
    return exclusive(response, async () => {
    try {
      const body = await readJson(request);
      const page = store.pages.find((item) => item.id === body.pageId);
      if (!page) return sendJson(response, 404, { ok: false, error: "Página no encontrada." });
      const result = await runWithTimeout(() => facebook.publishPagePost(page, body.text, Array.isArray(body.media) ? body.media : []), 35_000, "Facebook tardó demasiado en publicar en la página.");
      recordPublication({ target: { type: "page", id: page.id, name: page.name }, text: body.text, media: body.media, url: result.url, aiConfig: await publicationAi(body.ai, body.text) });
      await persist();
      return sendJson(response, 200, { ok: true, page, ...result });
    } catch (error) {
      await facebook.close();
      console.error("[api/page-post] falló", error.stack || error.message);
      return sendJson(response, 409, { ok: false, error: error.message });
    }
    });
  }

  const scheduleMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)\/prepare$/);
  if (request.method === "POST" && scheduleMatch) {
    return exclusive(response, async () => {
    try {
      const schedule = store.schedules.find((item) => item.id === scheduleMatch[1]);
      if (!schedule) return sendJson(response, 404, { ok: false, error: "Programación no encontrada." });
      const body = await readJson(request);
      const job = findScheduleJob(schedule, body.jobId, body.targetId || body.groupId || body.pageId);
      const target = job?.target;
      const stored = storedTarget(target);
      if (job?.status === "published") return sendJson(response, 409, { ok: false, error: "Esta publicación de la programación ya fue enviada." });
      if (job?.status === "running") return sendJson(response, 409, { ok: false, error: "Esta publicación ya está en curso." });
      if (!target || !stored) return sendJson(response, 404, { ok: false, error: "El próximo destino de esta programación ya no está disponible." });
      const text = job.text || schedule.text;
      const media = job.media || schedule.media || [];
      const result = target.type === "story"
        ? await runWithTimeout(() => facebook.prepareStory(text, media), 35_000, "Facebook tardó demasiado en preparar la historia.")
        : await runWithTimeout(() => facebook.prepareTarget({ ...target, ...stored }, text, media), 35_000, "Facebook tardó demasiado en preparar la próxima publicación.");
      return sendJson(response, 200, { ok: true, schedule, job, target: { ...target, ...stored }, ...result });
    } catch (error) {
      await facebook.close();
      console.error("[api/schedules/prepare] falló", error.stack || error.message);
      return sendJson(response, 409, { ok: false, error: error.message });
    }
    });
  }

  const publishScheduleMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)\/publish$/);
  if (request.method === "POST" && publishScheduleMatch) {
    return exclusive(response, async () => {
    try {
      const schedule = store.schedules.find((item) => item.id === publishScheduleMatch[1]);
      if (!schedule) return sendJson(response, 404, { ok: false, error: "Programación no encontrada." });
      const body = await readJson(request);
      const job = findScheduleJob(schedule, body.jobId, body.targetId || body.groupId || body.pageId);
      const target = job?.target;
      const stored = storedTarget(target);
      if (job?.status === "published") return sendJson(response, 409, { ok: false, error: "Esta publicación de la programación ya fue enviada." });
      if (job?.status === "running") return sendJson(response, 409, { ok: false, error: "Esta publicación ya está en curso." });
      if (!target || !stored) return sendJson(response, 404, { ok: false, error: "El próximo destino de esta programación ya no está disponible." });
      const result = await executeScheduleJob(schedule, job, "schedule");
      return sendJson(response, 200, { ok: true, schedule, job, target: { ...target, ...stored }, ...result });
    } catch (error) {
      await facebook.close();
      console.error("[api/schedules/publish] falló", error.stack || error.message);
      return sendJson(response, 409, { ok: false, error: error.message });
    }
    });
  }

  const scheduleResourceMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)$/);
  if (scheduleResourceMatch && request.method === "PATCH") {
    try {
      const schedule = store.schedules.find((item) => item.id === scheduleResourceMatch[1]);
      if (!schedule) return sendJson(response, 404, { ok: false, error: "Programación no encontrada." });
      const body = await readJson(request);
      ensureScheduleJobs(schedule);
      if (typeof body.autoPublish === "boolean") {
        schedule.autoPublish = body.autoPublish;
        schedule.mode = body.autoPublish ? "automatic" : "manual";
      }
      if (["queued", "paused"].includes(body.status)) schedule.status = body.status;
      if (body.retryFailed === true) {
        for (const job of schedule.jobs) {
          if (job.status === "failed") {
            job.status = "queued";
            job.lastError = null;
          }
        }
        schedule.status = "queued";
      }
      refreshScheduleState(schedule);
      await persist();
      return sendJson(response, 200, { ok: true, schedule });
    } catch (error) {
      return sendJson(response, 400, { ok: false, error: error.message });
    }
  }

  if (scheduleResourceMatch && request.method === "DELETE") {
    const index = store.schedules.findIndex((item) => item.id === scheduleResourceMatch[1]);
    if (index === -1) return sendJson(response, 404, { ok: false, error: "Programación no encontrada." });
    const [schedule] = store.schedules.splice(index, 1);
    await persist();
    return sendJson(response, 200, { ok: true, schedule });
  }

  if (request.method === "POST" && url.pathname === "/api/publish/prepare") {
    return exclusive(response, async () => {
    try {
      const body = await readJson(request);
      const result = await runWithTimeout(() => facebook.preparePost(body.text, Array.isArray(body.media) ? body.media : []), 35_000, "Facebook tardó demasiado en mostrar el editor.");
      return sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      await facebook.close();
      console.error("[api/publish/prepare] falló", error.stack || error.message);
      return sendJson(response, 409, { ok: false, error: error.message });
    }
    });
  }

  if (request.method === "POST" && url.pathname === "/api/publish") {
    return exclusive(response, async () => {
    try {
      const body = await readJson(request);
      const result = await runWithTimeout(() => facebook.publishPost(body.text, Array.isArray(body.media) ? body.media : []), 35_000, "Facebook tardó demasiado en mostrar el botón de publicación.");
      recordPublication({ target: { type: "profile", id: "profile", name: store.profile?.name || "Tu perfil" }, text: body.text, media: body.media, url: result.url, aiConfig: await publicationAi(body.ai, body.text) });
      await persist();
      return sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      await facebook.close();
      console.error("[api/publish] falló", error.stack || error.message);
      return sendJson(response, 409, { ok: false, error: error.message });
    }
    });
  }

  if (request.method === "POST" && url.pathname === "/api/reply/prepare") {
    return exclusive(response, async () => {
    try {
      const body = await readJson(request);
      const event = store.events.find((item) => item.id === body.eventId);
      if (!event) return sendJson(response, 404, { ok: false, error: "Aviso no encontrado." });
      const result = await runWithTimeout(
        () => facebook.prepareReply(event, body.text),
        25_000,
        "Facebook tardó demasiado en mostrar el editor de respuesta."
      );
      return sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      await facebook.close();
      console.error("[api/reply/prepare] falló", error.stack || error.message);
      return sendJson(response, 409, { ok: false, error: error.message });
    }
    });
  }

  if (request.method === "POST" && url.pathname === "/api/reply") {
    return exclusive(response, async () => {
    try {
      const body = await readJson(request);
      const event = store.events.find((item) => item.id === body.eventId);
      if (!event) return sendJson(response, 404, { ok: false, error: "Aviso no encontrado." });
      const result = await runWithTimeout(
        () => facebook.replyToEvent(event, body.text),
        25_000,
        "Facebook tardó demasiado en mostrar el botón de envío."
      );
      await crm.recordReply(event, body.text, body.actor).catch((error) => console.error("[crm] respuesta", error.message));
      return sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      await facebook.close();
      console.error("[api/reply] falló", error.stack || error.message);
      return sendJson(response, 409, { ok: false, error: error.message });
    }
    });
  }

  if (request.method === "POST" && url.pathname === "/api/scan") {
    if (scanInProgress || actionInProgress) return sendJson(response, 409, { ok: false, error: "Facebook está ocupado con otra tarea. Intentá de nuevo en unos segundos." });
    scanInProgress = true;
    try {
      const body = await readJson(request);
      const result = await performScan({ deep: body.deep === true });
      monitorState.lastError = null;
      return sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      monitorState.lastError = error.message;
      console.error("[api/scan] falló", error.stack || error.message);
      return sendJson(response, 409, { ok: false, error: error.message });
    } finally {
      scanInProgress = false;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/monitor/start") {
    if (!facebook.isOpen) {
      return sendJson(response, 409, { ok: false, error: "Abrí el perfil separado e iniciá sesión antes de activar el monitoreo." });
    }
    if (!monitorTimer) {
      monitorState.enabled = true;
      monitorState.lastError = null;
      monitorTimer = setInterval(async () => {
        if (scanInProgress || actionInProgress) return;
        scanInProgress = true;
        try {
          await performScan({ deep: false });
          monitorState.lastError = null;
        } catch (error) {
          monitorState.lastError = error.message;
          console.error("[monitor] revisión falló", error.stack || error.message);
        } finally {
          scanInProgress = false;
        }
      }, POLL_SECONDS * 1000);
    }
    return sendJson(response, 200, { ok: true, intervalSeconds: POLL_SECONDS });
  }

  if (request.method === "POST" && url.pathname === "/api/monitor/stop") {
    stopMonitor();
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/scheduler/start") {
    if (!facebook.isOpen) {
      return sendJson(response, 409, { ok: false, error: "Abrí el perfil separado e iniciá sesión antes de activar las publicaciones automáticas." });
    }
    startScheduler();
    return sendJson(response, 200, { ok: true, intervalSeconds: SCHEDULE_SECONDS });
  }

  if (request.method === "POST" && url.pathname === "/api/scheduler/stop") {
    stopScheduler();
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/demo") {
    const examples = [
      {
        source: "messenger",
        externalId: "demo-thread-niro",
        text: "Ejemplo de conversación nueva para validar el panel local.",
        url: "https://www.messenger.com/",
      },
      {
        source: "facebook_notification",
        externalId: "demo-comment-reply",
        text: "Ejemplo de respuesta a un comentario tuyo para revisar el hilo.",
        url: "https://www.facebook.com/notifications",
      },
    ];
    let newCount = 0;
    for (const input of examples) {
      const result = await upsertEvent(input);
      if (result.isNew) newCount += 1;
    }
    store.meta.lastScanAt = now();
    await persist();
    return sendJson(response, 200, { ok: true, newCount });
  }

  const draftMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)$/);
  if (request.method === "PATCH" && draftMatch) {
    const draft = store.drafts.find((item) => item.id === draftMatch[1]);
    if (!draft) return sendJson(response, 404, { ok: false, error: "Borrador no encontrado." });
    const body = await readJson(request);
    if (typeof body.body === "string") draft.body = body.body.slice(0, 20_000);
    if (["review", "reviewed"].includes(body.status)) draft.status = body.status;
    await persist();
    return sendJson(response, 200, { ok: true, draft });
  }

  if (request.method === "POST" && url.pathname === "/api/events/read-all") {
    let updated = 0;
    for (const event of store.events) {
      if (event.read !== true) {
        event.read = true;
        updated += 1;
      }
    }
    await persist();
    return sendJson(response, 200, { ok: true, updated });
  }

  const eventMatch = url.pathname.match(/^\/api\/events\/([^/]+)$/);
  if (request.method === "PATCH" && eventMatch) {
    const event = store.events.find((item) => item.id === eventMatch[1]);
    if (!event) return sendJson(response, 404, { ok: false, error: "Aviso no encontrado." });
    const body = await readJson(request);
    if (typeof body.read === "boolean") event.read = body.read;
    await persist();
    return sendJson(response, 200, { ok: true, event });
  }

  return sendJson(response, 404, { ok: false, error: "Ruta no encontrada." });
}

function stopMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
  monitorState.enabled = false;
}

function stopScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
  schedulerState.enabled = false;
}

async function runDueSchedules() {
  if (!schedulerState.enabled || scheduleRunInProgress || scanInProgress || actionInProgress || !facebook.isOpen || facebook.preparedPost) return;
  const due = [];
  for (const schedule of store.schedules) {
    if (schedule.autoPublish !== true || schedule.status === "paused" || bulkRuns.has(schedule.id)) continue;
    const job = ensureScheduleJobs(schedule).find((item) => item.status === "queued" && Date.parse(item.runAt) <= Date.now());
    if (job) due.push({ schedule, job });
  }
  due.sort((a, b) => String(a.job.runAt).localeCompare(String(b.job.runAt)));
  const next = due[0];
  if (!next) return;

  scheduleRunInProgress = true;
  actionInProgress = true;
  const { schedule, job } = next;
  schedulerState.lastRunAt = now();
  try {
    await executeScheduleJob(schedule, job, "scheduler");
    schedulerState.lastError = null;
  } catch (error) {
    schedulerState.lastError = `${schedule.id}: ${error.message}`;
    console.error("[scheduler] publicación automática falló", error.stack || error.message);
  } finally {
    actionInProgress = false;
    scheduleRunInProgress = false;
  }
}

function startScheduler() {
  schedulerState.enabled = true;
  schedulerState.lastError = null;
  if (!schedulerTimer) {
    schedulerTimer = setInterval(() => {
      runDueSchedules().catch((error) => {
        schedulerState.lastError = error.message;
        console.error("[scheduler] ciclo falló", error.stack || error.message);
      });
    }, SCHEDULE_SECONDS * 1000);
    runDueSchedules().catch((error) => {
      schedulerState.lastError = error.message;
      console.error("[scheduler] inicio falló", error.stack || error.message);
    });
  }
}

async function performScan({ deep = false } = {}) {
  const settings = syncSettings();
  const detected = await facebook.scan({ deep, chats: settings.monitorChats, notifications: settings.monitorNotifications });
  applyMessengerData(detected);
  let newCount = 0;
  for (const input of [...(detected.events || []), ...(detected.notifications || [])]) {
    const result = await upsertEvent(input);
    if (result.isNew) newCount += 1;
  }
  store.meta.lastScanAt = now();
  await persist();
  broadcast("sync", { kind: "scan", newCount });
  return {
    detected: (detected.events || []).length + (detected.notifications || []).length,
    newCount,
    chatCount: detected.chats?.length || 0,
    messageCount: detected.messages?.length || 0,
    deep,
  };
}

async function serveStatic(request, response, url) {
  if (url.pathname === "/favicon.ico") {
    response.writeHead(204);
    return response.end();
  }
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403);
    return response.end("Forbidden");
  }
  try {
    const isHtml = extname(filePath) === ".html";
    // index.html/login.html llevan __NIRO_BASE__ en sus rutas (/app.js, /api/login...) para poder
    // vivir bajo un prefijo (ej. /facebook) sin tocar cada referencia; acá se reemplaza en runtime.
    const content = isHtml ? (await readFile(filePath, "utf8")).replaceAll("__NIRO_BASE__", BASE_PATH) : await readFile(filePath);
    response.writeHead(200, {
      "content-type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
      // El HTML nunca se cachea: así siempre pide la versión actual de app.js/styles.css.
      "cache-control": isHtml ? "no-store" : "no-cache",
    });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

await loadStore();
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || HOST}`);
  if (BASE_PATH && (url.pathname === BASE_PATH || url.pathname.startsWith(`${BASE_PATH}/`))) {
    url.pathname = url.pathname.slice(BASE_PATH.length) || "/";
  }
  applySecurityHeaders(response);
  try {
    const rejected = rejectRequest(request, url);
    if (rejected) return sendJson(response, rejected[0], { ok: false, error: rejected[1] });
    if (url.pathname === "/api/login" && request.method === "POST") return await handleLogin(request, response);
    if (url.pathname === "/api/logout" && request.method === "POST") {
      response.setHeader("set-cookie", "niro_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
      return sendJson(response, 200, { ok: true });
    }
    const publicAsset = ["/login.html", "/styles.css", "/favicon.ico"].includes(url.pathname);
    // Los webhooks de formularios no usan la sesión del panel: cada uno verifica su propio secreto.
    const webhook = url.pathname.startsWith("/api/crm/webhooks/");
    if (!publicAsset && !webhook && !isAuthenticated(request)) {
      if (url.pathname.startsWith("/api/")) return sendJson(response, 401, { ok: false, error: "Iniciá sesión en el panel.", login: true });
      response.writeHead(302, { location: `${BASE_PATH}/login.html` });
      return response.end();
    }
    if (url.pathname.startsWith("/api/")) await api(request, response, url);
    else await serveStatic(request, response, url);
  } catch (error) {
    console.error(`[http] ${request.method} ${url.pathname} falló`, error.stack || error.message);
    if (!response.headersSent) sendJson(response, 500, { ok: false, error: "Error interno del servidor." });
    else response.end();
  }
});

if (!PANEL_PASSWORD && !["127.0.0.1", "localhost", "::1"].includes(HOST)) {
  console.warn(`[seguridad] NIRO_HOST=${HOST} expone el panel en la red sin contraseña. Definí NIRO_PANEL_PASSWORD.`);
}

server.listen(PORT, HOST, () => {
  console.log(`Niro local disponible en http://${HOST}:${PORT}`);
  console.log(`Perfil separado: ${PROFILE_PATH}`);
  console.log("Modo seguro activo: publicar y responder requieren confirmación explícita; la automatización se activa aparte.");
  if (SCHEDULER_AUTOSTART) startScheduler();
  ai.start();
  explorer.start();
  crm.start();
  // Un reinicio no debe cortar un envío masivo: se retoman los pendientes recientes.
  for (const schedule of store.schedules) {
    const recent = Date.now() - Date.parse(schedule.createdAt || 0) < 12 * 3_600_000;
    if (schedule.mode === "bulk" && recent && schedule.status !== "paused" && (schedule.jobs || []).some((job) => job.status === "queued" || job.status === "running")) {
      for (const job of schedule.jobs) if (job.status === "running") job.status = "queued";
      console.log(`[bulk] retomando envío masivo ${schedule.id}`);
      runScheduleNow(schedule).catch((error) => console.error("[bulk] no se pudo retomar", error.message));
    }
  }
});

async function shutdown() {
  stopMonitor();
  stopScheduler();
  await facebook.close();
  await pgStore?.close().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
