// Niro — panel local. SPA sin dependencias: router por hash, vistas renderizadas
// como HTML y eventos delegados por data-action.
import { installExplorer } from "./explorer-ui.js";
import { installCrm } from "./crm-ui.js";
import { installAppearance } from "./appearance.js";
import { createDialogs } from "./dialogs.js";
import { createRemoteView } from "./remote-view.js?v=0.9.7";

// Prefijo cuando el panel vive bajo una ruta del sitio principal (ej. /facebook); "" si tiene dominio propio.
const BASE = window.NIRO_BASE || "";
// Servidor sin pantalla: Facebook se maneja desde una ventana remota dentro del panel.
const remoteView = createRemoteView({ base: BASE, toast: (...args) => toast(...args), refresh: (...args) => refresh(...args) });
const $ = (selector, root = document) => root.querySelector(selector);
// Diálogos propios (en lugar de alert/confirm/prompt del navegador).
const dialogs = createDialogs({ icon: (name, size) => icon(name, size) });
// Puntos donde los módulos (CRM, explorador, apariencia) agregan secciones, botones y menús.
const hooks = { composerSections: [], composerPayload: [], conversationActions: [], eventActions: [], chrome: [], dropdowns: {} };
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/* ------------------------------------------------------------------ Íconos */
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  edit: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
  clip: '<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  play: '<path d="m6 3 14 9-14 9Z"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9Z"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checks: '<path d="M18 6 7 17l-5-5M22 10l-7.5 7.5L13 16"/>',
  heart: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13"/>',
  userplus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
  video: '<path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/>',
  thumb: '<path d="M7 10v12M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9Z"/>',
  sparkles: '<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2Z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  radar: '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5M19.1 4.9C23 8.8 23 15.1 19.1 19"/><circle cx="12" cy="12" r="2"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1Z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2Z"/><path d="M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1Z"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  kanban: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 7v7M12 7v4M16 7v10"/>',
  sidebar: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 0 0 0 20c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16a6 6 0 0 0 6-6c0-4.9-4.5-8.6-10-8.6Z"/>',
};

function icon(name, size = "") {
  return `<svg class="i ${size}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.alert}</svg>`;
}

function hydrateIcons(root = document) {
  $$("[data-icon]", root).forEach((node) => { node.outerHTML = icon(node.dataset.icon, node.dataset.size || ""); });
}

/* ------------------------------------------------------------------ Utilidades */
function esc(value = "") {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" })[char]);
}

function timeAgo(value) {
  if (!value) return "—";
  const seconds = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `hace ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `hace ${days} d`;
  return new Date(value).toLocaleDateString("es", { day: "2-digit", month: "short" });
}

function capitalize(text) { return text.charAt(0).toUpperCase() + text.slice(1); }

function when(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("es", { dateStyle: "medium", timeStyle: "short" });
}

function formatBytes(size) {
  if (!size) return "0 B";
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function localDateTimeValue(date = new Date(Date.now() + 10 * 60_000)) {
  const value = new Date(date);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function initials(name = "") {
  const words = String(name).replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] || "N") + (words[1]?.[0] || "")).toUpperCase();
}

const AVATAR_TONES = ["solid-violet", "solid-blue", "solid-green", "solid-orange", "solid-pink", "solid-teal", "solid-red"];
function tone(seed = "") {
  let hash = 0;
  for (const char of String(seed)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

function avatar(name, { size = "", seed = name, image = null, square = false } = {}) {
  const style = image ? ` style="background-image:url('${esc(image)}')"` : "";
  return `<span class="avatar ${size} ${square ? "square" : ""} ${image ? "" : tone(seed)}"${style}>${image ? "" : esc(initials(name))}</span>`;
}

function cleanGroupName(name = "") {
  return String(name).replace(/\s*(Activo por última vez|Última actividad|Last active).*$/i, "").trim() || name;
}

function mediaUrl(media) { return `${BASE}/api/media/${encodeURIComponent(media.id)}/file`; }
function isImage(media) { return media?.mimeType?.startsWith("image/"); }
function isVideo(media) { return media?.mimeType?.startsWith("video/"); }

const storage = {
  get(key, fallback) { try { const value = localStorage.getItem(key); return value == null ? fallback : JSON.parse(value); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento */ } },
};

/* ------------------------------------------------------------------ Estado */
const state = {
  status: null,
  events: [],
  drafts: [],
  groups: [],
  pages: [],
  profile: null,
  chats: [],
  schedules: [],
  publications: [],
  posts: [],
  dashboard: null,
  db: null,
  route: "home",
  notifFilter: "all",
  bellFilter: "all",
  selectedEventId: null,
  selectedChatId: null,
  chatSearch: "",
  chatMessages: new Map(),
  groupSearch: "",
  groupLimit: 60,
  selectedGroupIds: new Set(),
  pageSearch: "",
  selectedPageIds: new Set(),
  postsTab: "history",
  postsOwner: "all",
  calMonth: (() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; })(),
  pendingAction: null,
  busy: 0,
  loaded: false,
  composer: {
    destination: storage.get("niro-destination", "profile"),
    text: storage.get("niro-composer-text", ""),
    media: [],
    groupIds: new Set(),
    pageIds: new Set(),
    includeProfile: true,
    includeStory: false,
    targetSearch: "",
    mode: "now",
    spacing: 60,
    auto: storage.get("niro-schedule-auto", true),
    ai: { mode: "inherit", campaign: "", fields: {}, replyMode: "inherit" },
    instagram: { ids: new Set(), format: "post", caption: "" },
    rows: [],
  },
};

const EMOJIS = ["😀", "😂", "😍", "🥰", "😊", "😉", "😎", "🤔", "😮", "😢", "😡", "🙏", "👏", "💪", "👍", "👎", "❤️", "🔥", "✨", "🎉", "✅", "❌", "⭐", "💡", "📣", "🚀", "🎁", "📷", "🎥", "📎", "🌞", "🌙", "🌈", "☀️", "💬", "🙌", "🤝", "💯", "🥳", "🤩", "😅", "🤗", "😴", "🤷", "💜", "💙", "💚", "🧡", "🖤", "⚡", "🎯", "🛍️", "📍", "📅", "⏰", "🏆", "📈", "💰", "🛒", "📞"];

const KIND_META = {
  comment: { label: "Comentarios", icon: "message", tone: "solid-green" },
  reaction: { label: "Reacciones", icon: "heart", tone: "solid-red" },
  mention: { label: "Menciones", icon: "at", tone: "solid-blue" },
  share: { label: "Compartidos", icon: "share", tone: "solid-teal" },
  friend: { label: "Amistad", icon: "userplus", tone: "solid-blue" },
  birthday: { label: "Cumpleaños", icon: "gift", tone: "solid-pink" },
  group: { label: "Grupos", icon: "users", tone: "solid-violet" },
  live: { label: "En vivo", icon: "video", tone: "solid-red" },
  message: { label: "Messenger", icon: "message", tone: "solid-blue" },
  security: { label: "Seguridad", icon: "lock", tone: "solid-orange" },
  marketplace: { label: "Marketplace", icon: "flag", tone: "solid-teal" },
  other: { label: "Otras", icon: "bell", tone: "solid-gray" },
};

/* ------------------------------------------------------------------ Red */
async function request(path, options = {}) {
  const response = await fetch(BASE + path, { headers: { "content-type": "application/json" }, ...options });
  let payload = {};
  try { payload = await response.json(); } catch { /* respuesta vacía */ }
  if (response.status === 401 && payload.login) { location.href = `${BASE}/login.html`; throw new Error("Sesión vencida."); }
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `No se pudo completar la acción (HTTP ${response.status}).`);
  return payload;
}

async function withBusy(task) {
  state.busy += 1;
  $("#busy-bar").classList.remove("hidden");
  try { return await task(); }
  finally {
    state.busy -= 1;
    if (!state.busy) $("#busy-bar").classList.add("hidden");
  }
}

// Deshabilita el botón mientras corre la tarea y muestra el error como aviso.
async function run(button, label, task) {
  const original = button?.innerHTML;
  if (button) { button.disabled = true; if (label) button.innerHTML = `${icon("refresh", "sm")} ${esc(label)}`; }
  try { return await withBusy(task); }
  catch (error) { toast(error.message, { error: true }); return null; }
  finally { if (button && button.isConnected) { button.disabled = false; button.innerHTML = original; } }
}

/* ------------------------------------------------------------------ Avisos visuales */
function toast(message, { error = false, title = null, avatarHtml = null, timeout = 4800, action = null } = {}) {
  const node = document.createElement("div");
  node.className = `toast ${error ? "error" : ""} ${title ? "rich" : ""}`;
  node.innerHTML = `${avatarHtml || (error ? icon("alert", "sm") : "")}<div class="grow">${title ? `<strong>${esc(title)}</strong><small>${esc(message)}</small>` : esc(message)}</div><button aria-label="Cerrar">${icon("x", "xs")}</button>`;
  node.querySelector("button").addEventListener("click", () => node.remove());
  if (action) { node.style.cursor = "pointer"; node.querySelector(".grow").addEventListener("click", () => { action(); node.remove(); }); }
  $("#toasts").appendChild(node);
  while ($("#toasts").children.length > 4) $("#toasts").firstElementChild.remove();
  setTimeout(() => node.remove(), timeout);
}

/* ------------------------------------------------------------------ Datos */
async function loadAll() {
  const [status, events, drafts, groups, pages, profile, chats, schedules, publications, posts, dashboard, sync] = await Promise.all([
    request("/api/status"), request("/api/events?limit=500"), request("/api/drafts"), request("/api/groups"), request("/api/pages"),
    request("/api/profile"), request("/api/chats"), request("/api/schedules"), request("/api/publications?limit=1000"), request("/api/posts"), request("/api/dashboard"), request("/api/sync/state"),
  ]);
  state.status = status;
  state.events = events.events || [];
  state.drafts = drafts.drafts || [];
  state.groups = groups.groups || [];
  state.pages = pages.pages || [];
  state.profile = profile.profile || status.profile || null;
  state.chats = chats.chats || [];
  state.schedules = schedules.schedules || [];
  state.publications = publications.publications || [];
  state.posts = posts.posts || [];
  state.dashboard = dashboard;
  state.sync = sync;
  try { state.instagram = (await request("/api/instagram/accounts")).accounts || []; } catch { state.instagram = state.instagram || []; }
  if (!state.ai.prompts.length) request("/api/ai/state").then((aiState) => { state.ai.prompts = aiState.prompts; if (!state.ai.settings) state.ai.settings = null; }).catch(() => {});
  state.loaded = true;
  if (state.selectedEventId && !getEvent(state.selectedEventId)) state.selectedEventId = null;
  const validGroups = new Set(state.groups.map((group) => group.id));
  const validPages = new Set(state.pages.map((page) => page.id));
  for (const id of state.composer.groupIds) if (!validGroups.has(id)) state.composer.groupIds.delete(id);
  for (const id of state.composer.pageIds) if (!validPages.has(id)) state.composer.pageIds.delete(id);
}

async function refresh({ soft = true } = {}) {
  await loadAll();
  renderChrome();
  renderView({ soft });
}

let refreshTimer = null;
function scheduleRefresh(delay = 700) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(() => {}), delay);
}

function getEvent(id = state.selectedEventId) { return state.events.find((event) => event.id === id) || null; }

function uniqueEvents() {
  const unique = [];
  const seen = new Set();
  for (const event of state.events) {
    const key = `${event.source}:${event.source === "facebook_notification" ? event.url : event.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(event);
  }
  return unique;
}

function eventTitle(event) {
  if (!event) return "Aviso";
  const first = (event.text || "").split("·")[0].replace(/^No leída\s+/i, "").trim();
  return first.slice(0, 80) || (event.source === "messenger" ? "Messenger" : "Facebook");
}

function eventSender(event) {
  if (event.source === "messenger") {
    const chat = state.chats.find((item) => item.url === event.url || event.externalId?.startsWith(`${item.id}:`));
    if (chat?.name) return chat.name.slice(0, 60);
  }
  return eventTitle(event).split(/\s+/).slice(0, 3).join(" ");
}

function eventChat(event) {
  return state.chats.find((item) => item.url === event.url || event.externalId?.startsWith(`${item.id}:`)) || null;
}

function eventImage(event) {
  return event?.avatarUrl || (event?.source === "messenger" ? eventChat(event)?.avatarUrl : null) || null;
}

function dedupedDrafts() {
  const seen = new Set();
  return state.drafts.filter((draft) => {
    const event = state.events.find((item) => item.id === draft.eventId) || draft.event;
    const key = event ? `${event.source}:${event.url}` : draft.eventId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pendingJobs() {
  return state.schedules.flatMap((schedule) => (schedule.jobs || []).filter((job) => job.status === "queued").map((job) => ({ schedule, job })))
    .sort((a, b) => String(a.job.runAt).localeCompare(String(b.job.runAt)));
}

/* ------------------------------------------------------------------ Estructura común */
function profileName() { return state.profile?.name || "Tu perfil"; }
function greeting() { return state.profile?.name ? `¿Qué estás pensando, ${state.profile.name.split(" ")[0]}?` : "¿Qué estás pensando?"; }

function renderChrome() {
  updateSyncViews();
  const status = state.status || {};
  const unread = uniqueEvents().filter((event) => event.read !== true);
  const unreadChats = state.chats.filter((chat) => chat.unreadCount > 0).length;
  const connected = Boolean(status.browserOpen);
  const name = profileName();
  const image = state.profile?.avatarUrl || null;
  for (const id of ["#top-avatar-face", "#side-avatar"]) {
    const node = $(id);
    node.className = `avatar status-ring ${connected ? "online" : ""} ${image ? "" : tone(name)}`;
    node.style.backgroundImage = image ? `url('${image}')` : "";
    node.textContent = image ? "" : initials(name);
  }
  $("#side-name").textContent = name;
  $("#side-status").textContent = connected ? "Facebook conectado" : "Facebook sin conectar";
  setCount("#bell-dot", unread.length);
  setCount("#topnav-chat-dot", unreadChats);
  setCount("#side-notif-count", unread.length);
  $("#side-chat-count").textContent = state.chats.length;
  $("#side-sched-count").textContent = status.pendingScheduleCount ?? pendingJobs().length;
  $("#side-group-count").textContent = state.groups.length;
  $("#side-page-count").textContent = state.pages.length;
  $("#side-draft-count").textContent = dedupedDrafts().length;
  setCount("#side-ai-count", status.ai?.pending || 0);
  setCount("#side-explorer-count", status.explorer?.attention || 0);
  for (const extend of hooks.chrome) extend(status);
  document.title = unread.length ? `(${unread.length}) Niro — Centro de Facebook` : "Niro — Centro de Facebook";
  const storageInfo = status.storage || {};
  const pulse = $("#storage-pulse");
  if (storageInfo.engine === "postgresql") {
    pulse.className = `pulse ${storageInfo.lastError ? "warn" : ""}`;
    $("#storage-name").textContent = "PostgreSQL · autofacebook";
    $("#storage-detail").textContent = storageInfo.lastError ? `Error: ${storageInfo.lastError}` : `Guardado ${timeAgo(storageInfo.lastSavedAt)}`;
  } else {
    pulse.className = "pulse warn";
    $("#storage-name").textContent = "Archivo JSON local";
    $("#storage-detail").textContent = "Configurá NIRO_DATABASE_URL para usar PostgreSQL.";
  }
}

function setCount(selector, value) {
  const node = $(selector);
  if (!node) return;
  node.textContent = value > 99 ? "99+" : value;
  node.classList.toggle("hidden", !value);
}

/* ------------------------------------------------------------------ Router */
const ROUTES = {
  home: { render: renderHome, right: true },
  publicar: { render: renderComposer, right: false },
  programacion: { render: renderSchedule, right: false },
  notificaciones: { render: renderNotifications, right: false },
  messenger: { render: renderMessenger, right: false },
  publicaciones: { render: renderPublications, right: false },
  grupos: { render: renderGroups, right: false },
  paginas: { render: renderPages, right: false },
  borradores: { render: renderDrafts, right: true },
  datos: { render: renderData, right: true },
  respuestas: { render: renderAi, right: false },
};

function parseRoute() {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const name = path.split("/")[0] || "home";
  return { name: ROUTES[name] ? name : "home", params: new URLSearchParams(query) };
}

function navigate(hash) {
  if (location.hash === hash || (hash === "#/" && !location.hash)) onRoute();
  else location.hash = hash;
}

function onRoute() {
  const { name, params } = parseRoute();
  const changed = state.route !== name;
  state.route = name;
  if (params.get("event")) state.selectedEventId = params.get("event");
  if (params.get("chat")) state.selectedChatId = params.get("chat");
  $$("[data-route]").forEach((link) => link.classList.toggle("active", link.dataset.route === name));
  closeDropdown();
  renderView({ soft: false });
  updateSyncViews();
  if (changed) window.scrollTo({ top: 0 });
}

function isTyping() {
  const active = document.activeElement;
  return Boolean(active && $("#view").contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
}

function renderView({ soft = false } = {}) {
  const route = ROUTES[state.route];
  $("#layout").classList.toggle("no-right", !route.right);
  $("#right-rail").classList.toggle("hidden", !route.right);
  if (route.right) renderRightRail();
  if (!state.loaded) { $("#view").innerHTML = `<div class="card empty"><span class="empty-icon">${icon("refresh")}</span><strong>Cargando tu panel…</strong></div>`; return; }
  if (soft && isTyping()) {
    if (state.route === "publicar") { if (!$("#targets-box")?.contains(document.activeElement)) renderTargets(); renderPreview(); }
    return;
  }
  const scrollers = $$("[data-keep-scroll]", $("#view")).map((node) => [node.dataset.keepScroll, node.scrollTop]);
  route.render();
  hydrateIcons($("#view"));
  for (const [key, top] of scrollers) { const node = $(`[data-keep-scroll="${key}"]`); if (node) node.scrollTop = top; }
}

/* ------------------------------------------------------------------ Columna derecha */
function renderRightRail() {
  const status = state.status || {};
  const monitorOn = Boolean(status.monitor?.enabled);
  const schedulerOn = Boolean(status.scheduler?.enabled);
  const upcoming = pendingJobs().slice(0, 5);
  const contacts = state.chats.slice(0, 12);
  $("#right-rail").innerHTML = `
    <section class="card">
      <div class="card-head"><h3>Automatizaciones</h3>${status.bulkRunning ? '<span class="tag orange">Publicando…</span>' : ""}</div>
      <div class="card-body" style="padding-top:4px">
        <div class="automation"><span class="kpi-icon bg-blue">${icon("radar")}</span><div class="grow"><strong>Monitoreo de avisos</strong><small>${monitorOn ? `Activo · cada ${status.monitor.intervalSeconds}s` : "Inactivo"}${status.monitor?.lastError ? ` · ${esc(status.monitor.lastError)}` : ""}</small></div><button class="switch ${monitorOn ? "on" : ""}" data-action="toggle-monitor" aria-label="Monitoreo" aria-pressed="${monitorOn}"></button></div>
        <div class="automation"><span class="kpi-icon bg-orange">${icon("zap")}</span><div class="grow"><strong>Publicación automática</strong><small>${schedulerOn ? `Activa · cada ${status.scheduler.intervalSeconds}s` : "Inactiva"}${status.scheduler?.lastError ? " · con errores" : ""}</small></div><button class="switch ${schedulerOn ? "on" : ""}" data-action="toggle-scheduler" aria-label="Programador" aria-pressed="${schedulerOn}"></button></div>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h3>Próximas publicaciones</h3><a class="link-btn" href="#/programacion">Ver todo</a></div>
      <div class="card-body">${upcoming.length ? upcoming.map(({ schedule, job }) => upcomingRow(schedule, job)).join("") : '<p style="color:var(--muted);font-size:13px">No hay publicaciones en cola.</p>'}</div>
    </section>
    <section class="card">
      <div class="card-head"><h3>Contactos</h3><a class="link-btn" href="#/messenger">Messenger</a></div>
      <div class="card-body" style="padding-top:8px">${contacts.length ? contacts.map((chat) => `<button class="contact" data-action="open-chat-view" data-chat="${esc(chat.id)}">${avatar(chat.name, { size: "sm", seed: chat.id, image: chat.avatarUrl })}<span class="grow">${esc(chatName(chat))}</span>${chat.unreadCount ? `<span class="dot">${chat.unreadCount}</span>` : ""}</button>`).join("") : '<p style="color:var(--muted);font-size:13px">Sincronizá Messenger para ver tus contactos.</p>'}</div>
    </section>`;
}

function upcomingRow(schedule, job) {
  const date = new Date(job.runAt);
  return `<div class="upcoming"><span class="date-box"><b>${date.getDate()}</b><small>${date.toLocaleDateString("es", { month: "short" }).replace(".", "")}</small></span><div class="grow"><strong>${esc(cleanGroupName(job.target?.name || "Destino"))}</strong><small>${date.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })} · ${schedule.mode === "bulk" ? "Envío masivo" : schedule.autoPublish ? "Automática" : "Manual"}</small><small>${esc((job.text || schedule.text || "").slice(0, 70))}</small></div></div>`;
}

function chatName(chat) {
  const name = String(chat?.name || chat?.id || "Chat");
  return name.length > 48 ? `${name.slice(0, 48)}…` : name;
}

/* ------------------------------------------------------------------ Inicio */
function renderHome() {
  const status = state.status || {};
  const dash = state.dashboard || { activity: [], kinds: {}, totals: {} };
  const events = uniqueEvents();
  const unread = events.filter((event) => event.read !== true).length;
  const pending = status.pendingScheduleCount ?? pendingJobs().length;
  const connected = Boolean(status.browserOpen);
  const name = profileName();
  $("#view").innerHTML = `
    <section class="cover">
      <div class="cover-art ${state.profile?.coverUrl ? "has-photo" : ""}" ${state.profile?.coverUrl ? `style="background-image:linear-gradient(90deg, rgba(20,16,40,.82), rgba(20,16,40,.25) 60%, rgba(20,16,40,.05)), url('${esc(state.profile.coverUrl)}')"` : ""}>
        <div class="cover-copy"><span class="eyebrow">Facebook + Messenger</span><h2>Todo lo importante<br /><em>en un solo lugar.</em></h2></div>
        <div class="cover-actions">
          <button class="btn glass sm" data-action="open-browser">${icon(connected ? "check" : "login", "sm")} ${connected ? "Conectado" : "Conectar Facebook"}</button>
          <button class="btn glass sm" data-action="scan-now">${icon("refresh", "sm")} Actualizar avisos</button>
        </div>
      </div>
      <div class="cover-profile">
        ${avatar(name, { size: "xl", image: state.profile?.avatarUrl })}
        <div class="who">
          <h1>${esc(name)}</h1>
          ${state.profile?.alternateName || state.profile?.stats ? `<div class="meta" style="margin-bottom:4px">${state.profile.stats ? `<span><b>${esc(state.profile.stats)}</b></span>` : ""}${state.profile.alternateName ? `<span>${esc(state.profile.alternateName)}</span>` : ""}</div>` : ""}
          <div class="meta"><span><b>${state.groups.length}</b> grupos</span><span><b>${state.pages.length}</b> páginas</span><span><b>${state.chats.length}</b> chats</span><span><b>${dash.totals?.publications || 0}</b> publicadas con Niro</span></div>
        </div>
        <div class="actions"><a class="btn primary" href="#/publicar">${icon("plus", "sm")} Crear publicación</a><a class="btn gray" href="#/programacion">${icon("calendar", "sm")} Programar</a></div>
      </div>
      <nav class="cover-tabs"><a class="active" href="#/">Resumen</a><a href="#/publicaciones">Publicaciones</a><a href="#/notificaciones">Notificaciones</a><a href="#/grupos">Grupos</a><a href="#/paginas">Páginas</a><a href="#/datos">Datos</a></nav>
    </section>

    <section class="kpis">
      ${kpi("bell", "bg-red", unread, "Avisos sin leer", "#/notificaciones")}
      ${kpi("message", "bg-blue", state.chats.length, "Chats sincronizados", "#/messenger")}
      ${kpi("clock", "bg-orange", pending, "En cola", "#/programacion")}
      ${kpi("send", "bg-green", dash.totals?.publications || 0, "Publicadas", "#/publicaciones")}
      ${kpi("users", "bg-violet", state.groups.length, "Grupos", "#/grupos")}
    </section>

    <section class="card card-pad">
      <div class="quick-composer">${avatar(name, { image: state.profile?.avatarUrl })}<button class="fake-input" data-action="go-compose">${esc(greeting())}</button></div>
      <div class="quick-actions">
        <button data-action="go-compose" data-dest="story">${icon("sparkles", "sm")} Historia</button>
        <button data-action="go-compose" data-media="1">${icon("image", "sm")} Foto/video</button>
        <button data-action="go-compose" data-dest="all">${icon("rocket", "sm")} Publicar en todo</button>
        <button data-action="go-compose" data-mode="schedule">${icon("calendar", "sm")} Programar</button>
      </div>
    </section>

    <section class="grid-2">
      <div class="card">
        <div class="card-head"><div><h3>Actividad de los últimos 14 días</h3><span class="sub">Avisos detectados, mensajes y publicaciones</span></div></div>
        <div class="card-body">${activityChart(dash.activity || [])}</div>
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Tipos de avisos</h3><span class="sub">Clasificación automática</span></div></div>
        <div class="card-body">${kindBreakdown(dash.kinds || {})}</div>
      </div>
    </section>

    <section class="grid-2">
      <div class="card">
        <div class="card-head"><h3>Notificaciones recientes</h3><a class="link-btn" href="#/notificaciones">Ver todas</a></div>
        <div class="card-body" style="padding-top:6px">${events.slice(0, 6).map((event) => notifItem(event, { compact: true })).join("") || emptyState("bell", "Sin avisos todavía", "Conectá Facebook y presioná “Actualizar avisos”.")}</div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Últimas publicaciones</h3><a class="link-btn" href="#/publicaciones">Historial</a></div>
        <div class="card-body" style="padding-top:6px">${(dash.recentPublications || []).length ? `<div class="rows">${dash.recentPublications.map(publicationRow).join("")}</div>` : emptyState("send", "Aún no publicaste con Niro", "Lo que publiques o programes aparecerá acá con su estado.")}</div>
      </div>
    </section>`;
}

function kpi(iconName, toneClass, value, label, href) {
  return `<a class="card kpi" href="${href}" style="text-decoration:none;color:inherit"><span class="kpi-icon ${toneClass}">${icon(iconName)}</span><div><strong>${esc(value)}</strong><span>${esc(label)}</span></div></a>`;
}

function emptyState(iconName, title, text, actionHtml = "") {
  return `<div class="empty"><span class="empty-icon">${icon(iconName)}</span><strong>${esc(title)}</strong><p>${esc(text)}</p>${actionHtml}</div>`;
}

function activityChart(days) {
  if (!days.length) return emptyState("activity", "Sin datos", "La actividad aparecerá cuando haya avisos o publicaciones.");
  const max = Math.max(4, ...days.map((day) => day.events + day.messages + day.publications));
  const nice = Math.ceil(max / 4) * 4;
  const bars = days.map((day) => {
    const pct = (value) => `${(value / nice) * 100}%`;
    return `<div class="bar"><span class="s-events" style="height:${pct(day.events)}"></span><span class="s-messages" style="height:${pct(day.messages)}"></span><span class="s-pubs" style="height:${pct(day.publications)}"></span><span class="tip">${esc(day.label)}<br />${day.events} avisos · ${day.messages} mensajes · ${day.publications} publicadas</span></div>`;
  }).join("");
  const labels = days.map((day, index) => `<span>${index % 2 === 0 ? esc(day.label.split(" ")[0]) : ""}</span>`).join("");
  return `<div class="chart"><div class="chart-y"><span>${nice}</span><span>${nice * 3 / 4}</span><span>${nice / 2}</span><span>${nice / 4}</span><span>0</span></div><div class="chart-bars">${bars}</div><div class="chart-x">${labels}</div></div>
    <div class="legend" style="margin-top:12px"><span><i style="background:var(--violet)"></i>Avisos</span><span><i style="background:#b3a9ff"></i>Mensajes</span><span><i style="background:var(--green)"></i>Publicadas</span></div>`;
}

function kindBreakdown(kinds) {
  const entries = Object.entries(kinds).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (!total) return emptyState("bell", "Sin avisos", "Todavía no hay avisos clasificados.");
  return `<div class="rows">${entries.map(([kind, count]) => {
    const meta = KIND_META[kind] || KIND_META.other;
    return `<a class="row hover" href="#/notificaciones" data-action="set-notif-filter" data-filter="${esc(kind)}" style="text-decoration:none;color:inherit"><span class="avatar sm ${meta.tone}">${icon(meta.icon, "sm")}</span><span class="grow"><span class="title">${esc(meta.label)}</span><span class="progress" style="margin-top:6px"><span class="ok" style="width:${(count / total) * 100}%;background:var(--violet)"></span></span></span><span class="mono">${count}</span></a>`;
  }).join("")}</div>`;
}

function publicationRow(publication) {
  const target = publication.target || {};
  const statusTag = publication.status === "published" ? '<span class="tag green">Publicada</span>' : '<span class="tag red">Falló</span>';
  return `<div class="row">${targetAvatar(target)}<span class="grow"><span class="title">${esc(cleanGroupName(target.name || "Destino"))}</span><span class="sub">${esc(publication.text || "")}</span><span class="sub">${esc(originLabel(publication.origin))} · ${timeAgo(publication.createdAt)}${publication.error ? ` · ${esc(publication.error)}` : ""}</span></span>${statusTag}</div>`;
}

function originLabel(origin) {
  return { manual: "Manual", schedule: "Programada", scheduler: "Automática", bulk: "Envío masivo" }[origin] || origin || "";
}

function targetAvatar(target, size = "sm") {
  const map = { profile: ["home", "solid-violet"], story: ["sparkles", "solid-pink"], group: ["users", "solid-blue"], page: ["flag", "solid-orange"], instagram: ["image", "solid-pink"] };
  const [iconName, toneClass] = map[target?.type] || ["globe", "solid-gray"];
  return `<span class="avatar ${size} ${toneClass}">${icon(iconName, "sm")}</span>`;
}

/* ------------------------------------------------------------------ Notificaciones */
function notifItem(event, { compact = false } = {}) {
  const meta = KIND_META[event.kind] || (event.source === "messenger" ? KIND_META.message : KIND_META.other);
  const unread = event.read !== true;
  const name = eventSender(event);
  return `<button class="notif ${unread ? "unread" : ""} ${event.id === state.selectedEventId && !compact ? "selected" : ""}" data-action="select-event" data-event="${esc(event.id)}">
    ${avatar(name, { size: "lg", seed: name, image: eventImage(event) })}<span class="badge-ic ${meta.tone}">${icon(meta.icon)}</span>
    <span class="body"><span class="txt">${esc((event.text || "").slice(0, 220))}</span><span class="when">${timeAgo(event.firstSeenAt)} · ${esc(meta.label)}</span></span>
    ${unread ? '<span class="unread-dot"></span>' : ""}
  </button>`;
}

function filteredNotifications() {
  const events = uniqueEvents();
  const filter = state.notifFilter;
  if (filter === "all") return events;
  if (filter === "unread") return events.filter((event) => event.read !== true);
  return events.filter((event) => (event.kind || "other") === filter);
}

function renderNotifications() {
  const events = uniqueEvents();
  const counts = { all: events.length, unread: events.filter((event) => event.read !== true).length };
  for (const event of events) counts[event.kind || "other"] = (counts[event.kind || "other"] || 0) + 1;
  const filters = [["all", "Todas"], ["unread", "No leídas"], ["comment", "Comentarios"], ["reaction", "Reacciones"], ["mention", "Menciones"], ["message", "Messenger"], ["marketplace", "Marketplace"], ["security", "Seguridad"], ["share", "Compartidos"], ["friend", "Amistad"], ["group", "Grupos"], ["other", "Otras"]]
    .filter(([key]) => ["all", "unread"].includes(key) || counts[key] || state.notifFilter === key);
  const list = filteredNotifications();
  const event = getEvent();
  $("#view").innerHTML = `
    <div class="page-title"><div><span class="eyebrow">Bandeja</span><h1>Notificaciones</h1><p>Comentarios, reacciones, menciones y mensajes detectados en tu cuenta. Las nuevas llegan en tiempo real.</p></div>
      <div class="actions"><button class="btn gray" data-action="mark-all-read">${icon("checks", "sm")} Marcar todo como leído</button><button class="btn primary" data-action="scan-now">${icon("refresh", "sm")} Actualizar avisos</button></div></div>
    <div class="pills">${filters.map(([key, label]) => `<button class="pill ${state.notifFilter === key ? "active" : ""}" data-action="set-notif-filter" data-filter="${key}">${label}<span class="n">${counts[key] || 0}</span></button>`).join("")}</div>
    <div class="split">
      <section class="card list-pane" data-keep-scroll="notif-list" style="padding:8px">${list.length ? list.map((item) => notifItem(item)).join("") : emptyState("inbox", "No hay avisos en esta vista", "Cambiá el filtro o actualizá la bandeja.")}</section>
      <section class="card">${event ? eventDetail(event) : emptyState("eye", "Elegí un aviso", "Seleccioná una notificación para ver el contexto, el borrador de Niro y responder.")}</section>
    </div>`;
}

function eventDetail(event) {
  const meta = KIND_META[event.kind] || KIND_META.other;
  const draft = state.drafts.find((item) => item.eventId === event.id);
  const isMessenger = event.source === "messenger";
  return `<div class="card-head"><div style="display:flex;gap:12px;align-items:center;min-width:0">${avatar(eventSender(event), { size: "lg", image: eventImage(event) })}<div style="min-width:0"><h3>${esc(eventTitle(event))}</h3><span class="sub">${esc(meta.label)} · ${when(event.firstSeenAt)}</span></div></div><span class="tag ${isMessenger ? "blue" : "violet"}">${isMessenger ? "Messenger" : "Facebook"}</span></div>
    <div class="card-body">
      <div class="detail-text">${esc(event.text || "Sin texto disponible.")}</div>
      <div class="actions" style="margin-top:10px"><button class="btn ghost sm" data-action="open-url" data-url="${esc(event.url)}">${icon("external", "sm")} Abrir hilo original</button><button class="btn ghost sm" data-action="toggle-read" data-event="${esc(event.id)}">${icon("check", "sm")} Marcar como ${event.read ? "no leído" : "leído"}</button>${hooks.eventActions.map((render) => render(event)).join("")}</div>
      <div class="reply">
        <div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:8px;flex-wrap:wrap"><strong>${isMessenger ? "Responder por Messenger" : "Responder en el hilo"}</strong><span style="color:var(--muted);font-size:12px">Se pide confirmación antes de enviar</span></div>
        <textarea id="reply-text" maxlength="2000" placeholder="Escribí una respuesta…"></textarea>
        <div class="foot"><span>${isMessenger ? "Mensaje privado" : "Respuesta visible en Facebook"} · usa tu sesión conectada</span><button class="btn primary sm" data-action="prepare-reply" data-event="${esc(event.id)}">${icon("send", "sm")} Preparar respuesta</button></div>
      </div>
      ${draft ? `<div class="draft-box" style="margin-top:14px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><strong>Borrador de Niro</strong><span class="tag ${draft.status === "reviewed" ? "green" : "orange"}">${draft.status === "reviewed" ? "Revisado" : "Para revisar"}</span></div><textarea data-draft-id="${esc(draft.id)}">${esc(draft.body)}</textarea><div class="actions" style="margin-top:8px"><button class="btn soft sm" data-action="save-draft" data-draft="${esc(draft.id)}">Guardar revisión</button><button class="btn ghost sm" data-action="use-draft" data-draft="${esc(draft.id)}">Usar como respuesta</button></div></div>` : ""}
    </div>`;
}

async function selectEvent(id) {
  const event = getEvent(id);
  if (!event) return;
  state.selectedEventId = id;
  if (event.read !== true) {
    event.read = true;
    request(`/api/events/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ read: true }) }).catch(() => { /* se reintenta en la próxima lectura */ });
  }
  renderChrome();
  if (state.route !== "notificaciones") navigate("#/notificaciones");
  else renderView();
}

/* ------------------------------------------------------------------ Messenger */
function renderMessenger() {
  const search = state.chatSearch.toLowerCase();
  const chats = state.chats.filter((chat) => !search || `${chat.name} ${chat.preview}`.toLowerCase().includes(search));
  const chat = state.chats.find((item) => item.id === state.selectedChatId) || null;
  $("#view").innerHTML = `
    <section class="card messenger">
      <div class="chat-list" data-keep-scroll="chat-list">
        <div class="chat-list-head"><div style="display:flex;justify-content:space-between;align-items:center"><h3>Chats</h3><div class="actions"><button class="round-btn" title="Sincronizar chats completos" data-action="sync-chats">${icon("refresh", "sm")}</button><a class="round-btn" title="Descargar chats" href="${BASE}/api/export?kind=chats&format=json" download>${icon("download", "sm")}</a></div></div>
          <div class="search" style="max-width:none;margin-top:10px">${icon("search", "sm")}<input id="chat-search" type="search" placeholder="Buscar en Messenger" value="${esc(state.chatSearch)}" /></div></div>
        <div style="padding:0 6px 8px">${chats.length ? chats.map((item) => `<button class="chat-item ${item.id === state.selectedChatId ? "active" : ""} ${item.unreadCount ? "unread" : ""}" data-action="select-chat" data-chat="${esc(item.id)}">${avatar(item.name, { size: "lg", seed: item.id, image: item.avatarUrl })}<span class="grow"><strong>${esc(chatName(item))}</strong><small>${esc((item.lastMessage || item.preview || "Sin vista previa").slice(0, 90))}</small></span>${item.kind === "encrypted" ? `<span title="Cifrado de extremo a extremo" style="color:var(--muted)">${icon("lock", "xs")}</span>` : ""}${item.unreadCount ? `<span class="dot">${item.unreadCount}</span>` : ""}</button>`).join("") : emptyState("message", "Sin chats", "Usá el botón de sincronizar para cargar la bandeja de Messenger.")}</div>
      </div>
      <div class="conversation">${chat ? conversation(chat) : emptyState("message", "Elegí una conversación", "Seleccioná un chat para ver el historial guardado y responder desde Niro.")}</div>
    </section>`;
  if (chat && !state.chatMessages.has(chat.id)) loadChatMessages(chat.id);
}

function chatEvent(chat) {
  return state.events.find((event) => event.source === "messenger" && (event.url === chat.url || event.externalId?.startsWith(`${chat.id}:`))) || null;
}

function conversation(chat) {
  const messages = state.chatMessages.get(chat.id);
  const linked = chatEvent(chat);
  const bubbles = messages === undefined
    ? '<div class="empty"><strong>Cargando historial…</strong></div>'
    : messages.length
      ? messages.map((message) => `<div class="bubble ${message.fromMe || /^(tú|you)$/i.test(message.sender || "") ? "me" : ""}">${esc(message.text)}<small>${esc(message.sentAt ? when(message.sentAt) : message.timestamp || "")}</small></div>`).join("")
      : `<div class="bubble">${esc(chat.lastMessage || chat.preview || "Sin mensajes guardados.")}<small>Vista previa · ${timeAgo(chat.lastSeenAt || chat.observedAt)}</small></div><p style="text-align:center;color:var(--muted);font-size:12px;margin-top:10px">Sincronizá chats completos para guardar el historial de esta conversación.</p>`;
  return `<div class="conv-head">${avatar(chat.name, { seed: chat.id, image: chat.avatarUrl })}<div class="grow"><strong>${esc(chatName(chat))}</strong><span style="color:var(--muted);font-size:12px">${chat.messageCount ? `${chat.messageCount} mensajes guardados` : "Sin historial profundo"}${chat.kind === "encrypted" ? " · cifrado" : ""}</span></div>${hooks.conversationActions.map((render) => render(chat)).join("")}<button class="btn soft sm" data-action="sync-chat" data-chat="${esc(chat.id)}">${icon("refresh", "sm")} Sincronizar</button><button class="btn ghost sm" data-action="open-url" data-url="${esc(chat.url)}">${icon("external", "sm")} Abrir</button></div>
    <div class="conv-body" data-keep-scroll="conv">${bubbles}</div>
    <div class="conv-foot"><textarea id="chat-reply" rows="1" maxlength="2000" placeholder="${linked ? "Escribí un mensaje… (Enter para preparar)" : "Actualizá avisos para poder responder este chat"}" ${linked ? "" : "disabled"}></textarea><button class="round-btn" style="background:var(--violet);color:var(--on-accent)" data-action="chat-reply" data-chat="${esc(chat.id)}" ${linked ? "" : "disabled"} aria-label="Preparar respuesta">${icon("send", "sm")}</button></div>`;
}

async function loadChatMessages(chatId) {
  try {
    const result = await request(`/api/chats/${encodeURIComponent(chatId)}/messages`);
    state.chatMessages.set(chatId, result.messages || []);
  } catch {
    state.chatMessages.set(chatId, []);
  }
  if (state.route === "messenger" && state.selectedChatId === chatId && !isTyping()) {
    renderView();
    const body = $(".conv-body");
    if (body) body.scrollTop = body.scrollHeight;
  }
}

/* ------------------------------------------------------------------ Publicar */
const IG_FORMATS = { post: "Publicación", reel: "Reel", story: "Historia" };

function instagramAccounts() { return state.instagram || []; }

function instagramTargets() {
  const c = state.composer;
  return instagramAccounts().filter((account) => account.status === "connected" && c.instagram.ids.has(account.id))
    .map((account) => ({ type: "instagram", id: account.id, format: c.instagram.format, name: `@${account.username} · ${IG_FORMATS[c.instagram.format]}` }));
}

function composerTargets() {
  const c = state.composer;
  if (c.destination === "instagram") return instagramTargets();
  if (c.destination === "profile") return [{ type: "profile", id: "profile", name: profileName() }];
  if (c.destination === "story") return [{ type: "story", id: "story", name: "Historia / estado" }];
  const groups = [...c.groupIds].map((id) => state.groups.find((group) => group.id === id)).filter(Boolean).map((group) => ({ type: "group", id: group.id, name: cleanGroupName(group.name) }));
  const pages = [...c.pageIds].map((id) => state.pages.find((page) => page.id === id)).filter(Boolean).map((page) => ({ type: "page", id: page.id, name: page.name }));
  if (c.destination === "groups") return groups;
  if (c.destination === "pages") return pages;
  return [
    ...(c.includeProfile ? [{ type: "profile", id: "profile", name: profileName() }] : []),
    ...(c.includeStory ? [{ type: "story", id: "story", name: "Historia / estado" }] : []),
    ...groups,
    ...pages,
    ...instagramTargets(),
  ];
}

// Bloque de Instagram: cuentas conectadas, formato y descripción propia.
function instagramBlock() {
  const c = state.composer;
  const accounts = instagramAccounts();
  const connected = accounts.filter((account) => account.status === "connected");
  const needsMedia = !c.media.length;
  return `<div class="ig-block">
    <div class="ig-head">${icon("image", "sm")} <b>Instagram</b><span class="sub">${connected.length} cuenta(s) conectada(s)</span><button class="btn ghost xs" data-action="go-accounts">${icon("refresh", "xs")} Cuentas</button></div>
    ${connected.length ? connected.map((account) => `<label class="target-option"><span class="avatar sm solid-pink">${icon("image", "sm")}</span><span class="grow"><strong>@${esc(account.username)}</strong><small>Vinculada a ${esc(account.pageName)}</small></span><input type="checkbox" data-target-type="instagram" data-target-id="${esc(account.id)}" ${c.instagram.ids.has(account.id) ? "checked" : ""} /></label>`).join("") : '<p class="sub" style="padding:6px 8px">Ninguna cuenta de Instagram conectada. Revisalas en Datos → Instagram.</p>'}
    <div class="segmented ig-formats">${Object.entries(IG_FORMATS).map(([key, label]) => `<button class="${c.instagram.format === key ? "active" : ""}" data-action="ig-format" data-format="${key}">${label}</button>`).join("")}</div>
    ${c.instagram.format !== "story" ? `<label class="field">Descripción para Instagram (vacío = usa el texto principal)<textarea id="ig-caption" maxlength="2200" placeholder="Texto, emojis y #etiquetas">${esc(c.instagram.caption)}</textarea></label>` : '<p class="sub">Las historias no llevan descripción: los textos y emojis tienen que estar dentro de la imagen o el video.</p>'}
    ${needsMedia && c.instagram.ids.size ? `<p class="ig-warning">${icon("alert", "xs")} Instagram necesita una imagen o video: agregá un archivo antes de publicar.</p>` : ""}
    ${c.instagram.format === "reel" ? '<p class="sub">Reel: un solo video vertical (9:16).</p>' : c.instagram.format === "post" ? '<p class="sub">Publicación: 1 imagen/video, o hasta 10 para carrusel.</p>' : ""}
  </div>`;
}

// Reglas de Instagram antes de publicar o programar.
function instagramProblem(targets, media) {
  const ig = targets.filter((target) => target.type === "instagram");
  if (!ig.length) return null;
  const format = ig[0].format;
  const videos = media.filter((item) => item.mimeType?.startsWith("video/"));
  const images = media.filter((item) => item.mimeType?.startsWith("image/"));
  if (!media.length) return "Instagram necesita una imagen o video.";
  if (videos.length + images.length !== media.length) return "Instagram solo acepta imágenes y videos.";
  if (format === "reel" && (videos.length !== 1 || images.length)) return "Un Reel necesita exactamente un video.";
  if (format === "story" && media.length !== 1) return "Una historia de Instagram lleva una sola imagen o video.";
  if (format === "post" && media.length > 10) return "Un carrusel admite hasta 10 archivos.";
  return null;
}

function renderComposer() {
  const c = state.composer;
  if (!c.rows.length) c.rows.push({ id: crypto.randomUUID(), runAt: localDateTimeValue(), text: "", media: [] });
  const tabs = [["profile", "home", "Perfil"], ["story", "sparkles", "Historia"], ["groups", "users", "Grupos"], ["pages", "flag", "Páginas"], ["instagram", "image", "Instagram"], ["all", "rocket", "Todo"]];
  $("#view").innerHTML = `
    <div class="page-title"><div><span class="eyebrow">Publicar</span><h1>Crear publicación</h1><p>Publicá ahora en uno o varios destinos, o programá fechas y horarios. Siempre ves una vista previa antes de enviar.</p></div></div>
    <div class="composer-grid">
      <section class="card composer">
        <div class="card-body">
          <div class="segmented" role="tablist">${tabs.map(([key, iconName, label]) => `<button class="${c.destination === key ? "active" : ""}" data-action="set-destination" data-dest="${key}">${icon(iconName, "sm")} ${label}</button>`).join("")}</div>
          <div id="targets-box"></div>
          <div class="author" style="margin-top:14px">${avatar(profileName(), { image: state.profile?.avatarUrl })}<div><strong>${esc(profileName())}</strong><span id="dest-note" style="color:var(--muted);font-size:12px"></span></div></div>
          <textarea id="composer-text" class="main-text" maxlength="5000" placeholder="${c.destination === "story" ? "Escribí el texto de tu historia…" : esc(greeting())}">${esc(c.text)}</textarea>
          <div style="display:flex;justify-content:flex-end"><span id="char-count" class="char-count">${c.text.length}/5000</span></div>
          <div id="composer-media" class="media-grid">${mediaTiles(c.media, "composer")}</div>
          <div class="add-to-post"><span>Agregar a tu publicación</span><div class="tools">
            <button class="tool photo" title="Foto o video" data-action="attach" data-target="composer">${icon("image")}</button>
            <button class="tool file" title="Archivo" data-action="attach" data-target="composer">${icon("clip")}</button>
            <button class="tool emoji" title="Emoji" data-action="emoji" data-target="#composer-text">${icon("smile")}</button>
            <button class="tool clock" title="Programar" data-action="set-mode" data-mode="${c.mode === "schedule" ? "now" : "schedule"}">${icon("clock")}</button>
          </div></div>
          ${composerAiSection()}
          ${hooks.composerSections.map((section) => section()).join("")}
          <div class="segmented" style="margin-top:14px"><button class="${c.mode === "now" ? "active" : ""}" data-action="set-mode" data-mode="now">${icon("send", "sm")} Publicar ahora</button><button class="${c.mode === "schedule" ? "active" : ""}" data-action="set-mode" data-mode="schedule">${icon("calendar", "sm")} Programar</button></div>
          ${c.mode === "now" ? publishNowBar() : scheduleForm()}
        </div>
      </section>
      <aside class="card preview-card"><div class="card-head"><h3>Vista previa</h3><span class="sub" id="preview-sub"></span></div><div class="card-body" id="composer-preview"></div></aside>
    </div>`;
  renderTargets();
  renderPreview();
}

function publishNowBar() {
  const c = state.composer;
  return `<div class="publish-bar"><span class="hint" id="now-hint"></span><div class="actions">
    <label class="spacing" title="Pausa entre destinos al publicar en varios">Pausa <select id="spacing">${[20, 45, 60, 120, 300, 600].map((seconds) => `<option value="${seconds}" ${Number(c.spacing) === seconds ? "selected" : ""}>${seconds < 60 ? `${seconds} s` : `${seconds / 60} min`}</option>`).join("")}</select></label>
    <label class="check-chip" title="Muestra una ventana para revisar antes de enviar"><input type="checkbox" id="confirm-publish" ${confirmPublishing() ? "checked" : ""} /> Confirmar antes</label>
    <button class="btn primary" data-action="publish-now">${icon("send", "sm")} <span id="publish-label">Publicar</span></button></div></div>`;
}

function scheduleForm() {
  const c = state.composer;
  return `<div class="calendar-rows">${c.rows.map((row, index) => `
      <div class="cal-row" data-row="${esc(row.id)}">
        <label class="field">Fecha y hora<input type="datetime-local" data-row-field="runAt" value="${esc(row.runAt)}" /></label>
        <label class="field"><span style="display:flex;justify-content:space-between;gap:6px">Texto de esta fecha <button class="link-btn" data-action="emoji" data-target='[data-row="${esc(row.id)}"] textarea' aria-label="Emoji">${icon("smile", "xs")}</button></span><textarea data-row-field="text" maxlength="5000" placeholder="Vacío = usa el texto principal">${esc(row.text)}</textarea></label>
        <button class="round-btn" title="Quitar fecha" data-action="remove-row" data-row-id="${esc(row.id)}" ${c.rows.length === 1 ? "disabled" : ""}>${icon("x", "sm")}</button>
        <div class="row-media"><button class="btn ghost xs" data-action="attach" data-target="row" data-row-id="${esc(row.id)}">${icon("clip", "xs")} Adjuntos propios</button><span>${row.media.length ? `${row.media.length} adjunto(s)` : "Si no agregás, usa los adjuntos generales"}</span><span class="tag">#${index + 1}</span></div>
        <div class="media-grid">${mediaTiles(row.media, "row", row.id)}</div>
      </div>`).join("")}</div>
    <div class="actions" style="margin-top:10px"><button class="btn soft sm" data-action="add-row">${icon("plus", "sm")} Agregar fecha</button><button class="btn ghost sm" data-action="add-row" data-preset="tomorrow">Mañana 9:00</button><button class="btn ghost sm" data-action="add-row" data-preset="week">Próximos 7 días 9:00</button></div>
    <label class="auto-toggle"><input id="schedule-auto" type="checkbox" ${c.auto ? "checked" : ""} /><span><strong>Publicar automáticamente</strong><small>Al llegar la hora publica sin pedir confirmación individual. Requiere activar “Publicación automática”.</small></span></label>
    <div class="publish-bar"><span class="hint" id="schedule-hint"></span><button class="btn primary" data-action="save-schedule">${icon("calendar", "sm")} Guardar en calendario</button></div>`;
}

function mediaTiles(media, owner, rowId = "") {
  return media.map((item) => `<div class="media-tile" title="${esc(item.name)}">${isImage(item) ? `<img src="${mediaUrl(item)}" alt="" loading="lazy" />` : isVideo(item) ? `<video src="${mediaUrl(item)}" muted></video>` : `<div class="file-face">${icon(item.mimeType?.startsWith("audio/") ? "music" : "file")}<span>${esc(item.name)}</span></div>`}<span class="size">${formatBytes(item.size)}</span><button class="remove" data-action="remove-media" data-owner="${owner}" data-row-id="${esc(rowId)}" data-media="${esc(item.id)}" aria-label="Quitar ${esc(item.name)}">${icon("x", "xs")}</button></div>`).join("");
}

function renderTargets() {
  const box = $("#targets-box");
  if (!box) return;
  const c = state.composer;
  const note = $("#dest-note");
  const targets = composerTargets();
  if (note) note.innerHTML = { profile: `${icon("globe", "xs")} Tu perfil personal`, story: `${icon("sparkles", "xs")} Historia · visible 24 h`, groups: `${icon("users", "xs")} ${targets.length} grupo(s)`, pages: `${icon("flag", "xs")} ${targets.length} página(s)`, all: `${icon("rocket", "xs")} ${targets.length} destino(s)` }[c.destination];
  if (note && c.destination === "instagram") note.innerHTML = `${icon("image", "xs")} ${targets.length} cuenta(s) de Instagram`;
  if (["profile", "story"].includes(c.destination)) { box.innerHTML = ""; updateComposerHints(); return; }
  if (c.destination === "instagram") { box.innerHTML = instagramBlock(); updateComposerHints(); return; }
  const search = c.targetSearch.toLowerCase();
  const showGroups = c.destination !== "pages";
  const showPages = c.destination !== "groups";
  const groups = showGroups ? state.groups.filter((group) => !search || group.name.toLowerCase().includes(search)) : [];
  const pages = showPages ? state.pages.filter((page) => !search || page.name.toLowerCase().includes(search)) : [];
  const option = (type, item, checked) => {
    const label = type === "group" ? cleanGroupName(item.name) : item.name;
    return `<label class="target-option">${avatar(label, { size: "sm", seed: item.id, square: type === "group", image: item.avatarUrl })}<span class="grow"><strong>${esc(label)}</strong><small>${type === "group" ? "Grupo" : "Página"}${item.notificationCount ? ` · ${item.notificationCount} notificaciones` : ""}</small></span><input type="checkbox" data-target-type="${type}" data-target-id="${esc(item.id)}" ${checked ? "checked" : ""} /></label>`;
  };
  const scrollTop = $(".targets-list", box)?.scrollTop || 0;
  box.innerHTML = `<div class="targets">
    <div class="targets-head"><input id="target-search" type="search" placeholder="Buscar ${c.destination === "pages" ? "páginas" : c.destination === "groups" ? "grupos" : "destinos"}…" value="${esc(c.targetSearch)}" />
      ${showGroups ? `<button class="btn ghost xs" data-action="scan-groups">${icon("refresh", "xs")} Grupos</button>` : ""}${showPages ? `<button class="btn ghost xs" data-action="scan-pages">${icon("refresh", "xs")} Páginas</button>` : ""}</div>
    <div class="targets-list">
      ${c.destination === "all" ? `<label class="target-option">${avatar(profileName(), { size: "sm", image: state.profile?.avatarUrl })}<span class="grow"><strong>Tu perfil</strong><small>Perfil personal</small></span><input type="checkbox" data-target-type="profile" ${c.includeProfile ? "checked" : ""} /></label><label class="target-option"><span class="avatar sm solid-pink">${icon("sparkles", "sm")}</span><span class="grow"><strong>Historia / estado</strong><small>Visible 24 horas</small></span><input type="checkbox" data-target-type="story" ${c.includeStory ? "checked" : ""} /></label>` : ""}
      ${pages.map((page) => option("page", page, c.pageIds.has(page.id))).join("")}
      ${groups.slice(0, 400).map((group) => option("group", group, c.groupIds.has(group.id))).join("")}
      ${!groups.length && !pages.length ? `<div class="empty" style="padding:18px"><p>${showGroups && !state.groups.length ? "Todavía no hay grupos cargados. " : ""}${showPages && !state.pages.length ? "Todavía no hay páginas cargadas. " : ""}${search ? "Sin resultados para la búsqueda." : "Usá los botones de arriba para leerlos desde Facebook."}</p></div>` : ""}
    </div>
    <div class="targets-foot"><span><b>${targets.length}</b> seleccionado(s)${groups.length > 400 ? " · refiná la búsqueda para ver más" : ""}</span><span class="actions"><button class="link-btn" data-action="select-visible">Seleccionar visibles</button><button class="link-btn" data-action="clear-targets">Limpiar</button></span></div>
  </div>${c.destination === "all" && instagramAccounts().some((account) => account.status === "connected") ? instagramBlock() : ""}`;
  $(".targets-list", box).scrollTop = scrollTop;
  updateComposerHints();
}

function updateComposerHints() {
  const targets = composerTargets();
  const label = $("#publish-label");
  if (label) label.textContent = targets.length > 1 ? `Publicar en ${targets.length} destinos` : targets[0]?.type === "story" ? "Compartir en historia" : "Publicar";
  const hint = $("#now-hint");
  if (hint) hint.textContent = !targets.length ? "Elegí al menos un destino." : targets.length > 1 ? "Se publica uno por uno con la pausa elegida. Podés seguir el avance en Programación." : (confirmPublishing() ? "Se prepara en Facebook y confirmás antes de publicar." : "Se publica directo en Facebook al presionar el botón.");
  const scheduleHint = $("#schedule-hint");
  if (scheduleHint) scheduleHint.textContent = `${targets.length} destino(s) × ${state.composer.rows.length} fecha(s) = ${targets.length * state.composer.rows.length} publicación(es).`;
  const sub = $("#preview-sub");
  if (sub) sub.textContent = targets.length ? `${targets.length} destino(s)` : "";
}

function renderPreview() {
  const box = $("#composer-preview");
  if (!box) return;
  const c = state.composer;
  const text = c.text.trim();
  const media = c.media;
  const name = profileName();
  const targets = composerTargets();
  if (c.destination === "instagram") {
    const account = instagramAccounts().find((item) => c.instagram.ids.has(item.id));
    const first = media.find((item) => isImage(item) || isVideo(item));
    const caption = (c.instagram.caption || text).trim();
    const handle = account ? account.username : "tu_cuenta";
    if (c.instagram.format === "post") {
      box.innerHTML = `<article class="ig-post"><div class="ig-post-head"><span class="avatar xs solid-pink">${icon("image", "xs")}</span><b>${esc(handle)}</b></div><div class="ig-post-media">${first ? (isImage(first) ? `<img src="${mediaUrl(first)}" alt="" />` : `<video src="${mediaUrl(first)}" muted controls></video>`) : '<span>Agregá una imagen o video</span>'}${media.length > 1 ? `<span class="ig-count">1/${media.length}</span>` : ""}</div><div class="ig-post-actions">${icon("heart", "sm")} ${icon("message", "sm")} ${icon("send", "sm")}</div><p class="ig-caption"><b>${esc(handle)}</b> ${esc(caption)}</p></article>`;
    } else {
      box.innerHTML = `<div class="story-preview ig-story">${first ? (isImage(first) ? `<img src="${mediaUrl(first)}" alt="" />` : `<video src="${mediaUrl(first)}" muted autoplay loop></video>`) : ""}<div class="story-user"><span class="avatar xs solid-pink">${icon("image", "xs")}</span>${esc(handle)} · ${IG_FORMATS[c.instagram.format]}</div>${c.instagram.format === "reel" && caption ? `<div class="story-text" style="align-self:end;font-size:14px;font-weight:600">${esc(caption)}</div>` : ""}${first ? "" : '<div class="story-text">Agregá un video</div>'}</div>`;
    }
    return;
  }
  if (c.destination === "story") {
    const first = media.find((item) => isImage(item) || isVideo(item));
    box.innerHTML = `<div class="story-preview">${first ? (isImage(first) ? `<img src="${mediaUrl(first)}" alt="" />` : `<video src="${mediaUrl(first)}" muted autoplay loop></video>`) : ""}<div class="story-user">${avatar(name, { size: "xs", image: state.profile?.avatarUrl })}${esc(name)}</div><div class="story-text">${esc(text || "Tu historia")}</div></div>`;
    return;
  }
  const visual = media.filter((item) => isImage(item) || isVideo(item)).slice(0, 4);
  const files = media.filter((item) => !isImage(item) && !isVideo(item));
  const where = targets.length === 1 && targets[0].type !== "profile" ? ` ▸ ${esc(targets[0].name)}` : targets.length > 1 ? ` ▸ ${targets.length} destinos` : "";
  box.innerHTML = `<article class="fb-post">
    <div class="fb-post-head">${avatar(name, { size: "sm", image: state.profile?.avatarUrl })}<div><strong>${esc(name)}${where}</strong><small>Ahora · ${icon("globe", "xs")}</small></div></div>
    <div class="fb-post-text ${text.length && text.length < 90 && !media.length ? "big" : ""}">${esc(text) || '<span style="color:var(--faint)">El texto de tu publicación aparecerá acá.</span>'}</div>
    ${visual.length ? `<div class="fb-post-media n${visual.length}">${visual.map((item) => isImage(item) ? `<img src="${mediaUrl(item)}" alt="" />` : `<video src="${mediaUrl(item)}" muted controls></video>`).join("")}</div>` : ""}
    ${files.map((item) => `<div class="fb-post-media"><div class="file-face">${icon("file")} ${esc(item.name)} · ${formatBytes(item.size)}</div></div>`).join("")}
    <div class="fb-post-stats"><span>${icon("thumb", "xs")} 0</span><span>0 comentarios</span></div>
    <div class="fb-post-actions"><span>${icon("thumb", "sm")} Me gusta</span><span>${icon("message", "sm")} Comentar</span><span>${icon("share", "sm")} Compartir</span></div>
  </article>`;
}

async function uploadMediaFiles(files) {
  const uploaded = [];
  for (const file of files) {
    if (file.size > 100 * 1024 * 1024) { toast(`${file.name} supera el límite de 100 MB.`, { error: true }); continue; }
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error(`No se pudo leer ${file.name}.`));
      reader.readAsDataURL(file);
    });
    const result = await request("/api/media", { method: "POST", body: JSON.stringify({ name: file.name, mimeType: file.type || "application/octet-stream", data }) });
    uploaded.push(result.media);
  }
  return uploaded;
}

async function publishNow(button) {
  const c = state.composer;
  const text = c.text.trim();
  const targets = composerTargets();
  if (text.length < 3) { toast("Escribí un texto de al menos 3 caracteres.", { error: true }); return; }
  if (!targets.length) { toast("Elegí al menos un destino.", { error: true }); return; }
  const igProblem = instagramProblem(targets, c.media);
  if (igProblem) { toast(igProblem, { error: true }); return; }
  if (!confirmPublishing() || targets.some((target) => target.type === "instagram")) {
    await publishDirect(button, text, targets, c.media, Number(c.spacing) || 60);
    return;
  }
  if (targets.length > 1) {
    openModal({ kind: "bulk", text, targets, media: c.media, spacing: Number(c.spacing) || 60 });
    return;
  }
  const [target] = targets;
  await run(button, "Abriendo editor…", async () => {
    const media = c.media;
    if (target.type === "profile") await request("/api/publish/prepare", { method: "POST", body: JSON.stringify({ text, media }) });
    else if (target.type === "story") await request("/api/story/prepare", { method: "POST", body: JSON.stringify({ text, media }) });
    else if (target.type === "group") await request("/api/group-post/prepare", { method: "POST", body: JSON.stringify({ groupId: target.id, text, media }) });
    else if (target.type === "page") await request("/api/page-post/prepare", { method: "POST", body: JSON.stringify({ pageId: target.id, text, media }) });
    openModal({ kind: target.type, text, targets: [target], media, groupId: target.type === "group" ? target.id : null, pageId: target.type === "page" ? target.id : null });
    toast("Texto preparado en Facebook. Revisá la confirmación.");
  });
}

function confirmPublishing() { return storage.get("niro-confirm-publish", false) === true; }

// Publica en el acto: un destino con su endpoint directo, varios como envío masivo.
async function publishDirect(button, text, targets, media, spacing) {
  await run(button, targets.length > 1 ? "Iniciando envío…" : "Publicando…", async () => {
    const igCaption = state.composer.instagram.caption.trim() || text;
    if (targets.length > 1) {
      await request("/api/publish/bulk", { method: "POST", body: JSON.stringify({ text, targets: targets.filter((target) => target.type !== "instagram"), instagramTargets: targets.filter((target) => target.type === "instagram").map(({ id, format }) => ({ id, format })), instagramCaption: igCaption, media, spacingSeconds: spacing, ai: composerAiPayload() }) });
    } else if (targets[0].type === "instagram") {
      await request("/api/instagram/publish", { method: "POST", body: JSON.stringify({ accountId: targets[0].id, format: targets[0].format, media, caption: igCaption, ai: composerAiPayload() }) });
    } else {
      const [target] = targets;
      const ai = composerAiPayload();
      if (target.type === "profile") await request("/api/publish", { method: "POST", body: JSON.stringify({ text, media, ai }) });
      else if (target.type === "story") await request("/api/story", { method: "POST", body: JSON.stringify({ text, media, ai }) });
      else if (target.type === "group") await request("/api/group-post", { method: "POST", body: JSON.stringify({ groupId: target.id, text, media, ai }) });
      else if (target.type === "page") await request("/api/page-post", { method: "POST", body: JSON.stringify({ pageId: target.id, text, media, ai }) });
    }
    state.composer.text = "";
    state.composer.media = [];
    storage.set("niro-composer-text", "");
    toast(targets.length > 1 ? `Publicando en ${targets.length} destinos, uno por uno.` : `Publicado en ${cleanGroupName(targets[0].name)}.`, { title: "Listo" });
    await refresh({ soft: false });
    if (targets.length > 1) navigate("#/programacion");
  });
}

async function saveSchedule(button) {
  const c = state.composer;
  const text = c.text.trim();
  const targets = composerTargets();
  if (text.length < 3) { toast("Escribí un texto principal de al menos 3 caracteres.", { error: true }); return; }
  if (!targets.length) { toast("Elegí al menos un destino.", { error: true }); return; }
  const entries = c.rows.map((row) => {
    const timestamp = Date.parse(row.runAt);
    return { runAt: Number.isNaN(timestamp) ? "" : new Date(timestamp).toISOString(), text: row.text.trim() || text, media: row.media.map((item) => item.id) };
  }).filter((entry) => entry.runAt);
  if (!entries.length) { toast("Agregá al menos una fecha y hora válida.", { error: true }); return; }
  if (targets.some((target) => target.type === "instagram") && !c.media.length && c.rows.some((row) => !row.media.length)) { toast("Instagram necesita una imagen o video en cada fecha (o en los adjuntos generales).", { error: true }); return; }
  if (entries.some((entry) => Date.parse(entry.runAt) < Date.now() - 60_000)) toast("Hay fechas en el pasado: se publicarán en cuanto corra el programador.");
  const destination = c.destination;
  const body = {
    destination,
    instagramTargets: targets.filter((target) => target.type === "instagram").map(({ id, format }) => ({ id, format })),
    instagramCaption: c.instagram.caption.trim(),
    groupIds: targets.filter((target) => target.type === "group").map((target) => target.id),
    pageIds: targets.filter((target) => target.type === "page").map((target) => target.id),
    includeProfile: destination === "all" && c.includeProfile,
    includeStory: destination === "all" && c.includeStory,
    text,
    media: c.media,
    entries,
    startAt: entries[0].runAt,
    intervalMinutes: 5,
    autoPublish: c.auto,
    ai: composerAiPayload(),
  };
  await run(button, "Guardando…", async () => {
    await request("/api/schedules", { method: "POST", body: JSON.stringify(body) });
    c.rows = [];
    await refresh();
    toast(c.auto ? "Programación automática guardada. Activá “Publicación automática” para que corra." : "Programación guardada para revisión manual.", { title: "Calendario actualizado" });
    navigate("#/programacion");
  });
}

/* ------------------------------------------------------------------ Programación */
function renderSchedule() {
  const status = state.status || {};
  const schedulerOn = Boolean(status.scheduler?.enabled);
  $("#view").innerHTML = `
    <div class="page-title"><div><span class="eyebrow">Cola de publicación</span><h1>Programación</h1><p>Calendario de todo lo programado. Tocá un día para agregar una publicación en esa fecha.</p></div>
      <div class="actions"><button class="btn primary" data-action="go-compose" data-mode="schedule">${icon("plus", "sm")} Nueva programación</button></div></div>
    <section class="card card-pad" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
      <span class="kpi-icon ${schedulerOn ? "bg-green" : "bg-orange"}">${icon("zap")}</span>
      <div style="flex:1;min-width:220px"><strong>${schedulerOn ? `Publicación automática activa · revisa cada ${status.scheduler.intervalSeconds}s` : "Publicación automática inactiva"}</strong><div style="color:var(--muted);font-size:13px">Solo las programaciones marcadas como automáticas se publican solas. Las manuales se preparan para que confirmes.${status.scheduler?.lastError ? ` Último error: ${esc(status.scheduler.lastError)}` : ""}</div></div>
      <button class="btn ${schedulerOn ? "gray" : "success"}" data-action="toggle-scheduler">${icon(schedulerOn ? "pause" : "play", "sm")} ${schedulerOn ? "Pausar automatización" : "Activar automatización"}</button>
    </section>
    <section class="card">
      <div class="card-head"><h3>${capitalize(state.calMonth.toLocaleDateString("es", { month: "long", year: "numeric" }))}</h3><div class="actions"><button class="round-btn" data-action="cal-prev" aria-label="Mes anterior">${icon("left", "sm")}</button><button class="btn gray sm" data-action="cal-today">Hoy</button><button class="round-btn" data-action="cal-next" aria-label="Mes siguiente">${icon("right", "sm")}</button></div></div>
      <div class="card-body">${monthGrid()}</div>
    </section>
    <section class="card">
      <div class="card-head"><h3>Programaciones</h3><span class="tag violet">${state.schedules.length}</span></div>
      <div class="card-body">${state.schedules.length ? state.schedules.map(scheduleCard).join("") : emptyState("calendar", "Aún no hay programaciones", "Creá una publicación y elegí “Programar” para agregar fechas.")}</div>
    </section>`;
}

function monthGrid() {
  const start = new Date(state.calMonth);
  const offset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - offset);
  const byDay = new Map();
  for (const schedule of state.schedules) {
    for (const job of schedule.jobs || []) {
      const date = new Date(job.status === "published" && job.publishedAt ? job.publishedAt : job.runAt);
      const key = date.toDateString();
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push({ job, date });
    }
  }
  const today = new Date().toDateString();
  const cells = [];
  for (let index = 0; index < 42; index += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    if (index === 35 && day.getMonth() !== state.calMonth.getMonth()) break;
    const items = (byDay.get(day.toDateString()) || []).sort((a, b) => a.date - b.date);
    const out = day.getMonth() !== state.calMonth.getMonth();
    cells.push(`<div class="day ${out ? "out" : ""} ${day.toDateString() === today ? "today" : ""}" data-action="cal-day" data-date="${day.toISOString()}" title="Agregar publicación este día"><span class="num">${day.getDate()}</span>${items.slice(0, 3).map(({ job, date }) => `<span class="ev ${job.status}" title="${esc(`${job.target?.name}: ${job.text || ""}`)}">${date.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })} ${esc(cleanGroupName(job.target?.name || ""))}</span>`).join("")}${items.length > 3 ? `<span class="more">+${items.length - 3} más</span>` : ""}</div>`);
  }
  const dows = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"].map((dow) => `<div class="dow">${dow}</div>`).join("");
  return `<div class="month">${dows}${cells.join("")}</div>`;
}

function scheduleCard(schedule) {
  const jobs = schedule.jobs || [];
  const total = jobs.length || 1;
  const published = jobs.filter((job) => job.status === "published").length;
  const failed = jobs.filter((job) => job.status === "failed").length;
  const running = jobs.some((job) => job.status === "running");
  const next = jobs.filter((job) => job.status === "queued").sort((a, b) => String(a.runAt).localeCompare(String(b.runAt)))[0];
  const targets = schedule.targets || [];
  const names = targets.slice(0, 3).map((target) => cleanGroupName(target.name)).join(", ") + (targets.length > 3 ? ` y ${targets.length - 3} más` : "");
  const statusTag = running ? '<span class="tag orange">Publicando…</span>'
    : schedule.status === "paused" ? '<span class="tag">Pausada</span>'
      : schedule.status === "failed" ? '<span class="tag red">Revisar errores</span>'
        : schedule.status === "completed" ? '<span class="tag green">Completada</span>'
          : schedule.mode === "bulk" ? '<span class="tag blue">Envío masivo</span>'
            : schedule.autoPublish ? '<span class="tag orange">Automática</span>' : '<span class="tag violet">Manual</span>';
  return `<article class="schedule-card">
    <div class="top">${targetAvatar(targets[0] || { type: schedule.destination === "story" ? "story" : "profile" }, "")}<div class="grow"><strong>${esc(names || "Destino")}</strong><p>${esc(schedule.text || "")}</p><span class="time">${published}/${jobs.length} publicadas${failed ? ` · ${failed} con error` : ""} · ${next ? `próxima ${when(next.runAt)}` : "sin pendientes"}</span></div>${statusTag}</div>
    <div class="progress"><span class="ok" style="width:${(published / total) * 100}%"></span><span class="ko" style="width:${(failed / total) * 100}%"></span></div>
    <details class="jobs-toggle"><summary>Ver ${jobs.length} publicación(es)</summary><div class="jobs">${jobs.map((job) => `<div class="job">${jobStatusIcon(job)}<span class="grow"><b>${esc(cleanGroupName(job.target?.name || ""))}</b> · ${esc((job.text || "").slice(0, 80))}${job.lastError ? `<br /><span class="err">${esc(job.lastError)}</span>` : ""}</span><span class="time">${when(job.publishedAt || job.runAt)}</span>${job.status === "queued" ? `<button class="btn ghost xs" data-action="prepare-job" data-schedule="${esc(schedule.id)}" data-job="${esc(job.id)}">Preparar</button>` : ""}</div>`).join("")}</div></details>
    <div class="actions">
      ${next ? `<button class="btn soft sm" data-action="prepare-job" data-schedule="${esc(schedule.id)}" data-job="${esc(next.id)}">${icon("eye", "sm")} ${schedule.autoPublish ? "Revisar siguiente" : "Preparar siguiente"}</button><button class="btn ghost sm" data-action="run-schedule" data-schedule="${esc(schedule.id)}">${icon("rocket", "sm")} Publicar pendientes ahora</button>` : ""}
      ${schedule.autoPublish && schedule.status !== "completed" ? `<button class="btn ghost sm" data-action="toggle-schedule" data-schedule="${esc(schedule.id)}" data-next="${schedule.status === "paused" ? "queued" : "paused"}">${icon(schedule.status === "paused" ? "play" : "pause", "sm")} ${schedule.status === "paused" ? "Reanudar" : "Pausar"}</button>` : ""}
      ${failed ? `<button class="btn ghost sm" data-action="retry-schedule" data-schedule="${esc(schedule.id)}">${icon("refresh", "sm")} Reintentar fallidas</button>` : ""}
      <button class="btn danger sm" data-action="delete-schedule" data-schedule="${esc(schedule.id)}">${icon("trash", "sm")} Quitar</button>
    </div>
  </article>`;
}

function jobStatusIcon(job) {
  const map = { published: ["check", "var(--green)"], failed: ["alert", "var(--red)"], running: ["refresh", "var(--orange)"], queued: ["clock", "var(--violet)"] };
  const [name, color] = map[job.status] || map.queued;
  return `<span style="color:${color}">${icon(name, "sm")}</span>`;
}

/* ------------------------------------------------------------------ Publicaciones */
/* ------------------------------------------------------------------ Grupos y páginas */
function renderGroups() {
  const search = state.groupSearch.toLowerCase();
  const groups = state.groups.filter((group) => !search || group.name.toLowerCase().includes(search));
  const selected = state.selectedGroupIds.size;
  $("#view").innerHTML = `
    <div class="page-title"><div><span class="eyebrow">Comunidades</span><h1>Grupos</h1><p>${state.groups.length} grupos sincronizados. Seleccioná varios para publicar en todos o descargar sus publicaciones.</p></div>
      <div class="actions"><a class="btn soft" href="#/explorar">${icon("search", "sm")} Explorar grupos nuevos</a><button class="btn gray" data-action="scan-groups">${icon("refresh", "sm")} Actualizar grupos</button><a class="btn ghost" href="${BASE}/api/export?kind=groups&format=csv" download>${icon("download", "sm")} CSV</a></div></div>
    <section class="card card-pad"><div class="toolbar"><input id="group-search" type="search" placeholder="Buscar grupos…" value="${esc(state.groupSearch)}" /><span class="tag violet">${selected} seleccionado(s)</span><button class="btn soft sm" data-action="groups-select-visible">Seleccionar visibles</button><button class="btn ghost sm" data-action="groups-clear">Limpiar</button><button class="btn primary sm" data-action="groups-publish" ${selected ? "" : "disabled"}>${icon("send", "sm")} Publicar en seleccionados</button><button class="btn gray sm" data-action="groups-posts" ${selected ? "" : "disabled"} title="Máximo 25 grupos por lectura">${icon("download", "sm")} Leer publicaciones</button></div></section>
    ${groups.length ? `<div class="entity-grid">${groups.slice(0, state.groupLimit).map((group) => entityCard("group", group, state.selectedGroupIds.has(group.id))).join("")}</div>${groups.length > state.groupLimit ? `<div class="pager"><button class="btn gray" data-action="groups-more">Ver más (${groups.length - state.groupLimit} restantes)</button></div>` : ""}` : `<section class="card">${emptyState("users", search ? "Sin resultados" : "Sin grupos", search ? "Probá con otra búsqueda." : "Conectá Facebook y presioná “Actualizar grupos”.")}</section>`}`;
}

function renderPages() {
  const search = state.pageSearch.toLowerCase();
  const pages = state.pages.filter((page) => !search || page.name.toLowerCase().includes(search));
  const selected = state.selectedPageIds.size;
  $("#view").innerHTML = `
    <div class="page-title"><div><span class="eyebrow">Marcas</span><h1>Páginas</h1><p>Páginas que administrás. Publicá en una o en todas a la vez y descargá sus publicaciones.</p></div>
      <div class="actions"><button class="btn gray" data-action="scan-pages">${icon("refresh", "sm")} Actualizar páginas</button><a class="btn ghost" href="${BASE}/api/export?kind=pages&format=csv" download>${icon("download", "sm")} CSV</a></div></div>
    <section class="card card-pad"><div class="toolbar"><input id="page-search" type="search" placeholder="Buscar páginas…" value="${esc(state.pageSearch)}" /><span class="tag violet">${selected} seleccionada(s)</span><button class="btn soft sm" data-action="pages-select-visible">Seleccionar visibles</button><button class="btn primary sm" data-action="pages-publish" ${selected ? "" : "disabled"}>${icon("send", "sm")} Publicar en seleccionadas</button><button class="btn gray sm" data-action="pages-posts" ${state.pages.length ? "" : "disabled"}>${icon("download", "sm")} Leer publicaciones</button></div></section>
    ${pages.length ? `<div class="entity-grid">${pages.map((page) => entityCard("page", page, state.selectedPageIds.has(page.id))).join("")}</div>` : `<section class="card">${emptyState("flag", search ? "Sin resultados" : "Sin páginas", search ? "Probá con otra búsqueda." : "Conectá Facebook y presioná “Actualizar páginas”. Solo aparecen las páginas que administra la cuenta.")}</section>`}`;
}

function entityCard(type, item, selected) {
  const name = type === "group" ? cleanGroupName(item.name) : item.name;
  const activity = type === "group" ? (item.lastActive || item.name.match(/(Activo por última vez.*|Última actividad.*)$/i)?.[0] || "") : "";
  const postCount = state.posts.filter((post) => post.ownerType === type && post.ownerId === item.id).length;
  const facts = [
    activity,
    item.notificationCount ? `${item.notificationCount} notificaciones` : "",
    item.messageCount ? `${item.messageCount} mensajes` : "",
    postCount ? `${postCount} publicaciones guardadas` : "",
  ].filter(Boolean).join(" · ") || `ID ${item.id}`;
  return `<article class="entity ${selected ? "selected" : ""}"><div class="entity-cover ${tone(item.id)}" style="opacity:.28"></div><div class="entity-body">${avatar(name, { seed: item.id, square: type === "group", image: item.avatarUrl })}<strong title="${esc(name)}">${esc(name)}</strong><span class="time">${esc(facts)}</span><div class="foot"><label class="check-chip"><input type="checkbox" data-select-${type}="${esc(item.id)}" ${selected ? "checked" : ""} /> Seleccionar</label><span style="flex:1"></span><button class="btn ghost xs" data-action="open-url" data-url="${esc(item.url)}" title="Abrir en Facebook">${icon("external", "xs")}</button><button class="btn soft xs" data-action="compose-to" data-type="${type}" data-id="${esc(item.id)}">${icon("edit", "xs")} Publicar</button></div></div></article>`;
}

/* ------------------------------------------------------------------ Borradores */
function renderDrafts() {
  const drafts = dedupedDrafts();
  $("#view").innerHTML = `
    <div class="page-title"><div><span class="eyebrow">Revisión humana</span><h1>Borradores de Niro</h1><p>Cada aviso nuevo genera un borrador de respuesta. Nada se envía sin tu confirmación.</p></div></div>
    ${drafts.length ? drafts.slice(0, 60).map((draft) => {
      const event = state.events.find((item) => item.id === draft.eventId) || draft.event;
      return `<section class="card"><div class="card-head"><div style="display:flex;gap:10px;align-items:center;min-width:0">${avatar(event ? eventSender(event) : "Niro", { size: "sm", image: eventImage(event) })}<div style="min-width:0"><strong>${esc(event ? eventTitle(event) : "Aviso")}</strong><div class="time">${timeAgo(draft.createdAt)}</div></div></div><span class="tag ${draft.status === "reviewed" ? "green" : "orange"}">${draft.status === "reviewed" ? "Revisado" : "Para revisar"}</span></div><div class="card-body draft-box"><textarea data-draft-id="${esc(draft.id)}">${esc(draft.body)}</textarea><div class="actions" style="margin-top:8px"><button class="btn soft sm" data-action="save-draft" data-draft="${esc(draft.id)}">Guardar revisión</button>${event ? `<button class="btn ghost sm" data-action="select-event" data-event="${esc(event.id)}">Ver aviso</button>` : ""}</div></div></section>`;
    }).join("") : `<section class="card">${emptyState("file", "Aún no hay borradores", "Los eventos nuevos generan un borrador para revisión humana.")}</section>`}`;
}

/* ------------------------------------------------------------------ Datos */
function renderData() {
  const status = state.status || {};
  const db = state.db;
  const connected = Boolean(status.browserOpen);
  const exportsList = [["all", "json", "Todo (JSON)"], ["groups", "csv", "Grupos (CSV)"], ["pages", "csv", "Páginas (CSV)"], ["chats", "json", "Chats (JSON)"], ["messages", "csv", "Mensajes (CSV)"], ["events", "csv", "Avisos (CSV)"], ["publications", "csv", "Historial publicado (CSV)"], ["posts", "csv", "Publicaciones descargadas (CSV)"], ["schedules", "json", "Programaciones (JSON)"]];
  $("#view").innerHTML = `
    <div class="page-title"><div><span class="eyebrow">Sistema</span><h1>Datos y sincronización</h1><p>Conexión con Facebook, sincronizaciones, base de datos PostgreSQL y descargas.</p></div></div>
    <section class="card">
      <div class="card-head"><h3>Conexión con Facebook</h3><span class="tag ${connected ? "green" : ""}">${connected ? "Conectado" : "Sin conectar"}</span></div>
      <div class="card-body"><p style="color:var(--muted);font-size:13px">Niro usa un perfil de navegador separado (${esc(status.profilePath || "")}). La sesión se guarda solo en este equipo; tratá esa carpeta como una credencial.</p>
        ${status.remoteView ? "" : `<div class="automation" style="margin-top:10px"><span class="kpi-icon bg-violet">${icon("eye")}</span><div class="grow"><strong>Trabajar en segundo plano (sin ventana)</strong><small>${status.headless ? "Chrome publica y lee Facebook por detrás, sin abrir ventanas." : "Chrome se muestra en pantalla mientras trabaja."} ${status.browserMode ? `Ahora: ${status.browserMode === "headless" ? "segundo plano" : "ventana visible"}.` : ""}</small></div><button class="switch ${status.headless ? "on" : ""}" data-action="browser-mode" data-headless="${status.headless ? "false" : "true"}" aria-pressed="${Boolean(status.headless)}" aria-label="Segundo plano"></button></div>`}
        ${status.remoteView ? `<div class="actions" style="margin-top:12px"><button class="btn primary" data-action="remote-view">${icon("login", "sm")} Abrir Facebook (iniciar sesión / revisar)</button>${connected ? `<button class="btn gray" data-action="close-browser">${icon("logout", "sm")} Cerrar navegador</button>` : ""}</div></div>` : `<div class="actions" style="margin-top:12px"><button class="btn primary" data-action="open-browser">${icon("login", "sm")} ${connected ? (status.browserMode === "headless" ? "Conectado en segundo plano" : "Traer ventana al frente") : "Conectar Facebook"}</button>${status.headless ? `<button class="btn gray" data-action="browser-mode" data-headless="false">${icon("eye", "sm")} Mostrar navegador (para iniciar sesión)</button>` : `<button class="btn gray" data-action="browser-mode" data-headless="true">${icon("eye", "sm")} Volver a segundo plano</button>`}${connected ? `<button class="btn gray" data-action="close-browser">${icon("logout", "sm")} Cerrar navegador</button>` : ""}</div></div>`}
    </section>
    <section class="card">
      <div class="card-head"><div><h3>Instagram · cuentas conectadas</h3><span class="sub">Se publica con Meta Business Suite usando la cuenta de Instagram vinculada a cada página. No se guardan contraseñas de Instagram.</span></div><button class="btn gray sm" data-action="ig-discover">${icon("refresh", "sm")} Revisar cuentas</button></div>
      <div class="card-body"><div class="rows">${instagramAccounts().length ? instagramAccounts().map((account) => `<div class="row"><span class="avatar sm ${account.status === "connected" ? "solid-pink" : "solid-gray"}">${icon("image", "sm")}</span><span class="grow"><span class="title">${account.username ? "@" + esc(account.username) : "Sin Instagram"} · ${esc(account.pageName)}</span><span class="sub">${esc(account.statusDetail || "")} · revisada ${timeAgo(account.checkedAt)}</span></span><span class="tag ${account.status === "connected" ? "green" : account.status === "attention" ? "orange" : ""}">${{ connected: "Conectada", disconnected: "Desconectada", attention: "Requiere atención" }[account.status] || account.status}</span>${account.status !== "connected" ? `<button class="btn ghost xs" data-action="ig-connect" data-page="${esc(account.pageId)}">Conectar Instagram</button>` : ""}</div>`).join("") : '<p class="sub">Todavía no se revisaron las cuentas. Presioná “Revisar cuentas”.</p>'}</div></div>
    </section>
    <section class="card" id="sync-panel">${renderSyncPanel()}</section>
    <section class="card">
      <div class="card-head"><h3>Base de datos</h3><button class="btn ghost sm" data-action="load-db">${icon("refresh", "sm")} Actualizar</button></div>
      <div class="card-body">${db ? (db.engine === "postgresql" ? `<p style="color:var(--muted);font-size:13px;margin-bottom:12px"><b style="color:var(--ink)">PostgreSQL · ${esc(db.database || "")}</b> · ${esc(db.size || "")} · último guardado ${timeAgo(db.lastSavedAt)}${db.lastError ? ` · <span style="color:var(--red)">${esc(db.lastError)}</span>` : ""}</p><div class="db-grid">${[["events", "Avisos"], ["chats", "Chats"], ["messages", "Mensajes"], ["groups", "Grupos"], ["pages", "Páginas"], ["schedules", "Programaciones"], ["jobs", "Trabajos en cola"], ["publications", "Publicaciones"], ["posts", "Posts descargados"]].map(([key, label]) => `<div class="db-cell"><strong>${db[key] ?? 0}</strong><span>${label}</span></div>`).join("")}</div>` : `<p>Modo archivo JSON (${esc(db.path || "")}). Definí <code>NIRO_DATABASE_URL</code> en .env para usar PostgreSQL.</p>`) : '<p style="color:var(--muted)">Cargando…</p>'}</div>
    </section>
    <section class="card">
      <div class="card-head"><h3>Descargas</h3></div>
      <div class="card-body"><div class="export-list">${exportsList.map(([kind, format, label]) => `<a class="btn ghost" href="${BASE}/api/export?kind=${kind}&format=${format}" download>${icon("download", "sm")} ${label}</a>`).join("")}</div></div>
    </section>
    <section class="card">
      <div class="card-head"><h3>Herramientas</h3></div>
      <div class="card-body"><div class="actions"><button class="btn gray" data-action="enable-desktop">${icon("bell", "sm")} Avisos de escritorio</button><button class="btn gray" data-action="toggle-theme">${icon("moon", "sm")} Cambiar tema</button><button class="btn ghost" data-action="demo">${icon("sparkles", "sm")} Cargar datos de ejemplo</button></div></div>
    </section>`;
  if (!state.db) loadDb();
}

/* ------------------------------------------------------------------ Sincronización a pedido */
const SYNC_ITEMS = [
  { key: "profile", group: "base", icon: "home", tone: "bg-violet", title: "Perfil", text: "Nombre, foto y portada del perfil conectado." },
  { key: "pages", group: "base", icon: "flag", tone: "bg-orange", title: "Lista de páginas", text: "Páginas que administrás, con foto y contadores." },
  { key: "groups", group: "base", icon: "users", tone: "bg-green", title: "Lista de grupos", text: "Grupos donde participás. Necesario para publicar en grupos." },
  { key: "notifications", group: "data", icon: "bell", tone: "bg-red", title: "Notificaciones", text: "Comentarios, reacciones, menciones y avisos de la cuenta." },
  { key: "chats", group: "data", icon: "message", tone: "bg-blue", title: "Lista de chats", text: "Conversaciones de Messenger con su último mensaje." },
  { key: "chatHistory", group: "data", icon: "inbox", tone: "bg-blue", title: "Historial de mensajes", text: "Todos los mensajes de cada chat. Es lento: recorre chat por chat.", heavy: true },
];

function isPublishOnly(settings) {
  return !settings.notifications && !settings.chats && !settings.chatHistory && !settings.postsProfile && !settings.postPageIds.length && !settings.postGroupIds.length;
}

function syncItemRow(item, settings) {
  return `<label class="row sync-row"><input type="checkbox" data-sync-setting="${item.key}" ${settings[item.key] ? "checked" : ""} /><span class="kpi-icon ${item.tone}">${icon(item.icon)}</span><span class="grow"><span class="title">${esc(item.title)}${item.heavy ? ' <span class="tag orange">Pesado</span>' : ""}</span><span class="sub">${esc(item.text)}</span></span><button class="btn ghost xs" data-action="sync-only" data-item="${item.key}" title="Sincronizar solo esto">${icon("refresh", "xs")} Solo esto</button></label>`;
}

function syncProgressHtml() {
  const sync = state.sync?.state;
  if (!sync) return "";
  if (sync.running) {
    const pct = sync.total ? Math.round((sync.done / sync.total) * 100) : 0;
    return `<div class="sync-progress running"><div class="sync-progress-head"><span class="pulse"></span><strong>Sincronizando · ${sync.done}/${sync.total}</strong><span class="grow">${esc(sync.detail || "")}</span><button class="btn danger sm" data-action="sync-cancel" ${sync.cancelRequested ? "disabled" : ""}>${icon("pause", "sm")} ${sync.cancelRequested ? "Deteniendo…" : "Detener"}</button></div><div class="progress"><span class="ok" style="width:${pct}%;background:var(--violet)"></span></div></div>`;
  }
  if (!sync.finishedAt) return "";
  return `<div class="sync-progress"><div class="sync-progress-head"><span class="pulse ${sync.cancelRequested ? "warn" : ""}"></span><strong>${sync.cancelRequested ? "Sincronización detenida" : "Última sincronización"}</strong><span class="grow time">${timeAgo(sync.finishedAt)}</span></div>${(sync.results || []).map((result) => `<div class="sync-result">${icon(result.ok ? "check" : "alert", "sm")}<b>${esc(result.label)}</b><span>${esc(result.summary)}</span></div>`).join("")}</div>`;
}

function renderSyncPanel() {
  const settings = state.sync?.settings;
  if (!settings) return `<div class="card-body"><p style="color:var(--muted)">Cargando configuración…</p></div>`;
  const running = Boolean(state.sync?.state?.running);
  const publishOnly = isPublishOnly(settings);
  const pageOptions = state.pages.map((page) => `<label class="target-option">${avatar(page.name, { size: "sm", seed: page.id, image: page.avatarUrl })}<span class="grow"><strong>${esc(page.name)}</strong><small>${state.posts.filter((post) => post.ownerId === page.id).length} guardadas</small></span><input type="checkbox" data-sync-page="${esc(page.id)}" ${settings.postPageIds.includes(page.id) ? "checked" : ""} /></label>`).join("");
  const groupSearch = (state.syncGroupSearch || "").toLowerCase();
  const groupOptions = state.groups
    .filter((group) => settings.postGroupIds.includes(group.id) || !groupSearch || group.name.toLowerCase().includes(groupSearch))
    .sort((a, b) => Number(settings.postGroupIds.includes(b.id)) - Number(settings.postGroupIds.includes(a.id)))
    .slice(0, 80)
    .map((group) => `<label class="target-option">${avatar(cleanGroupName(group.name), { size: "sm", seed: group.id, square: true, image: group.avatarUrl })}<span class="grow"><strong>${esc(cleanGroupName(group.name))}</strong><small>Grupo</small></span><input type="checkbox" data-sync-group="${esc(group.id)}" ${settings.postGroupIds.includes(group.id) ? "checked" : ""} /></label>`).join("");
  return `<div class="card-head"><div><h3>Sincronización</h3><span class="sub">Elegí qué información descargar de Facebook. Nada se descarga si no lo marcás.</span></div><span class="tag ${publishOnly ? "violet" : "green"}">${publishOnly ? "Modo solo publicar" : "Descarga activa"}</span></div>
    <div class="card-body">
      ${syncProgressHtml()}
      <div class="sync-section-title">Necesario para publicar</div>
      <div class="rows">${SYNC_ITEMS.filter((item) => item.group === "base").map((item) => syncItemRow(item, settings)).join("")}</div>
      <div class="sync-section-title">Descargar información (opcional)</div>
      <div class="rows">${SYNC_ITEMS.filter((item) => item.group === "data").map((item) => syncItemRow(item, settings)).join("")}</div>
      <details class="sync-details" ${settings.postsProfile || settings.postPageIds.length || settings.postGroupIds.length ? "open" : ""}>
        <summary><span class="kpi-icon bg-blue">${icon("layers")}</span><span class="grow"><span class="title">Historial de publicaciones</span><span class="sub">${[settings.postsProfile ? "perfil" : "", settings.postPageIds.length ? `${settings.postPageIds.length} página(s)` : "", settings.postGroupIds.length ? `${settings.postGroupIds.length} grupo(s)` : ""].filter(Boolean).join(" · ") || "Nada elegido"} · ${state.posts.length} guardadas</span></span><button class="btn ghost xs" data-action="sync-only" data-item="posts">${icon("refresh", "xs")} Solo esto</button></summary>
        <label class="target-option"><input type="checkbox" data-sync-setting="postsProfile" ${settings.postsProfile ? "checked" : ""} />${avatar(profileName(), { size: "sm", image: state.profile?.avatarUrl })}<span class="grow"><strong>Mi perfil</strong><small>${state.posts.filter((post) => post.ownerType === "profile").length} guardadas</small></span></label>
        <div class="sync-list-head"><b>Páginas</b><span><button class="link-btn" data-action="sync-pages-all">Todas</button> · <button class="link-btn" data-action="sync-pages-none">Ninguna</button></span></div>
        <div class="targets-list sync-list">${pageOptions || '<p class="sub" style="color:var(--muted);padding:8px">Sincronizá primero la lista de páginas.</p>'}</div>
        <div class="sync-list-head"><b>Grupos (máximo 50)</b><input id="sync-group-search" type="search" placeholder="Buscar grupo…" value="${esc(state.syncGroupSearch || "")}" /></div>
        <div class="targets-list sync-list">${groupOptions || '<p class="sub" style="color:var(--muted);padding:8px">Sin grupos para mostrar.</p>'}</div>
      </details>
      <div class="sync-section-title">Monitoreo automático</div>
      <div class="actions"><label class="check-chip"><input type="checkbox" data-sync-setting="monitorNotifications" ${settings.monitorNotifications ? "checked" : ""} /> Revisar notificaciones</label><label class="check-chip"><input type="checkbox" data-sync-setting="monitorChats" ${settings.monitorChats ? "checked" : ""} /> Revisar chats</label></div>
      <div class="publish-bar"><span class="hint">Se ejecuta en segundo plano. Podés detenerla en cualquier momento; lo ya descargado queda guardado.</span>
        ${running ? `<button class="btn danger" data-action="sync-cancel">${icon("pause", "sm")} Detener sincronización</button>` : `<button class="btn primary" data-action="sync-run">${icon("refresh", "sm")} Sincronizar lo seleccionado</button>`}</div>
    </div>`;
}

function updateSyncViews() {
  const panel = $("#sync-panel");
  if (panel && !isTyping()) { panel.innerHTML = renderSyncPanel(); }
  const float = $("#sync-float");
  const sync = state.sync?.state;
  if (float) {
    float.classList.toggle("hidden", !sync?.running || state.route === "datos");
    if (sync?.running) float.innerHTML = `<span class="pulse"></span><span class="grow"><b>Sincronizando ${sync.done}/${sync.total}</b><small>${esc(sync.detail || "")}</small></span><button class="btn danger xs" data-action="sync-cancel" ${sync.cancelRequested ? "disabled" : ""}>${sync.cancelRequested ? "Deteniendo…" : "Detener"}</button>`;
  }
}

async function saveSyncSettings(patch) {
  try {
    const result = await request("/api/sync/settings", { method: "PATCH", body: JSON.stringify(patch) });
    state.sync.settings = result.settings;
  } catch (error) { toast(error.message, { error: true }); }
  updateSyncViews();
}

async function startSync(body = {}, button = null) {
  return run(button, "Iniciando…", async () => {
    const result = await request("/api/sync/run", { method: "POST", body: JSON.stringify(body) });
    state.sync.state = result.state;
    updateSyncViews();
    toast("Sincronización iniciada. Podés seguir usando el panel.", { title: "Sincronización" });
  });
}

async function loadDb() {
  try { state.db = await request("/api/db/status"); } catch (error) { state.db = { engine: "postgresql", lastError: error.message }; }
  if (state.route === "datos") renderView();
}

/* ------------------------------------------------------------------ Modal de confirmación */
function openModal(action) {
  state.pendingAction = action;
  const targets = action.targets || [];
  const spacingLabel = action.spacing < 60 ? `${action.spacing} s` : `${action.spacing / 60} min`;
  const meta = {
    profile: ["Publicación", "¿Publicar en tu perfil?", "Será visible en tu perfil con la audiencia que tenga configurada Facebook.", "Publicar ahora"],
    story: ["Historia", "¿Compartir en tu historia?", "Será visible en tu historia de Facebook durante 24 horas.", "Compartir ahora"],
    group: ["Grupo", `¿Publicar en ${targets[0]?.name || "este grupo"}?`, "Será visible para los miembros del grupo.", "Publicar ahora"],
    page: ["Página", `¿Publicar en ${targets[0]?.name || "esta página"}?`, "Será visible para quienes siguen la página.", "Publicar ahora"],
    bulk: ["Envío masivo", `¿Publicar en ${targets.length} destinos?`, `Niro publicará uno por uno con una pausa de ${spacingLabel} entre cada destino. Podés pausarlo desde Programación.`, `Publicar en ${targets.length}`],
    schedule: ["Programación", `¿Publicar en ${cleanGroupName(targets[0]?.name || "el destino")}?`, "Se publicará esta entrada de la cola.", "Publicar ahora"],
    "run-schedule": ["Programación", "¿Publicar los pendientes ahora?", "Todas las publicaciones pendientes se enviarán una tras otra, con 45 s entre cada una.", "Publicar pendientes"],
    reply: ["Respuesta", "¿Enviar esta respuesta?", action.isMessenger ? "Se enviará un mensaje privado desde tu cuenta de Messenger." : "Se publicará una respuesta visible en el hilo original.", "Enviar respuesta"],
  }[action.kind];
  $("#modal-eyebrow").textContent = meta[0];
  $("#modal-title").textContent = meta[1];
  $("#modal-warning").textContent = meta[2];
  $("#modal-targets").innerHTML = targets.slice(0, 30).map((target) => `<span class="tag violet">${esc(cleanGroupName(target?.name || ""))}</span>`).join("") + (targets.length > 30 ? `<span class="tag">+${targets.length - 30}</span>` : "");
  const attachments = (action.media || []).length ? `\n\nAdjuntos:\n${action.media.map((item) => `• ${item.name} (${formatBytes(item.size)})`).join("\n")}` : "";
  $("#modal-preview").textContent = `${action.text || ""}${attachments}`;
  $("#modal-preview").classList.toggle("hidden", !action.text);
  $("#modal-confirm").textContent = meta[3];
  $("#modal").classList.remove("hidden");
  $("#modal-confirm").focus();
}

function closeModal({ cancelled = true } = {}) {
  const action = state.pendingAction;
  $("#modal").classList.add("hidden");
  state.pendingAction = null;
  // Si ya se preparó el editor en Facebook, se descarta para no bloquear la cola.
  if (cancelled && action && ["profile", "story", "group", "page", "schedule", "reply"].includes(action.kind)) {
    request("/api/publish/cancel", { method: "POST", body: "{}" }).catch(() => {});
  }
}

async function confirmModal() {
  const action = state.pendingAction;
  if (!action) return;
  const button = $("#modal-confirm");
  await run(button, "Enviando…", async () => {
    const media = action.media || [];
    const ai = composerAiPayload();
    if (action.kind === "profile") await request("/api/publish", { method: "POST", body: JSON.stringify({ text: action.text, media, ai }) });
    else if (action.kind === "story") await request("/api/story", { method: "POST", body: JSON.stringify({ text: action.text, media, ai }) });
    else if (action.kind === "group") await request("/api/group-post", { method: "POST", body: JSON.stringify({ groupId: action.groupId, text: action.text, media, ai }) });
    else if (action.kind === "page") await request("/api/page-post", { method: "POST", body: JSON.stringify({ pageId: action.pageId, text: action.text, media, ai }) });
    else if (action.kind === "bulk") await request("/api/publish/bulk", { method: "POST", body: JSON.stringify({ text: action.text, targets: action.targets, media, spacingSeconds: action.spacing, ai }) });
    else if (action.kind === "schedule") await request(`/api/schedules/${encodeURIComponent(action.scheduleId)}/publish`, { method: "POST", body: JSON.stringify({ jobId: action.jobId }) });
    else if (action.kind === "run-schedule") await request(`/api/schedules/${encodeURIComponent(action.scheduleId)}/run`, { method: "POST", body: "{}" });
    else if (action.kind === "reply") await request("/api/reply", { method: "POST", body: JSON.stringify({ eventId: action.eventId, text: action.text, actor: action.actor || null }) });
    closeModal({ cancelled: false });
    if (["profile", "story", "group", "page", "bulk"].includes(action.kind)) {
      state.composer.text = "";
      state.composer.media = [];
      storage.set("niro-composer-text", "");
    }
    const messages = {
      profile: "Publicación enviada a tu perfil.", story: "Historia publicada.", group: "Publicación enviada al grupo.", page: "Publicación enviada a la página.",
      bulk: `Envío masivo iniciado: ${targets(action).length} destinos.`, schedule: "Publicación enviada y cola actualizada.", "run-schedule": "Publicando pendientes…", reply: "Respuesta enviada.",
    };
    toast(messages[action.kind], { title: "Listo" });
    if (action.kind === "reply") { const field = $("#crm-reply") || $("#reply-text") || $("#chat-reply"); if (field) field.value = ""; }
    await refresh({ soft: false });
    if (action.kind === "bulk") navigate("#/programacion");
  });
}

function targets(action) { return action.targets || []; }

/* ------------------------------------------------------------------ Menús desplegables */
let openDropdown = null;
function closeDropdown() {
  $("#dropdown").classList.add("hidden");
  $$(".top-right .round-btn").forEach((button) => button.classList.remove("active"));
  openDropdown = null;
}

function showDropdown(kind, trigger, { force = false } = {}) {
  if (openDropdown === kind && !force) { closeDropdown(); return; }
  closeDropdown();
  openDropdown = kind;
  trigger?.classList.add("active");
  const box = $("#dropdown");
  if (kind === "bell") {
    const filter = state.bellFilter;
    const events = uniqueEvents().filter((event) => filter === "all" || event.read !== true).slice(0, 15);
    const permission = "Notification" in window ? Notification.permission : "unsupported";
    box.innerHTML = `<div class="dropdown-head"><h3>Notificaciones</h3><button class="link-btn" data-action="mark-all-read">Marcar todo leído</button></div>
      <div style="padding:0 16px 8px" class="pills"><button class="pill ${filter === "all" ? "active" : ""}" data-action="bell-filter" data-filter="all">Todas</button><button class="pill ${filter === "unread" ? "active" : ""}" data-action="bell-filter" data-filter="unread">No leídas</button></div>
      ${permission === "default" ? `<div style="padding:0 16px 8px"><button class="btn soft sm block" data-action="enable-desktop">${icon("bell", "sm")} Activar avisos de escritorio</button></div>` : ""}
      <div class="dropdown-body">${events.length ? events.map((event) => notifItem(event, { compact: true })).join("") : emptyState("bell", "Sin notificaciones", "Estás al día.")}</div>
      <div class="dropdown-foot"><a class="link-btn" href="#/notificaciones">Ver todas las notificaciones</a></div>`;
  } else if (kind === "messenger") {
    const chats = state.chats.slice(0, 12);
    box.innerHTML = `<div class="dropdown-head"><h3>Chats</h3><a class="link-btn" href="#/messenger">Abrir Messenger</a></div>
      <div class="dropdown-body">${chats.length ? chats.map((chat) => `<button class="chat-item ${chat.unreadCount ? "unread" : ""}" data-action="open-chat-view" data-chat="${esc(chat.id)}">${avatar(chat.name, { size: "lg", seed: chat.id, image: chat.avatarUrl })}<span class="grow"><strong>${esc(chatName(chat))}</strong><small>${esc((chat.lastMessage || chat.preview || "").slice(0, 80))}</small></span></button>`).join("") : emptyState("message", "Sin chats", "Sincronizá Messenger desde Datos.")}</div>
      <div class="dropdown-foot"><a class="link-btn" href="#/messenger">Ver todo en Messenger</a></div>`;
  } else if (kind === "account") {
    const status = state.status || {};
    const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    box.innerHTML = `<div class="menu-profile">${avatar(profileName(), { image: state.profile?.avatarUrl })}<div><strong>${esc(profileName())}</strong><small>${status.browserOpen ? "Facebook conectado" : "Facebook sin conectar"}</small></div></div>
      <div class="dropdown-body">
        <button class="menu-item" data-action="open-browser"><span class="menu-icon">${icon("login", "sm")}</span><span>${status.browserOpen ? "Traer Facebook al frente" : "Conectar Facebook"}<small>Perfil de navegador separado</small></span></button>
        <button class="menu-item" data-action="sync-all"><span class="menu-icon">${icon("refresh", "sm")}</span><span>Sincronizar todo<small>Perfil, grupos, páginas, chats y avisos</small></span></button>
        <a class="menu-item" href="#/datos"><span class="menu-icon">${icon("database", "sm")}</span><span>Datos y base<small>PostgreSQL, descargas</small></span></a>
        <button class="menu-item" data-action="toggle-theme"><span class="menu-icon">${icon(dark ? "sun" : "moon", "sm")}</span><span>${dark ? "Tema claro" : "Tema oscuro"}</span></button>
        ${status.authEnabled ? `<button class="menu-item" data-action="logout"><span class="menu-icon">${icon("lock", "sm")}</span><span>Cerrar sesión del panel</span></button>` : ""}
        ${status.browserOpen ? `<button class="menu-item" data-action="close-browser"><span class="menu-icon">${icon("logout", "sm")}</span><span>Cerrar navegador<small>Detiene monitoreo y automatización</small></span></button>` : ""}
      </div>`;
  } else if (hooks.dropdowns[kind]) {
    box.innerHTML = hooks.dropdowns[kind]();
  }
  box.dataset.kind = kind;
  // En pantallas anchas el menú queda alineado bajo el botón que lo abrió.
  const rect = trigger?.getBoundingClientRect();
  box.style.right = rect && window.innerWidth > 640 ? `${Math.max(8, window.innerWidth - rect.right - 4)}px` : "";
  box.classList.remove("hidden");
}

/* ------------------------------------------------------------------ Búsqueda global */
function renderSearch(query) {
  const box = $("#search-results");
  const q = query.trim().toLowerCase();
  if (q.length < 2) { box.classList.add("hidden"); return; }
  const results = [
    ...state.groups.filter((group) => group.name.toLowerCase().includes(q)).slice(0, 5).map((group) => ({ type: "group", id: group.id, title: cleanGroupName(group.name), sub: "Grupo", image: group.avatarUrl })),
    ...state.pages.filter((page) => page.name.toLowerCase().includes(q)).slice(0, 5).map((page) => ({ type: "page", id: page.id, title: page.name, sub: "Página", image: page.avatarUrl })),
    ...state.chats.filter((chat) => `${chat.name} ${chat.preview}`.toLowerCase().includes(q)).slice(0, 5).map((chat) => ({ type: "chat", id: chat.id, title: chatName(chat), sub: "Chat de Messenger", image: chat.avatarUrl })),
    ...uniqueEvents().filter((event) => (event.text || "").toLowerCase().includes(q)).slice(0, 5).map((event) => ({ type: "event", id: event.id, title: eventTitle(event), sub: "Aviso", image: eventImage(event) })),
  ];
  box.innerHTML = results.length ? results.map((result) => `<button class="result" data-search-type="${result.type}" data-search-id="${esc(result.id)}">${avatar(result.title, { size: "sm", seed: result.id, square: result.type === "group", image: result.image })}<span><b>${esc(result.title)}</b><small>${esc(result.sub)}</small></span></button>`).join("") : `<div class="empty" style="padding:16px"><p>Sin resultados para “${esc(query)}”.</p></div>`;
  box.classList.remove("hidden");
}

/* ------------------------------------------------------------------ Emojis */
let emojiTarget = null;
function openEmoji(anchor, target) {
  emojiTarget = target;
  const picker = $("#emoji-picker");
  picker.innerHTML = EMOJIS.map((emoji) => `<button type="button" class="emoji-button" data-emoji="${emoji}">${emoji}</button>`).join("");
  const rect = anchor.getBoundingClientRect();
  picker.style.top = `${Math.min(window.innerHeight - 250, rect.bottom + 6) + window.scrollY}px`;
  picker.style.left = `${Math.max(8, Math.min(window.innerWidth - 330, rect.left - 140))}px`;
  picker.classList.remove("hidden");
}

function insertEmoji(emoji) {
  const target = emojiTarget || $("#composer-text");
  if (!target) return;
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? start;
  target.focus();
  target.setRangeText(emoji, start, end, "end");
  target.dispatchEvent(new Event("input", { bubbles: true }));
}

/* ------------------------------------------------------------------ Acciones */
let attachTarget = { owner: "composer", rowId: null };

function scanPosts(button, body = {}) {
  return startSync({ items: ["posts"], postsProfile: Boolean(body.postsProfile), postPageIds: body.postPageIds || [], postGroupIds: body.postGroupIds || [] }, button);
}

function newRow(date) { return { id: crypto.randomUUID(), runAt: localDateTimeValue(date), text: "", media: [] }; }

const actions = {
  "go-compose": (el) => {
    if (el.dataset.dest) state.composer.destination = el.dataset.dest;
    if (el.dataset.mode) state.composer.mode = el.dataset.mode;
    navigate("#/publicar");
    if (el.dataset.media) setTimeout(() => { attachTarget = { owner: "composer" }; $("#file-input").click(); }, 50);
  },
  "set-destination": (el) => { state.composer.destination = el.dataset.dest; storage.set("niro-destination", el.dataset.dest); renderView(); },
  "mark-published": (el) => run(el, null, async () => {
    await request(`/api/publications/${encodeURIComponent(el.dataset.id)}/status`, { method: "POST", body: JSON.stringify({ status: "published" }) });
    await refresh({ soft: false });
    toast("Marcada como publicada.");
  }),
  "ig-format": (el) => { state.composer.instagram.format = el.dataset.format; renderView(); },
  "go-accounts": () => navigate("#/datos"),
  "ig-discover": (el) => run(el, "Revisando…", async () => { await request("/api/instagram/discover", { method: "POST", body: "{}" }); toast("Revisando las cuentas de Instagram de tus páginas. Tarda unos minutos."); }),
  "ig-connect": (el) => run(el, "Abriendo…", async () => {
    const result = await request("/api/instagram/connect", { method: "POST", body: JSON.stringify({ pageId: el.dataset.page }) });
    if (state.status?.remoteView) remoteView.open({ title: "Vincular Instagram", hint: "Completá la vinculación en Business Suite. Al terminar tocá Listo y después “Revisar cuentas”." });
    else toast(result.message, { timeout: 12000 });
    await refresh();
  }),
  "set-mode": (el) => { state.composer.mode = el.dataset.mode; renderView(); },
  attach: (el) => { attachTarget = { owner: el.dataset.target, rowId: el.dataset.rowId || null }; $("#file-input").click(); },
  emoji: (el) => { const target = $(el.dataset.target); if (target) openEmoji(el, target); },
  "remove-media": (el) => {
    const c = state.composer;
    if (el.dataset.owner === "row") { const row = c.rows.find((item) => item.id === el.dataset.rowId); if (row) row.media = row.media.filter((item) => item.id !== el.dataset.media); }
    else c.media = c.media.filter((item) => item.id !== el.dataset.media);
    renderView();
  },
  "add-row": (el) => {
    const c = state.composer;
    const preset = el.dataset.preset;
    const untouched = c.rows.length === 1 && !c.rows[0].text && !c.rows[0].media.length;
    if (preset === "week") {
      if (untouched) c.rows = [];
      for (let day = 1; day <= 7; day += 1) { const date = new Date(); date.setDate(date.getDate() + day); date.setHours(9, 0, 0, 0); c.rows.push(newRow(date)); }
    } else if (preset === "tomorrow") {
      if (untouched) c.rows = [];
      const date = new Date(); date.setDate(date.getDate() + 1); date.setHours(9, 0, 0, 0);
      c.rows.push(newRow(date));
    } else {
      const last = c.rows.at(-1);
      c.rows.push(newRow(last ? new Date(Date.parse(last.runAt) + 60 * 60_000) : new Date(Date.now() + 10 * 60_000)));
    }
    renderView();
  },
  "remove-row": (el) => { state.composer.rows = state.composer.rows.filter((row) => row.id !== el.dataset.rowId); renderView(); },
  "select-visible": () => {
    const c = state.composer;
    $$("#targets-box input[data-target-id]").forEach((input) => (input.dataset.targetType === "group" ? c.groupIds : c.pageIds).add(input.dataset.targetId));
    renderTargets(); renderPreview();
  },
  "clear-targets": () => { const c = state.composer; c.groupIds.clear(); c.pageIds.clear(); c.includeProfile = false; c.includeStory = false; renderTargets(); renderPreview(); },
  "publish-now": (el) => publishNow(el),
  "save-schedule": (el) => saveSchedule(el),

  "select-event": (el) => { closeDropdown(); selectEvent(el.dataset.event); },
  "set-notif-filter": (el) => { state.notifFilter = el.dataset.filter; navigate("#/notificaciones"); },
  "toggle-read": async (el) => {
    const item = getEvent(el.dataset.event);
    if (!item) return;
    item.read = !item.read;
    renderChrome(); renderView();
    try { await request(`/api/events/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ read: item.read }) }); } catch (error) { toast(error.message, { error: true }); }
  },
  "mark-all-read": (el) => run(el, null, async () => {
    const result = await request("/api/events/read-all", { method: "POST", body: "{}" });
    state.events.forEach((item) => { item.read = true; });
    closeDropdown(); renderChrome(); renderView();
    toast(`${result.updated} aviso(s) marcados como leídos.`);
  }),
  "bell-filter": (el) => { state.bellFilter = el.dataset.filter; showDropdown("bell", $("#top-bell"), { force: true }); },
  "prepare-reply": async (el) => {
    const item = getEvent(el.dataset.event);
    const text = $("#reply-text")?.value.trim();
    if (!item) return;
    if (!text) { toast("Escribí una respuesta.", { error: true }); return; }
    await run(el, "Abriendo hilo…", async () => {
      await request("/api/reply/prepare", { method: "POST", body: JSON.stringify({ eventId: item.id, text }) });
      openModal({ kind: "reply", text, eventId: item.id, isMessenger: item.source === "messenger" });
    });
  },
  "use-draft": (el) => { const draft = $(`[data-draft-id="${CSS.escape(el.dataset.draft)}"]`); const reply = $("#reply-text"); if (draft && reply) { reply.value = draft.value; reply.focus(); } },
  "save-draft": (el) => {
    const textarea = $(`[data-draft-id="${CSS.escape(el.dataset.draft)}"]`);
    return run(el, null, async () => {
      await request(`/api/drafts/${encodeURIComponent(el.dataset.draft)}`, { method: "PATCH", body: JSON.stringify({ body: textarea.value, status: "reviewed" }) });
      await refresh({ soft: false });
      toast("Borrador guardado como revisado.");
    });
  },

  "select-chat": (el) => { state.selectedChatId = el.dataset.chat; renderView(); },
  "open-chat-view": (el) => { state.selectedChatId = el.dataset.chat; closeDropdown(); navigate("#/messenger"); },
  "chat-reply": async (el) => {
    const chat = state.chats.find((item) => item.id === el.dataset.chat);
    const linked = chat && chatEvent(chat);
    const text = $("#chat-reply")?.value.trim();
    if (!linked) return;
    if (!text) { toast("Escribí un mensaje.", { error: true }); return; }
    await run(el, null, async () => {
      await request("/api/reply/prepare", { method: "POST", body: JSON.stringify({ eventId: linked.id, text }) });
      openModal({ kind: "reply", text, eventId: linked.id, isMessenger: true, targets: [{ name: chatName(chat) }] });
    });
  },
  "sync-chat": (el) => run(el, "Sincronizando…", async () => {
    const result = await request(`/api/chats/${encodeURIComponent(el.dataset.chat)}/sync`, { method: "POST", body: "{}" });
    state.chatMessages.delete(el.dataset.chat);
    await refresh({ soft: false });
    toast(`${result.messageCount} mensaje(s) guardados.`, { title: chatName(result.chat) });
  }),
  "sync-chats": (el) => startSync({ items: ["chats", "chatHistory"] }, el),

  "open-url": (el) => run(null, null, async () => { await request("/api/browser/open-url", { method: "POST", body: JSON.stringify({ url: el.dataset.url }) }); toast("Abierto en el perfil conectado de Facebook."); }),
  "open-browser": (el) => run(el, "Conectando…", async () => { closeDropdown(); await request("/api/browser/open", { method: "POST", body: "{}" }); await refresh(); if (state.status?.remoteView) remoteView.open(); else toast("Perfil de Facebook abierto. Iniciá sesión si lo solicita."); }),
  "remote-view": (el) => run(el, "Abriendo…", async () => { closeDropdown(); await request("/api/browser/open", { method: "POST", body: "{}" }); remoteView.open(); }),
  "close-browser": (el) => run(el, null, async () => { closeDropdown(); await request("/api/browser/close", { method: "POST", body: "{}" }); await refresh(); toast("Navegador cerrado. Monitoreo y automatización detenidos."); }),
  "scan-now": (el) => run(el, "Actualizando…", async () => { const result = await request("/api/scan", { method: "POST", body: "{}" }); await refresh(); toast(`${result.newCount} aviso(s) nuevo(s).`, { title: "Bandeja actualizada" }); }),
  "sync-all": () => { closeDropdown(); navigate("#/datos"); },
  "sync-run": (el) => startSync({}, el),
  "sync-only": (el, event) => { event?.preventDefault(); startSync({ items: [el.dataset.item] }, el); },
  "sync-cancel": (el) => run(el, "Deteniendo…", async () => {
    await request("/api/sync/cancel", { method: "POST", body: "{}" });
    if (state.sync?.state) state.sync.state.cancelRequested = true;
    updateSyncViews();
    toast("Deteniendo la sincronización. Lo ya descargado queda guardado.");
  }),
  "sync-pages-all": () => saveSyncSettings({ postPageIds: state.pages.map((page) => page.id) }),
  "sync-pages-none": () => saveSyncSettings({ postPageIds: [] }),
  "scan-profile": (el) => run(el, "Leyendo…", async () => { await request("/api/profile/scan", { method: "POST", body: "{}" }); await refresh(); toast("Perfil actualizado."); }),
  "scan-groups": (el) => run(el, "Leyendo grupos…", async () => { const result = await request("/api/groups/scan", { method: "POST", body: "{}" }); await refresh(); toast(`${result.groups.length} grupo(s) encontrados.`); }),
  "scan-pages": (el) => run(el, "Leyendo páginas…", async () => { const result = await request("/api/pages/scan", { method: "POST", body: "{}" }); await refresh(); toast(`${result.pages.length} página(s) encontradas.`); }),
  "scan-posts": (el) => startSync({ items: ["posts"] }, el),
  demo: (el) => run(el, null, async () => { const result = await request("/api/demo", { method: "POST", body: "{}" }); await refresh(); toast(`${result.newCount} ejemplo(s) cargados.`); }),
  "load-db": () => { state.db = null; renderView(); },

  "toggle-monitor": (el) => run(el, null, async () => {
    const enabled = state.status?.monitor?.enabled;
    await request(enabled ? "/api/monitor/stop" : "/api/monitor/start", { method: "POST", body: "{}" });
    await refresh();
    toast(enabled ? "Monitoreo pausado." : "Monitoreo activado: los avisos nuevos llegarán en tiempo real.");
  }),
  "toggle-scheduler": (el) => run(el, null, async () => {
    const enabled = state.status?.scheduler?.enabled;
    await request(enabled ? "/api/scheduler/stop" : "/api/scheduler/start", { method: "POST", body: "{}" });
    await refresh();
    toast(enabled ? "Publicaciones automáticas pausadas." : "Publicaciones automáticas activadas.");
  }),

  "cal-prev": () => { state.calMonth.setMonth(state.calMonth.getMonth() - 1); renderView(); },
  "cal-next": () => { state.calMonth.setMonth(state.calMonth.getMonth() + 1); renderView(); },
  "cal-today": () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); state.calMonth = d; renderView(); },
  "cal-day": (el) => {
    const date = new Date(el.dataset.date);
    date.setHours(9, 0, 0, 0);
    if (date < new Date()) date.setTime(Date.now() + 10 * 60_000);
    const c = state.composer;
    c.mode = "schedule";
    c.rows = [newRow(date)];
    navigate("#/publicar");
  },
  "prepare-job": (el) => {
    const schedule = state.schedules.find((item) => item.id === el.dataset.schedule);
    const job = schedule?.jobs?.find((item) => item.id === el.dataset.job);
    if (!schedule || !job) { toast("No encontré esa publicación en la cola.", { error: true }); return null; }
    return run(el, null, async () => {
      await request(`/api/schedules/${encodeURIComponent(schedule.id)}/prepare`, { method: "POST", body: JSON.stringify({ jobId: job.id }) });
      openModal({ kind: "schedule", text: job.text || schedule.text, scheduleId: schedule.id, jobId: job.id, targets: [job.target] });
      toast(`Preparado para ${cleanGroupName(job.target?.name || "")}. Revisá la confirmación.`);
    });
  },
  "run-schedule": (el) => {
    const schedule = state.schedules.find((item) => item.id === el.dataset.schedule);
    if (!schedule) return;
    if (!confirmPublishing()) {
      run(el, "Iniciando…", async () => {
        await request(`/api/schedules/${encodeURIComponent(schedule.id)}/run`, { method: "POST", body: "{}" });
        await refresh({ soft: false });
        toast("Publicando los pendientes uno por uno.", { title: "Programación" });
      });
      return;
    }
    openModal({ kind: "run-schedule", scheduleId: schedule.id, targets: (schedule.jobs || []).filter((job) => job.status === "queued").map((job) => job.target), text: schedule.text });
  },
  "toggle-schedule": (el) => run(el, null, async () => {
    await request(`/api/schedules/${encodeURIComponent(el.dataset.schedule)}`, { method: "PATCH", body: JSON.stringify({ status: el.dataset.next }) });
    await refresh({ soft: false });
    toast(el.dataset.next === "paused" ? "Programación pausada." : "Programación reanudada.");
  }),
  "retry-schedule": (el) => run(el, null, async () => {
    await request(`/api/schedules/${encodeURIComponent(el.dataset.schedule)}`, { method: "PATCH", body: JSON.stringify({ retryFailed: true }) });
    await refresh({ soft: false });
    toast("Publicaciones fallidas listas para reintentar.");
  }),
  "delete-schedule": async (el) => {
    const confirmed = await dialogs.confirm({ title: "¿Quitar esta programación?", message: "Se quitan también todas sus publicaciones pendientes. Lo que ya se publicó no se toca.", confirmLabel: "Quitar programación", tone: "danger" });
    if (!confirmed) return null;
    return run(el, null, async () => {
      await request(`/api/schedules/${encodeURIComponent(el.dataset.schedule)}`, { method: "DELETE" });
      await refresh({ soft: false });
      toast("Programación quitada.");
    });
  },

  "posts-tab": (el) => { state.postsTab = el.dataset.tab; renderView(); },

  "groups-more": () => { state.groupLimit += 60; renderView(); },
  "groups-select-visible": () => { const q = state.groupSearch.toLowerCase(); state.groups.filter((group) => !q || group.name.toLowerCase().includes(q)).slice(0, state.groupLimit).forEach((group) => state.selectedGroupIds.add(group.id)); renderView(); },
  "groups-clear": () => { state.selectedGroupIds.clear(); renderView(); },
  "groups-publish": () => { const c = state.composer; c.destination = "groups"; c.groupIds = new Set(state.selectedGroupIds); c.mode = "now"; navigate("#/publicar"); },
  "groups-posts": (el) => scanPosts(el, { postGroupIds: [...state.selectedGroupIds].slice(0, 50) }),
  "pages-select-visible": () => { const q = state.pageSearch.toLowerCase(); state.pages.filter((page) => !q || page.name.toLowerCase().includes(q)).forEach((page) => state.selectedPageIds.add(page.id)); renderView(); },
  "pages-publish": () => { const c = state.composer; c.destination = "pages"; c.pageIds = new Set(state.selectedPageIds); c.mode = "now"; navigate("#/publicar"); },
  "pages-posts": (el) => scanPosts(el, { postPageIds: state.selectedPageIds.size ? [...state.selectedPageIds] : state.pages.map((page) => page.id) }),
  "compose-to": (el) => {
    const c = state.composer;
    if (el.dataset.type === "group") { c.destination = "groups"; c.groupIds = new Set([el.dataset.id]); }
    else { c.destination = "pages"; c.pageIds = new Set([el.dataset.id]); }
    c.mode = "now";
    navigate("#/publicar");
  },

  "browser-mode": (el) => run(el, "Cambiando…", async () => {
    const headless = el.dataset.headless === "true";
    await request("/api/browser/mode", { method: "PATCH", body: JSON.stringify({ headless }) });
    if (state.status?.remoteView) { if (!headless) remoteView.open(); return; }
    await refresh({ soft: false });
    toast(headless ? "Chrome trabaja en segundo plano, sin ventana." : "Chrome se muestra en pantalla. Cuando termines de iniciar sesión, volvé a segundo plano.");
  }),
  logout: async () => { await request("/api/logout", { method: "POST", body: "{}" }).catch(() => {}); location.href = `${BASE}/login.html`; },
  "toggle-theme": () => {
    const current = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("niro-theme", next); } catch { /* sin almacenamiento */ }
    closeDropdown();
  },
  "enable-desktop": async () => {
    if (!("Notification" in window)) { toast("Este navegador no admite avisos de escritorio.", { error: true }); return; }
    const permission = await Notification.requestPermission();
    closeDropdown();
    toast(permission === "granted" ? "Avisos de escritorio activados." : "El navegador no permitió los avisos de escritorio.", { error: permission !== "granted" });
  },
};

document.addEventListener("click", (event) => {
  if (event.target.closest("[data-emoji]")) { insertEmoji(event.target.closest("[data-emoji]").dataset.emoji); $("#emoji-picker").classList.add("hidden"); return; }
  const actionEl = event.target.closest("[data-action]");
  if (actionEl && !actionEl.disabled && actions[actionEl.dataset.action]) {
    if (actionEl.tagName === "A") event.preventDefault();
    actions[actionEl.dataset.action](actionEl, event);
  }
  const searchResult = event.target.closest("[data-search-type]");
  if (searchResult) {
    const { searchType, searchId } = searchResult.dataset;
    $("#search-results").classList.add("hidden");
    $("#global-search").value = "";
    if (searchType === "group") { state.groupSearch = cleanGroupName(state.groups.find((group) => group.id === searchId)?.name || "").slice(0, 60); navigate("#/grupos"); }
    else if (searchType === "page") { state.pageSearch = state.pages.find((page) => page.id === searchId)?.name || ""; navigate("#/paginas"); }
    else if (searchType === "chat") { state.selectedChatId = searchId; navigate("#/messenger"); }
    else if (searchType === "event") selectEvent(searchId);
  }
  if (!event.target.closest("#emoji-picker, [data-action='emoji']")) $("#emoji-picker").classList.add("hidden");
  if (!event.target.closest("#dropdown, .top-right")) closeDropdown();
  if (!event.target.closest(".search")) $("#search-results").classList.add("hidden");
});

function rerenderKeepingFocus(id) {
  const field = $(`#${id}`);
  const position = field?.selectionStart ?? null;
  renderView();
  const next = $(`#${id}`);
  if (next) { next.focus(); if (position != null) next.setSelectionRange(position, position); }
}

document.addEventListener("input", (event) => {
  const target = event.target;
  const c = state.composer;
  if (target.id === "ig-caption") {
    c.instagram.caption = target.value;
    renderPreview();
  } else if (target.id === "composer-text") {
    c.text = target.value;
    storage.set("niro-composer-text", c.text);
    $("#char-count").textContent = `${c.text.length}/5000`;
    renderPreview();
  } else if (target.id === "target-search") {
    c.targetSearch = target.value;
    const position = target.selectionStart;
    renderTargets();
    const field = $("#target-search"); field.focus(); field.setSelectionRange(position, position);
  } else if (target.dataset.rowField) {
    const row = c.rows.find((item) => item.id === target.closest("[data-row]")?.dataset.row);
    if (row) row[target.dataset.rowField] = target.value;
    updateComposerHints();
  } else if (target.id === "group-search") { state.groupSearch = target.value; state.groupLimit = 60; rerenderKeepingFocus("group-search"); }
  else if (target.id === "page-search") { state.pageSearch = target.value; rerenderKeepingFocus("page-search"); }
  else if (target.id === "chat-search") { state.chatSearch = target.value; rerenderKeepingFocus("chat-search"); }
  else if (target.id === "global-search") renderSearch(target.value);
  else if (target.id === "sync-group-search") {
    state.syncGroupSearch = target.value;
    const position = target.selectionStart;
    const panel = $("#sync-panel");
    if (panel) panel.innerHTML = renderSyncPanel();
    const field = $("#sync-group-search"); if (field) { field.focus(); field.setSelectionRange(position, position); }
  }
});

document.addEventListener("change", async (event) => {
  const target = event.target;
  const c = state.composer;
  if (target.dataset.syncSetting) {
    saveSyncSettings({ [target.dataset.syncSetting]: target.checked });
    return;
  }
  if (target.dataset.syncPage || target.dataset.syncGroup) {
    const key = target.dataset.syncPage ? "postPageIds" : "postGroupIds";
    const id = target.dataset.syncPage || target.dataset.syncGroup;
    const ids = new Set(state.sync.settings[key]);
    ids[target.checked ? "add" : "delete"](id);
    if (key === "postGroupIds" && ids.size > 50) { target.checked = false; toast("Máximo 50 grupos.", { error: true }); return; }
    saveSyncSettings({ [key]: [...ids] });
    return;
  }
  if (target.dataset.targetType) {
    const { targetType, targetId } = target.dataset;
    if (targetType === "instagram") { c.instagram.ids[target.checked ? "add" : "delete"](targetId); renderTargets(); renderPreview(); return; }
    if (targetType === "profile") c.includeProfile = target.checked;
    else if (targetType === "story") c.includeStory = target.checked;
    else (targetType === "group" ? c.groupIds : c.pageIds)[target.checked ? "add" : "delete"](targetId);
    renderTargets();
    renderPreview();
  } else if (target.id === "spacing") c.spacing = Number(target.value);
  else if (target.id === "confirm-publish") { storage.set("niro-confirm-publish", target.checked); updateComposerHints(); }
  else if (target.id === "schedule-auto") { c.auto = target.checked; storage.set("niro-schedule-auto", target.checked); }
  else if (target.dataset.selectGroup) { state.selectedGroupIds[target.checked ? "add" : "delete"](target.dataset.selectGroup); renderView(); }
  else if (target.dataset.selectPage) { state.selectedPageIds[target.checked ? "add" : "delete"](target.dataset.selectPage); renderView(); }
  else if (target.id === "posts-owner") { state.postsOwner = target.value; renderView(); }
  else if (target.id === "file-input") {
    const files = Array.from(target.files || []);
    target.value = "";
    if (!files.length) return;
    await run(null, null, async () => {
      const uploaded = await uploadMediaFiles(files);
      if (attachTarget.owner === "row") { const row = c.rows.find((item) => item.id === attachTarget.rowId); if (row) row.media.push(...uploaded); }
      else c.media.push(...uploaded);
      if (state.route === "publicar") renderView();
      if (uploaded.length) toast(`${uploaded.length} adjunto(s) listo(s).`);
    });
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!$("#modal").classList.contains("hidden")) closeModal();
    closeDropdown();
    $("#emoji-picker").classList.add("hidden");
    $("#search-results").classList.add("hidden");
  }
  if (event.key === "Enter" && !event.shiftKey && event.target.id === "chat-reply") {
    event.preventDefault();
    $("[data-action='chat-reply']")?.click();
  }
});

$("#top-bell").addEventListener("click", (event) => { event.stopPropagation(); showDropdown("bell", event.currentTarget); });
$("#top-messenger").addEventListener("click", (event) => { event.stopPropagation(); showDropdown("messenger", event.currentTarget); });
$("#top-avatar").addEventListener("click", (event) => { event.stopPropagation(); showDropdown("account", null); });
$("#top-create").addEventListener("click", () => navigate("#/publicar"));
$("#modal-cancel").addEventListener("click", () => closeModal());
$("#modal-x").addEventListener("click", () => closeModal());
$("#modal-confirm").addEventListener("click", confirmModal);
$("#modal").addEventListener("click", (event) => { if (event.target.id === "modal") closeModal(); });
window.addEventListener("hashchange", onRoute);

/* ------------------------------------------------------------------ Respuestas con IA */
const AI_CATEGORY_LABELS = {
  product_question: "Pregunta de producto", price: "Consulta de precio", purchase_intent: "Interés de compra", complaint: "Reclamo",
  rude: "Grosero", off_topic: "Ajeno al tema", spam: "Spam", opinion: "Opinión", greeting: "Saludo", other: "Otro",
};
const AI_STATUS_META = {
  queued: ["En cola", ""], processing: ["Analizando", "blue"], pending: ["Pendiente", "orange"], approved: ["Aprobada · enviando", "blue"], sending: ["Enviando", "blue"],
  sent: ["Enviada", "green"], ignored: ["Ignorada", ""], derived: ["Derivada", "violet"], notified: ["Notificada", ""], error: ["Error", "red"],
};
const AI_MODE_LABELS = { inherit: "Heredar", automatic: "Automático", supervised: "Supervisado", notify: "Solo notificar", off: "Apagado" };
const PROMPT_FIELDS = [
  ["topic", "Tema", "producto, servicio, soporte, opinión…"],
  ["offer", "Qué se ofrece o comunica", ""],
  ["facts", "Datos autorizados para responder", "precios, condiciones, horarios, stock…"],
  ["faq", "Preguntas frecuentes", "P: … R: …"],
  ["tone", "Tono de la respuesta", "amable, formal, cercano…"],
  ["contact", "Enlace o contacto que puede compartir", "WhatsApp, web, correo"],
  ["escalate", "Derivar a una persona cuando…", "pide cotización, reclamo, factura…"],
  ["instructions", "Instrucciones adicionales", ""],
];

state.ai = { settings: null, stats: null, prompts: [], departments: [], interactions: [], leads: [], audit: [], tab: "bandeja", status: "pending", category: "", channel: "", test: null, editingPrompt: null, openAudit: null };

async function loadAi({ render = true } = {}) {
  const [aiState, list] = await Promise.all([
    request("/api/ai/state"),
    request(`/api/ai/interactions?${new URLSearchParams(Object.entries({ status: state.ai.status, category: state.ai.category, channel: state.ai.channel }).filter(([, value]) => value))}`),
  ]);
  Object.assign(state.ai, { settings: aiState.settings, stats: aiState.stats, prompts: aiState.prompts, departments: aiState.departments, interactions: list.interactions });
  if (state.ai.tab === "prospectos") state.ai.leads = (await request("/api/ai/leads")).leads;
  if (state.ai.tab === "historial") state.ai.audit = (await request("/api/ai/audit")).audit;
  if (render && state.route === "respuestas" && !isTyping()) renderView();
}

function accountOptions() {
  return [
    { key: `profile:${state.profile?.id || "me"}`, name: profileName(), type: "profile", image: state.profile?.avatarUrl },
    ...state.pages.map((page) => ({ key: `page:${page.id}`, name: page.name, type: "page", image: page.avatarUrl })),
  ];
}

function renderAi() {
  const ai = state.ai;
  if (!ai.settings) {
    $("#view").innerHTML = `<div class="card empty"><span class="empty-icon">${icon("sparkles")}</span><strong>Cargando respuestas con IA…</strong></div>`;
    loadAi().catch((error) => toast(error.message, { error: true }));
    return;
  }
  const settings = ai.settings;
  const counts = ai.stats?.counts || {};
  const tabs = [["bandeja", "inbox", "Bandeja"], ["publicaciones", "layers", "Por publicación"], ["instrucciones", "file", "Instrucciones"], ["configuracion", "zap", "Configuración"], ["prospectos", "users", "Prospectos"], ["historial", "clock", "Historial"], ["probar", "sparkles", "Probar"]];
  $("#view").innerHTML = `
    <div class="page-title"><div><span class="eyebrow">Autopost</span><h1>Respuestas con IA</h1><p>Niro clasifica cada comentario y mensaje, redacta la respuesta con el contexto de la publicación y la envía, la deja para aprobar o la deriva a una persona.</p></div>
      <div class="actions">${ai.stats?.apiConfigured ? '<span class="tag green">API de Niro conectada</span>' : '<span class="tag red">Falta NIRO_AI_API_KEY</span>'}</div></div>
    <section class="card card-pad ai-control">
      <div class="automation"><span class="kpi-icon bg-violet">${icon("sparkles")}</span><div class="grow"><strong>Activar respuestas con IA</strong><small>${settings.enabled ? "El módulo procesa las interacciones nuevas." : "Apagado: no se procesa ninguna interacción."}</small></div><button class="switch ${settings.enabled ? "on" : ""}" data-action="ai-toggle" aria-pressed="${settings.enabled}" aria-label="Activar respuestas con IA"></button></div>
      <div class="segmented ai-modes">${["automatic", "supervised", "notify"].map((mode) => `<button class="${settings.mode === mode ? "active" : ""}" data-action="ai-mode" data-mode="${mode}">${icon({ automatic: "zap", supervised: "eye", notify: "bell" }[mode], "sm")} ${AI_MODE_LABELS[mode]}</button>`).join("")}</div>
      <button class="btn ${settings.emergencyStop ? "success" : "danger"}" data-action="ai-emergency">${icon(settings.emergencyStop ? "play" : "pause", "sm")} ${settings.emergencyStop ? "Reanudar envíos automáticos" : "Parada de emergencia"}</button>
    </section>
    ${settings.emergencyStop ? `<section class="card card-pad" style="border-color:var(--red);background:var(--red-soft)"><strong>Parada de emergencia activa.</strong> Niro sigue recibiendo y redactando, pero nada se envía solo: todo queda pendiente de aprobación.</section>` : ""}
    <section class="kpis">
      ${kpi("clock", "bg-orange", counts.pending || 0, "Pendientes de aprobar", "#/respuestas")}
      ${kpi("send", "bg-green", counts.sent || 0, "Enviadas", "#/respuestas")}
      ${kpi("users", "bg-violet", counts.derived || 0, "Derivadas", "#/respuestas")}
      ${kpi("x", "bg-blue", (counts.ignored || 0) + (counts.notified || 0), "Ignoradas / notificadas", "#/respuestas")}
      ${kpi("alert", "bg-red", counts.error || 0, "Con error", "#/respuestas")}
    </section>
    <div class="segmented">${tabs.map(([key, iconName, label]) => `<button class="${ai.tab === key ? "active" : ""}" data-action="ai-tab" data-tab="${key}">${icon(iconName, "sm")} ${label}</button>`).join("")}</div>
    ${{ bandeja: aiInbox, publicaciones: aiByPost, instrucciones: aiPrompts, configuracion: aiSettings, prospectos: aiLeads, historial: aiAudit, probar: aiTest }[ai.tab]()}`;
}

function aiInbox() {
  const ai = state.ai;
  const counts = ai.stats?.counts || {};
  const statuses = [["pending", "Pendientes"], ["approved", "Enviando"], ["sent", "Enviadas"], ["derived", "Derivadas"], ["queued", "En cola"], ["ignored", "Ignoradas"], ["notified", "Notificadas"], ["error", "Errores"], ["", "Todas"]];
  return `<div class="toolbar">
      <div class="pills">${statuses.map(([key, label]) => `<button class="pill ${ai.status === key ? "active" : ""}" data-action="ai-filter" data-status="${key}">${label}<span class="n">${key ? counts[key] || 0 : Object.values(counts).reduce((a, b) => a + b, 0)}</span></button>`).join("")}</div>
      <select id="ai-category" class="btn ghost sm"><option value="">Todas las categorías</option>${Object.entries(AI_CATEGORY_LABELS).map(([key, label]) => `<option value="${key}" ${ai.category === key ? "selected" : ""}>${label}</option>`).join("")}</select>
      <select id="ai-channel" class="btn ghost sm"><option value="">Todos los canales</option><option value="comment" ${ai.channel === "comment" ? "selected" : ""}>Comentarios</option><option value="mention" ${ai.channel === "mention" ? "selected" : ""}>Menciones</option><option value="messenger" ${ai.channel === "messenger" ? "selected" : ""}>Messenger</option></select>
    </div>
    ${ai.interactions.length ? ai.interactions.map(aiCard).join("") : `<section class="card">${emptyState("inbox", "No hay interacciones en esta vista", ai.settings.enabled ? "Las nuevas llegan automáticamente cuando se actualizan los avisos o corre el monitoreo." : "Activá el módulo arriba para empezar a recibir interacciones.")}</section>`}`;
}

function aiCard(item) {
  const [statusLabel, statusTone] = AI_STATUS_META[item.status] || [item.status, ""];
  const editable = ["pending", "error", "derived", "notified", "ignored", "queued"].includes(item.status);
  const takeover = state.ai.settings.takeovers?.[item.threadKey];
  const channel = { comment: "Comentario", mention: "Mención", messenger: "Messenger" }[item.channel] || item.channel;
  return `<article class="card ai-card" data-ai="${esc(item.id)}">
    <div class="ai-card-head">${avatar(item.person?.name || "?", { size: "lg", seed: item.person?.name || item.id, image: item.person?.avatarUrl })}
      <div class="grow"><strong>${esc(item.person?.name || "Persona")}</strong><div class="actions" style="gap:6px;margin-top:4px"><span class="tag blue">${esc(channel)}</span>${item.category ? `<span class="tag violet">${esc(AI_CATEGORY_LABELS[item.category] || item.category)}${item.confidence != null ? ` · ${Math.round(item.confidence * 100)}%` : ""}</span>` : ""}<span class="tag ${statusTone}">${esc(statusLabel)}</span>${item.account ? `<span class="tag">${esc(item.account.name)}</span>` : ""}${item.mode ? `<span class="tag">${esc(AI_MODE_LABELS[item.mode] || item.mode)}</span>` : ""}${takeover ? `<span class="tag orange">Hilo tomado por ${esc(takeover.agent)}</span>` : ""}</div></div>
      <span class="time">${timeAgo(item.createdAt)}</span></div>
    ${item.post?.text ? `<div class="ai-post"><span class="eyebrow">Publicación</span><p>${esc(item.post.text.slice(0, 280))}${item.post.text.length > 280 ? "…" : ""}</p>${item.publication ? `<small>Asociada a ${item.publication.kind === "niro" ? "una publicación de Niro" : "una publicación descargada"} (${Math.round(item.publication.score * 100)}%)${item.publication.campaign ? ` · campaña ${esc(item.publication.campaign)}` : ""}</small>` : ""}</div>` : ""}
    <div class="ai-comment"><span class="eyebrow">${item.channel === "messenger" ? "Mensaje" : "Comentario"}</span><p>${esc(item.text || item.notificationText || "")}</p></div>
    ${item.suggestion || editable ? `<div class="ai-reply"><span class="eyebrow">${item.status === "sent" ? `Enviado${item.voice ? ` como ${esc(item.voice)}` : ""}` : "Respuesta sugerida por Niro"}${item.edited ? " · editada" : ""}</span>
      ${item.status === "sent" ? `<p>${esc(item.sentText || item.finalReply)}</p>` : `<textarea data-ai-reply="${esc(item.id)}" maxlength="2000" placeholder="${item.status === "queued" ? "Niro todavía no redactó la respuesta…" : "Escribí la respuesta…"}">${esc(item.finalReply || item.suggestion || "")}</textarea>`}</div>` : ""}
    ${item.reason || item.error || item.assignment ? `<div class="ai-reason">${item.error ? `<span style="color:var(--red)">${icon("alert", "xs")} ${esc(item.error)}</span>` : ""}${item.reason ? `<span>${icon("eye", "xs")} ${esc(item.reason)}</span>` : ""}${item.assignment ? `<span>${icon("users", "xs")} Derivada a ${esc(item.assignment.departmentName || "agentes")}${item.assignment.agent ? ` · ${esc(item.assignment.agent)}` : ""}: ${esc(item.assignment.reason || "")}</span>` : ""}${item.promptVersions?.length ? `<span>${icon("file", "xs")} Instrucciones: ${item.promptVersions.map((layer) => `${esc(layer.name)} v${layer.version}`).join(" · ")}</span>` : ""}</div>` : ""}
    <div class="actions">
      ${["pending", "error", "derived", "notified", "ignored"].includes(item.status) ? `<button class="btn primary sm" data-action="ai-act" data-op="approve" data-id="${esc(item.id)}">${icon("send", "sm")} Aprobar y enviar</button>` : ""}
      ${editable && item.status !== "queued" ? `<button class="btn soft sm" data-action="ai-act" data-op="edit" data-id="${esc(item.id)}">Guardar edición</button>` : ""}
      ${!["sent", "sending", "approved"].includes(item.status) ? `<button class="btn ghost sm" data-action="ai-act" data-op="regenerate" data-id="${esc(item.id)}">${icon("refresh", "sm")} Regenerar</button>` : ""}
      ${!["sent", "derived"].includes(item.status) ? `<button class="btn ghost sm" data-action="ai-act" data-op="derive" data-id="${esc(item.id)}">${icon("users", "sm")} Derivar</button>` : ""}
      ${!["sent", "ignored"].includes(item.status) ? `<button class="btn ghost sm" data-action="ai-act" data-op="ignore" data-id="${esc(item.id)}">${icon("x", "sm")} Ignorar</button>` : ""}
      <button class="btn ghost sm" data-action="ai-act" data-op="${takeover ? "release" : "takeover"}" data-id="${esc(item.id)}">${icon(takeover ? "play" : "pause", "sm")} ${takeover ? "Devolver hilo a la IA" : "Tomar el hilo"}</button>
      <button class="btn ghost sm" data-action="open-url" data-url="${esc(item.url)}">${icon("external", "sm")} Abrir</button>
      <button class="link-btn" data-action="ai-audit-toggle" data-id="${esc(item.id)}">Historial</button>
    </div>
    ${state.ai.openAudit === item.id ? `<div class="ai-audit">${(state.ai.auditFor || []).map((entry) => `<div><span class="time">${when(entry.at)}</span> <b>${esc(entry.action)}</b> · ${esc(entry.actor)} — ${esc(entry.details)}</div>`).join("") || "Sin movimientos."}</div>` : ""}
  </article>`;
}

function aiByPost() {
  const rows = state.ai.stats?.byPost || [];
  return `<section class="card"><div class="card-body">${rows.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Publicación</th><th>Cuenta</th><th>Recibidas</th><th>Automáticas</th><th>Aprobadas</th><th>Derivadas</th><th>Ignoradas</th><th>Pendientes</th></tr></thead><tbody>${rows.map((row) => `<tr><td class="text"><span class="clamp">${esc(row.text || row.url || "")}</span></td><td>${esc(row.account || "")}</td><td class="mono">${row.total}</td><td class="mono">${row.automatic}</td><td class="mono">${row.approved}</td><td class="mono">${row.derived}</td><td class="mono">${row.ignored}</td><td class="mono">${row.pending}</td></tr>`).join("")}</tbody></table></div>` : emptyState("layers", "Sin datos todavía", "Cuando lleguen interacciones vas a ver el resumen por publicación.")}</div></section>`;
}

function promptForm(prompt, { scope, scopeId = "", scopeName = "" } = {}) {
  const fields = prompt?.fields || {};
  return `<form class="prompt-form" data-prompt-form data-scope="${esc(prompt?.scope || scope)}" data-scope-id="${esc(prompt?.scopeId || scopeId)}" data-scope-name="${esc(prompt?.scopeName || scopeName)}">
    ${(prompt?.scope || scope) === "campaign" && !prompt ? `<label class="field">Nombre de la campaña<input name="scopeName" required placeholder="Ej: Niro Bot" /></label>` : ""}
    ${(prompt?.scope || scope) === "account" && !prompt ? `<label class="field">Cuenta<select name="account">${accountOptions().map((account) => `<option value="${esc(account.key)}" data-name="${esc(account.name)}">${esc(account.name)}</option>`).join("")}</select></label>` : ""}
    <div class="prompt-grid">${PROMPT_FIELDS.map(([key, label, placeholder]) => `<label class="field">${label}<textarea name="${key}" placeholder="${esc(placeholder)}">${esc(fields[key] || "")}</textarea></label>`).join("")}</div>
    <div class="actions"><label class="field" style="min-width:200px">Modo para esta capa<select name="mode">${Object.entries(AI_MODE_LABELS).map(([key, label]) => `<option value="${key}" ${(prompt?.mode || "inherit") === key ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <span style="flex:1"></span>${prompt ? `<button type="button" class="btn danger sm" data-action="ai-prompt-delete" data-id="${esc(prompt.id)}">${icon("trash", "sm")} Quitar</button>` : ""}<button type="submit" class="btn primary sm">${icon("check", "sm")} Guardar${prompt ? ` (v${prompt.version + 1})` : ""}</button></div>
  </form>`;
}

function aiPrompts() {
  const prompts = state.ai.prompts;
  const general = prompts.find((prompt) => prompt.scope === "general");
  const groups = [["account", "Por cuenta"], ["campaign", "Por campaña"], ["publication", "Por publicación"]];
  return `<section class="card"><div class="card-head"><div><h3>Prioridad de instrucciones</h3><span class="sub">Publicación → campaña → cuenta → general. Niro recibe todas las capas y la más específica manda.</span></div></div>
      <div class="card-body"><details class="prompt-block" open><summary><b>General</b>${general ? ` <span class="tag">v${general.version}</span>` : ' <span class="tag orange">Sin configurar</span>'}</summary>${promptForm(general, { scope: "general", scopeId: "general", scopeName: "General" })}</details></div></section>
    ${groups.map(([scope, title]) => {
      const items = prompts.filter((prompt) => prompt.scope === scope);
      return `<section class="card"><div class="card-head"><h3>${title}</h3>${scope !== "publication" ? `<button class="btn soft sm" data-action="ai-prompt-new" data-scope="${scope}">${icon("plus", "sm")} Nueva</button>` : '<span class="sub">Se crean desde “Crear publicación”.</span>'}</div>
        <div class="card-body">${state.ai.editingPrompt === `new:${scope}` ? `<details class="prompt-block" open><summary><b>Nueva instrucción</b></summary>${promptForm(null, { scope })}</details>` : ""}
        ${items.map((prompt) => `<details class="prompt-block"><summary><b>${esc(prompt.scopeName)}</b> <span class="tag">v${prompt.version}</span> <span class="tag">${esc(AI_MODE_LABELS[prompt.mode] || prompt.mode)}</span> <span class="time">${timeAgo(prompt.updatedAt)}</span></summary>${promptForm(prompt)}</details>`).join("") || (state.ai.editingPrompt === `new:${scope}` ? "" : '<p style="color:var(--muted);font-size:13px">No hay instrucciones en este nivel.</p>')}</div></section>`;
    }).join("")}`;
}

function aiSettings() {
  const settings = state.ai.settings;
  const accounts = accountOptions();
  return `<section class="card"><div class="card-head"><h3>Canales</h3></div><div class="card-body actions">
      ${[["comments", "Comentarios en publicaciones"], ["mentions", "Menciones"], ["messenger", "Mensajes de Messenger"]].map(([key, label]) => `<label class="check-chip"><input type="checkbox" data-ai-channel="${key}" ${settings.channels[key] ? "checked" : ""} /> ${label}</label>`).join("")}
    </div></section>
    <section class="card"><div class="card-head"><div><h3>Modo por cuenta</h3><span class="sub">“Heredar” usa el modo general (${AI_MODE_LABELS[settings.mode]}).</span></div></div><div class="card-body"><div class="rows">
      ${accounts.map((account) => `<div class="row">${avatar(account.name, { size: "sm", image: account.image })}<span class="grow"><span class="title">${esc(account.name)}</span><span class="sub">${account.type === "page" ? "Página" : "Perfil"}</span></span><select class="btn ghost sm" data-ai-account="${esc(account.key)}">${Object.entries(AI_MODE_LABELS).map(([key, label]) => `<option value="${key}" ${(settings.accounts[account.key] || "inherit") === key ? "selected" : ""}>${label}</option>`).join("")}</select></div>`).join("")}
    </div></div></section>
    <section class="card"><div class="card-head"><h3>Comportamiento y límites</h3></div><div class="card-body prompt-grid">
      <label class="field">Responder como<select data-ai-setting="voice"><option value="owner" ${settings.voice === "owner" ? "selected" : ""}>La página dueña de la publicación</option><option value="profile" ${settings.voice === "profile" ? "selected" : ""}>Mi perfil personal</option></select></label>
      <label class="field">Preguntas ajenas al tema<select data-ai-setting="offTopic"><option value="brief" ${settings.offTopic === "brief" ? "selected" : ""}>Respuesta breve</option><option value="ignore" ${settings.offTopic === "ignore" ? "selected" : ""}>No responder</option></select></label>
      <label class="field">Máx. respuestas por hilo<input type="number" min="1" max="50" data-ai-limit="maxRepliesPerThread" value="${settings.limits.maxRepliesPerThread}" /></label>
      <label class="field">Máx. respuestas automáticas por hora<input type="number" min="1" max="500" data-ai-limit="maxPerHour" value="${settings.limits.maxPerHour}" /></label>
      <label class="field">Largo máximo (caracteres)<input type="number" min="80" max="2000" data-ai-limit="maxLength" value="${settings.limits.maxLength}" /></label>
    </div></section>
    <section class="card"><div class="card-head"><div><h3>Derivar a agente</h3><span class="sub">Reclamos, cotizaciones o casos sin información suficiente.</span></div></div><div class="card-body prompt-grid">
      <label class="field">Departamento de Niro<select id="ai-department"><option value="">Sin departamento</option>${state.ai.departments.map((department) => `<option value="${esc(department.id)}" ${settings.derivation.departmentId === department.id ? "selected" : ""}>${esc(department.name)}</option>`).join("")}</select></label>
      <label class="field">Agente responsable (opcional)<input id="ai-agent" value="${esc(settings.derivation.agentName || "")}" placeholder="Nombre del agente" /></label>
      <label class="check-chip" style="align-self:end"><input type="checkbox" data-ai-crm ${settings.crm.pushToNiro ? "checked" : ""} /> Enviar prospectos con teléfono al CRM de Niro</label>
    </div></section>
    <section class="card"><div class="card-head"><div><h3>Base de conocimiento</h3><span class="sub">Productos, servicios, precios y condiciones vigentes que Niro puede usar en cualquier respuesta.</span></div></div><div class="card-body">
      <textarea id="ai-knowledge" class="ai-knowledge" placeholder="Ej: SMS masivo — Plan inicial 1.000 SMS Gs. 150.000…">${esc(settings.knowledgeBase || "")}</textarea>
      <div class="actions" style="margin-top:10px"><button class="btn primary sm" data-action="ai-save-knowledge">${icon("check", "sm")} Guardar configuración</button><span style="flex:1"></span><label class="field" style="width:120px">Horas atrás<input id="ai-backfill-hours" type="number" min="1" max="168" value="24" /></label><button class="btn ghost sm" data-action="ai-backfill" style="align-self:end">${icon("inbox", "sm")} Procesar avisos recientes</button></div>
    </div></section>`;
}

function aiLeads() {
  const leads = state.ai.leads;
  return `<section class="card"><div class="card-body">${leads.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Persona</th><th>Contacto</th><th>Interés</th><th>Pregunta</th><th>Origen</th><th>CRM Niro</th><th>Fecha</th></tr></thead><tbody>${leads.map((lead) => `<tr><td><b>${esc(lead.name || "—")}</b></td><td>${esc([lead.phone, lead.email].filter(Boolean).join(" · ") || "—")}</td><td class="text"><span class="clamp">${esc(lead.interest || "")}</span></td><td class="text"><span class="clamp">${esc(lead.question || "")}</span></td><td>${esc(lead.account || lead.channel)}</td><td>${lead.niroContactId ? '<span class="tag green">Enviado</span>' : lead.pushError ? `<span class="tag red" title="${esc(lead.pushError)}">Error</span>` : '<span class="tag">Sin teléfono</span>'}</td><td class="time">${when(lead.createdAt)}</td></tr>`).join("")}</tbody></table></div>` : emptyState("users", "Sin prospectos", "Cuando Niro detecte interés de compra, el contacto aparece acá.")}</div></section>`;
}

function aiAudit() {
  const audit = state.ai.audit;
  return `<section class="card"><div class="card-body ai-audit">${audit.length ? audit.map((entry) => `<div><span class="time">${when(entry.at)}</span> <b>${esc(entry.action)}</b> · ${esc(entry.actor)} — ${esc(entry.details)}</div>`).join("") : emptyState("clock", "Sin movimientos", "Acá queda todo lo recibido, generado, aprobado y enviado.")}</div></section>`;
}

function aiTest() {
  const result = state.ai.test;
  return `<section class="card"><div class="card-head"><div><h3>Probar una respuesta</h3><span class="sub">Simula una interacción con las instrucciones actuales. No publica nada.</span></div></div>
    <div class="card-body"><form id="ai-test-form" class="prompt-grid">
      <label class="field">Cuenta<select name="accountKey">${accountOptions().map((account) => `<option value="${esc(account.key)}">${esc(account.name)}</option>`).join("")}</select></label>
      <label class="field">Campaña (opcional)<input name="campaign" list="ai-campaigns" /><datalist id="ai-campaigns">${state.ai.prompts.filter((prompt) => prompt.scope === "campaign").map((prompt) => `<option value="${esc(prompt.scopeId)}"></option>`).join("")}</datalist></label>
      <label class="field" style="grid-column:1/-1">Texto de la publicación<textarea name="postText" placeholder="Pegá el texto de la publicación"></textarea></label>
      <label class="field" style="grid-column:1/-1">Comentario o mensaje recibido<textarea name="comment" required placeholder="¿Cuánto cuesta?"></textarea></label>
      <div class="actions" style="grid-column:1/-1"><button class="btn primary" type="submit">${icon("sparkles", "sm")} Generar respuesta de prueba</button></div>
    </form>
    ${result ? `<div class="ai-test-result"><div class="actions"><span class="tag violet">${esc(AI_CATEGORY_LABELS[result.decision.category] || result.decision.category)} · ${Math.round(result.decision.confidence * 100)}%</span><span class="tag ${result.decision.shouldReply ? "green" : ""}">${result.decision.shouldReply ? "Responde" : "No responde"}</span>${result.decision.escalate ? '<span class="tag orange">Deriva a agente</span>' : ""}${result.decision.lead?.is_lead ? '<span class="tag blue">Prospecto</span>' : ""}<span class="tag">Modo: ${esc(AI_MODE_LABELS[result.mode] || result.mode)}</span></div>
      <p class="ai-test-reply">${esc(result.decision.reply || "(sin respuesta)")}</p>
      <small>${esc(result.decision.reason)} · Capas: ${result.layers.map((layer) => `${esc(layer.name)} v${layer.version}`).join(" · ") || "ninguna"}${result.problems.length ? ` · <span style="color:var(--red)">${esc(result.problems.join(", "))}</span>` : ""}</small></div>` : ""}
    </div></section>`;
}

async function aiSettingsPatch(patch, message = null) {
  try {
    state.ai.settings = (await request("/api/ai/settings", { method: "PATCH", body: JSON.stringify(patch) })).settings;
    if (message) toast(message);
    await refresh();
  } catch (error) { toast(error.message, { error: true }); }
}

Object.assign(actions, {
  "ai-toggle": () => aiSettingsPatch({ enabled: !state.ai.settings.enabled }, state.ai.settings.enabled ? "Respuestas con IA desactivadas." : "Respuestas con IA activadas."),
  "ai-mode": (el) => aiSettingsPatch({ mode: el.dataset.mode }, `Modo general: ${AI_MODE_LABELS[el.dataset.mode]}.`),
  "ai-emergency": async () => {
    const stop = !state.ai.settings.emergencyStop;
    if (!stop && !(await dialogs.confirm({ title: "¿Reanudar los envíos automáticos?", message: "Niro vuelve a enviar solo las respuestas que el modo automático permite. Lo pendiente de aprobar sigue esperando tu revisión.", confirmLabel: "Reanudar envíos", iconName: "play" }))) return;
    aiSettingsPatch({ emergencyStop: stop }, stop ? "Parada de emergencia: no se envía nada automáticamente." : "Envíos automáticos reanudados.");
  },
  "ai-tab": (el) => { state.ai.tab = el.dataset.tab; state.ai.test = state.ai.tab === "probar" ? state.ai.test : null; loadAi().catch((error) => toast(error.message, { error: true })); renderView(); },
  "ai-filter": (el) => { state.ai.status = el.dataset.status; loadAi().catch((error) => toast(error.message, { error: true })); },
  "ai-act": async (el) => {
    const op = el.dataset.op;
    const body = {};
    const textarea = $(`[data-ai-reply="${CSS.escape(el.dataset.id)}"]`);
    if (textarea && ["approve", "edit"].includes(op)) body.reply = textarea.value;
    // Se pregunta antes de ocupar el botón: cancelar el diálogo cancela la acción.
    if (op === "derive") {
      const reason = await dialogs.prompt({ title: "Derivar a un agente", message: "La interacción pasa a una persona del equipo y la IA no la responde.", label: "Motivo (opcional)", placeholder: "Ej: pide una cotización formal", confirmLabel: "Derivar", iconName: "users" });
      if (reason === null) return null;
      body.reason = reason || "Derivada desde el panel.";
    }
    if (op === "takeover") {
      const agent = await dialogs.prompt({ title: "Tomar el hilo", message: "La IA deja de responder en este hilo hasta que lo devuelvas.", label: "¿Quién lo toma?", value: state.ai.settings.derivation.agentName || profileName(), required: true, confirmLabel: "Tomar el hilo", iconName: "pause" });
      if (agent === null) return null;
      body.agent = agent;
    }
    return run(el, null, async () => {
    await request(`/api/ai/interactions/${encodeURIComponent(el.dataset.id)}/${op}`, { method: "POST", body: JSON.stringify(body) });
    toast({ approve: "Aprobada: se envía en segundos.", edit: "Edición guardada.", regenerate: "Niro vuelve a redactar la respuesta.", derive: "Derivada a un agente.", ignore: "Interacción ignorada.", takeover: "Tomaste el hilo: la IA no va a responder ahí.", release: "El hilo vuelve a la IA." }[op]);
    await loadAi();
    });
  },
  "ai-audit-toggle": (el) => run(null, null, async () => {
    state.ai.openAudit = state.ai.openAudit === el.dataset.id ? null : el.dataset.id;
    if (state.ai.openAudit) state.ai.auditFor = (await request(`/api/ai/audit?interaction=${encodeURIComponent(el.dataset.id)}`)).audit;
    renderView();
  }),
  "ai-prompt-new": (el) => { state.ai.editingPrompt = `new:${el.dataset.scope}`; renderView(); },
  "ai-prompt-delete": async (el) => {
    if (!(await dialogs.confirm({ title: "¿Quitar estas instrucciones?", message: "Niro deja de usarlas en las próximas respuestas. Las respuestas ya enviadas no cambian.", confirmLabel: "Quitar instrucciones", tone: "danger" }))) return;
    run(el, null, async () => { await request(`/api/ai/prompts/${encodeURIComponent(el.dataset.id)}`, { method: "DELETE" }); await loadAi(); toast("Instrucciones quitadas."); });
  },
  "ai-save-knowledge": (el) => run(el, null, async () => {
    const departmentSelect = $("#ai-department");
    await aiSettingsPatch({
      knowledgeBase: $("#ai-knowledge").value,
      derivation: { departmentId: departmentSelect.value || null, departmentName: departmentSelect.selectedOptions[0]?.value ? departmentSelect.selectedOptions[0].textContent : "", agentName: $("#ai-agent").value },
    }, "Configuración guardada.");
  }),
  "ai-backfill": (el) => run(el, "Procesando…", async () => {
    const result = await request("/api/ai/backfill", { method: "POST", body: JSON.stringify({ hours: Number($("#ai-backfill-hours").value) || 24 }) });
    toast(`${result.added} interacción(es) agregadas a la cola.`);
    await loadAi();
  }),
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.matches("[data-prompt-form]")) {
    event.preventDefault();
    const data = new FormData(form);
    const scope = form.dataset.scope;
    const account = form.querySelector("select[name='account']");
    const body = {
      scope,
      scopeId: scope === "campaign" ? (form.dataset.scopeId || data.get("scopeName")) : scope === "account" ? (form.dataset.scopeId || account?.value) : form.dataset.scopeId,
      scopeName: scope === "campaign" ? (form.dataset.scopeName || data.get("scopeName")) : scope === "account" ? (form.dataset.scopeName || account?.selectedOptions[0]?.dataset.name) : form.dataset.scopeName,
      mode: data.get("mode"),
      fields: Object.fromEntries(PROMPT_FIELDS.map(([key]) => [key, data.get(key) || ""])),
    };
    await run(form.querySelector("[type='submit']"), "Guardando…", async () => {
      const result = await request("/api/ai/prompts", { method: "POST", body: JSON.stringify(body) });
      state.ai.editingPrompt = null;
      toast(`Instrucciones guardadas (v${result.prompt.version}).`);
      await loadAi();
    });
  }
  if (form.id === "ai-test-form") {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    await run(form.querySelector("[type='submit']"), "Consultando a Niro…", async () => {
      state.ai.test = await request("/api/ai/test", { method: "POST", body: JSON.stringify(data) });
      renderView();
      for (const [key, value] of Object.entries(data)) { const field = $(`#ai-test-form [name='${key}']`); if (field) field.value = value; }
    });
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (target.dataset.aiChannel) aiSettingsPatch({ channels: { [target.dataset.aiChannel]: target.checked } });
  else if (target.dataset.aiAccount) aiSettingsPatch({ accounts: { [target.dataset.aiAccount]: target.value } }, "Modo de la cuenta actualizado.");
  else if (target.dataset.aiSetting) aiSettingsPatch({ [target.dataset.aiSetting]: target.value });
  else if (target.dataset.aiLimit) aiSettingsPatch({ limits: { [target.dataset.aiLimit]: Number(target.value) } });
  else if (target.dataset.aiCrm !== undefined && target.matches("[data-ai-crm]")) aiSettingsPatch({ crm: { pushToNiro: target.checked } });
  else if (target.id === "ai-category") { state.ai.category = target.value; loadAi(); }
  else if (target.id === "ai-channel") { state.ai.channel = target.value; loadAi(); }
});

/* Configuración de IA de cada publicación (en Crear publicación) */
function composerAiSection() {
  const aiConfig = state.composer.ai;
  return `<details class="composer-ai" ${aiConfig.mode !== "inherit" || aiConfig.campaign ? "open" : ""}>
    <summary>${icon("sparkles", "sm")} <b>Responder interacciones con Niro</b><span class="tag ${aiConfig.mode === "off" ? "" : "violet"}">${{ inherit: "Configuración general", custom: "Instrucciones propias", off: "Apagado" }[aiConfig.mode]}</span></summary>
    <div class="prompt-grid" style="margin-top:10px">
      <label class="field">Respuestas para esta publicación<select id="composer-ai-mode"><option value="inherit" ${aiConfig.mode === "inherit" ? "selected" : ""}>Usar la configuración general</option><option value="custom" ${aiConfig.mode === "custom" ? "selected" : ""}>Instrucciones exclusivas</option><option value="off" ${aiConfig.mode === "off" ? "selected" : ""}>No responder</option></select></label>
      <label class="field">Campaña (opcional)<input id="composer-ai-campaign" list="composer-campaigns" value="${esc(aiConfig.campaign)}" placeholder="Ej: Niro Bot" /><datalist id="composer-campaigns">${(state.ai.prompts || []).filter((prompt) => prompt.scope === "campaign").map((prompt) => `<option value="${esc(prompt.scopeId)}"></option>`).join("")}</datalist></label>
    </div>
    ${aiConfig.mode === "custom" ? `<div class="prompt-grid">${PROMPT_FIELDS.map(([key, label, placeholder]) => `<label class="field">${label}<textarea data-composer-ai-field="${key}" placeholder="${esc(placeholder)}">${esc(aiConfig.fields[key] || "")}</textarea></label>`).join("")}
      <label class="field">Modo para esta publicación<select id="composer-ai-reply-mode">${Object.entries(AI_MODE_LABELS).map(([key, label]) => `<option value="${key}" ${aiConfig.replyMode === key ? "selected" : ""}>${label}</option>`).join("")}</select></label></div>` : ""}
  </details>`;
}

function composerAiPayload() {
  const aiConfig = state.composer.ai;
  // El CRM agrega "Enviar interesados al tablero" (viaja con la configuración de la publicación).
  return { mode: aiConfig.mode, campaign: aiConfig.campaign || null, fields: aiConfig.mode === "custom" ? aiConfig.fields : undefined, replyMode: aiConfig.replyMode, ...Object.assign({}, ...hooks.composerPayload.map((extend) => extend())) };
}

document.addEventListener("input", (event) => {
  const target = event.target;
  if (target.dataset.composerAiField) state.composer.ai.fields[target.dataset.composerAiField] = target.value;
  else if (target.id === "composer-ai-campaign") state.composer.ai.campaign = target.value;
});
document.addEventListener("change", (event) => {
  const target = event.target;
  if (target.id === "composer-ai-mode") { state.composer.ai.mode = target.value; renderView(); }
  else if (target.id === "composer-ai-reply-mode") state.composer.ai.replyMode = target.value;
});

/* ------------------------------------------------------------------ Publicaciones: filtros, selección y limpieza */
const DESTINATION_LABELS = { profile: "Perfil", story: "Historia de Facebook", group: "Grupo", page: "Página", instagram: "Instagram" };
const OWNER_LABELS = { profile: "Perfil", page: "Página", group: "Grupo" };
state.pubFilter = { q: "", from: "", to: "", type: "", account: "", status: "", origin: "" };
state.postFilter = { q: "", from: "", to: "", type: "", owner: "" };
state.pubSelected = new Set();
state.postSelected = new Set();
state.postLimit = 60;

function inDateRange(value, from, to) {
  if (!from && !to) return true;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return false;
  if (from && time < new Date(`${from}T00:00:00`).getTime()) return false;
  if (to && time > new Date(`${to}T23:59:59.999`).getTime()) return false;
  return true;
}

function filteredPublications() {
  const f = state.pubFilter;
  const q = f.q.trim().toLowerCase();
  return state.publications.filter((item) => {
    const target = item.target || {};
    if (f.type && target.type !== f.type) return false;
    if (f.account && `${target.type}:${target.id}` !== f.account) return false;
    if (f.status && item.status !== f.status) return false;
    if (f.origin && item.origin !== f.origin) return false;
    if (!inDateRange(item.createdAt, f.from, f.to)) return false;
    if (q && !`${item.text} ${target.name}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function filteredPosts() {
  const f = state.postFilter;
  const q = f.q.trim().toLowerCase();
  return state.posts.filter((post) => {
    if (f.type && post.ownerType !== f.type) return false;
    if (f.owner && `${post.ownerType}:${post.ownerId}` !== f.owner) return false;
    if (!inDateRange(post.observedAt, f.from, f.to)) return false;
    if (q && !`${post.text} ${post.author} ${post.ownerName}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function selectOptions(entries, current, allLabel) {
  return `<option value="">${esc(allLabel)}</option>${entries.map(([value, label]) => `<option value="${esc(value)}" ${current === value ? "selected" : ""}>${esc(label)}</option>`).join("")}`;
}

function bulkBar(kind, visible, selected) {
  const allChecked = visible.length > 0 && visible.every((item) => selected.has(item.id));
  const selectedVisible = visible.filter((item) => selected.has(item.id)).length;
  return `<div class="bulk-bar">
    <label class="check-chip"><input type="checkbox" data-select-all="${kind}" ${allChecked ? "checked" : ""} ${visible.length ? "" : "disabled"} /> Seleccionar todo (${visible.length})</label>
    <span class="tag ${selectedVisible ? "violet" : ""}">${selectedVisible} seleccionada(s)</span>
    <span style="flex:1"></span>
    <button class="btn danger sm" data-action="delete-selected" data-kind="${kind}" ${selectedVisible ? "" : "disabled"}>${icon("trash", "sm")} Eliminar seleccionadas</button>
    <button class="btn ghost sm" data-action="delete-filtered" data-kind="${kind}" ${visible.length ? "" : "disabled"}>${icon("trash", "sm")} Eliminar ${visible.length === (kind === "pub" ? state.publications.length : state.posts.length) ? "todo" : `las ${visible.length} filtradas`}</button>
  </div>`;
}

function renderPublications() {
  const status = state.status || {};
  const tabs = `<div class="segmented" style="max-width:560px"><button class="${state.postsTab === "history" ? "active" : ""}" data-action="posts-tab" data-tab="history">${icon("send", "sm")} Publicado con Niro (${state.publications.length})</button><button class="${state.postsTab === "facebook" ? "active" : ""}" data-action="posts-tab" data-tab="facebook">${icon("layers", "sm")} Descargadas (${state.posts.length})</button></div>`;
  let body;
  if (state.postsTab === "history") {
    const f = state.pubFilter;
    const list = filteredPublications();
    const accounts = [...new Map(state.publications.map((item) => [`${item.target?.type}:${item.target?.id}`, `${DESTINATION_LABELS[item.target?.type] || item.target?.type} · ${cleanGroupName(item.target?.name || "")}`])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    body = `<section class="card card-pad filter-bar">
        <input type="search" id="pub-q" placeholder="Buscar texto o destino…" value="${esc(f.q)}" />
        <label class="field">Desde<input type="date" data-pub-filter="from" value="${esc(f.from)}" /></label>
        <label class="field">Hasta<input type="date" data-pub-filter="to" value="${esc(f.to)}" /></label>
        <label class="field">Destino<select data-pub-filter="type">${selectOptions(Object.entries(DESTINATION_LABELS), f.type, "Todos")}</select></label>
        <label class="field">Cuenta<select data-pub-filter="account">${selectOptions(accounts, f.account, "Todas")}</select></label>
        <label class="field">Estado<select data-pub-filter="status">${selectOptions([["published", "Publicada"], ["failed", "Falló"]], f.status, "Todos")}</select></label>
        <label class="field">Origen<select data-pub-filter="origin">${selectOptions([["manual", "Manual"], ["schedule", "Programada"], ["scheduler", "Automática"], ["bulk", "Envío masivo"]], f.origin, "Todos")}</select></label>
        <button class="btn ghost sm" data-action="clear-filters" data-kind="pub">Limpiar filtros</button>
      </section>
      <section class="card">
        <div class="card-head"><h3>Historial <span class="sub">${list.length} de ${state.publications.length}</span></h3><div class="actions"><a class="btn ghost sm" href="${BASE}/api/export?kind=publications&format=csv" download>${icon("download", "sm")} CSV</a><a class="btn ghost sm" href="${BASE}/api/export?kind=publications&format=json" download>JSON</a></div></div>
        <div class="card-body">${bulkBar("pub", list, state.pubSelected)}
        ${list.length ? `<div class="table-wrap"><table class="data"><thead><tr><th></th><th>Destino</th><th>Texto</th><th>Origen</th><th>Estado</th><th>Fecha</th><th></th></tr></thead><tbody>${list.slice(0, 500).map((publication) => `<tr class="${state.pubSelected.has(publication.id) ? "row-selected" : ""}"><td><input type="checkbox" data-select-item="pub" data-id="${esc(publication.id)}" ${state.pubSelected.has(publication.id) ? "checked" : ""} aria-label="Seleccionar" /></td><td><div style="display:flex;gap:8px;align-items:center">${targetAvatar(publication.target, "xs")}<span><b>${esc(cleanGroupName(publication.target?.name || ""))}</b><br /><small class="sub">${esc(DESTINATION_LABELS[publication.target?.type] || "")}</small></span></div></td><td class="text"><span class="clamp">${esc(publication.text)}</span>${publication.error ? `<span style="color:var(--red);font-size:12px">${esc(String(publication.error).split(/\n\s*Call log:/)[0].replace(/\u001b\[[0-9;]*m/g, "").slice(0, 300))}</span>` : ""}</td><td>${esc(originLabel(publication.origin))}</td><td>${publication.status === "published" ? '<span class="tag green">Publicada</span>' : `<span class="tag red">Falló</span> <button class="link-btn" data-action="mark-published" data-id="${esc(publication.id)}" title="Usalo si verificaste que sí se publicó">Marcar publicada</button>`}</td><td class="time">${when(publication.createdAt)}</td><td><button class="round-btn danger-btn" data-action="delete-one" data-kind="pub" data-id="${esc(publication.id)}" title="Eliminar del historial" aria-label="Eliminar">${icon("trash", "sm")}</button></td></tr>`).join("")}</tbody></table></div>${list.length > 500 ? `<p class="sub" style="margin-top:8px">Se muestran 500 de ${list.length}; usá los filtros para acotar.</p>` : ""}` : emptyState("send", state.publications.length ? "Sin resultados con estos filtros" : "Todavía no hay publicaciones registradas", state.publications.length ? "Cambiá o limpiá los filtros." : "Cada publicación que hagas desde Niro queda registrada acá.")}</div>
      </section>`;
  } else {
    const f = state.postFilter;
    const list = filteredPosts();
    const owners = [...new Map(state.posts.map((post) => [`${post.ownerType}:${post.ownerId}`, `${OWNER_LABELS[post.ownerType] || post.ownerType} · ${post.ownerName}`])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    body = `<section class="card card-pad filter-bar">
        <input type="search" id="post-q" placeholder="Buscar texto o autor…" value="${esc(f.q)}" />
        <label class="field">Desde<input type="date" data-post-filter="from" value="${esc(f.from)}" /></label>
        <label class="field">Hasta<input type="date" data-post-filter="to" value="${esc(f.to)}" /></label>
        <label class="field">Tipo<select data-post-filter="type">${selectOptions(Object.entries(OWNER_LABELS), f.type, "Todos")}</select></label>
        <label class="field">Origen<select data-post-filter="owner">${selectOptions(owners, f.owner, "Todos")}</select></label>
        <button class="btn ghost sm" data-action="clear-filters" data-kind="post">Limpiar filtros</button>
        <span class="sub">${status.lastPostSyncAt ? `Última descarga ${timeAgo(status.lastPostSyncAt)}` : "Sin descargas todavía"}</span>
        <a class="btn ghost sm" href="${BASE}/api/export?kind=posts&format=csv" download>${icon("download", "sm")} CSV</a>
      </section>
      <section class="card card-pad">${bulkBar("post", list, state.postSelected)}</section>
      <div>${list.length ? list.slice(0, state.postLimit).map(postCard).join("") + (list.length > state.postLimit ? `<div class="pager"><button class="btn gray" data-action="posts-more">Ver más (${list.length - state.postLimit} restantes)</button></div>` : "") : `<section class="card">${emptyState("layers", state.posts.length ? "Sin resultados con estos filtros" : "No hay publicaciones descargadas", state.posts.length ? "Cambiá o limpiá los filtros." : "Activalas en Datos → Sincronización.", state.posts.length ? "" : `<button class="btn primary" data-action="scan-posts">${icon("download", "sm")} Descargar ahora</button>`)}</section>`}</div>`;
  }
  $("#view").innerHTML = `
    <div class="page-title"><div><span class="eyebrow">Contenido</span><h1>Publicaciones</h1><p>Historial de lo publicado con Niro y publicaciones descargadas. Eliminar acá solo limpia el historial de Niro: no borra nada en Facebook ni en Instagram.</p></div>
      <div class="actions"><button class="btn primary" data-action="scan-posts">${icon("download", "sm")} Descargar publicaciones</button></div></div>
    ${tabs}${body}`;
}

function ownerImage(post) {
  if (post.ownerType === "profile") return state.profile?.avatarUrl || null;
  if (post.ownerType === "page") return state.pages.find((page) => page.id === post.ownerId)?.avatarUrl || null;
  return null;
}

function postCard(post) {
  const author = post.author && post.author !== post.ownerName ? `${post.author} en ${post.ownerName}` : post.ownerName || "";
  const meta = [OWNER_LABELS[post.ownerType], post.postedLabel, `guardada ${when(post.observedAt)}`, post.imageCount > 1 ? `${post.imageCount} imágenes` : ""].filter(Boolean).join(" · ");
  const checked = state.postSelected.has(post.id);
  return `<article class="card post-card ${checked ? "row-selected" : ""}"><div class="fb-post-head"><input type="checkbox" data-select-item="post" data-id="${esc(post.id)}" ${checked ? "checked" : ""} aria-label="Seleccionar" />${avatar(post.ownerName || "", { size: "sm", seed: post.ownerId, image: ownerImage(post) })}<div><strong>${esc(author)}</strong><small>${esc(meta)}</small></div><span style="flex:1"></span><button class="btn ghost xs" data-action="open-url" data-url="${esc(post.url)}">${icon("external", "xs")} Abrir</button><button class="round-btn danger-btn" data-action="delete-one" data-kind="post" data-id="${esc(post.id)}" title="Eliminar del historial" aria-label="Eliminar">${icon("trash", "sm")}</button></div><div class="fb-post-text">${esc(post.text)}</div>${post.imageUrl ? `<img class="post-img" src="${esc(post.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ""}</article>`;
}

// scope: "one" (una fila), "all" (todo el historial) o "some" (seleccionadas o filtradas).
async function deleteHistory(kind, ids, scope = "some") {
  if (!ids.length) return;
  const count = ids.length;
  const title = kind === "pub"
    ? { one: "¿Eliminar este registro del historial?", all: `¿Eliminar todo el historial (${count} registros)?`, some: `¿Eliminar ${count} registro(s) del historial?` }[scope]
    : { one: "¿Eliminar esta publicación descargada?", all: `¿Eliminar todas las publicaciones descargadas (${count})?`, some: `¿Eliminar ${count} publicación(es) descargada(s)?` }[scope];
  if (!(await dialogs.confirm({ title, message: "Solo se borra de Niro: no se elimina nada en Facebook ni en Instagram.", confirmLabel: "Eliminar", tone: "danger" }))) return;
  await run(null, null, async () => {
    const result = await request(kind === "pub" ? "/api/publications/delete" : "/api/posts/delete", { method: "POST", body: JSON.stringify({ ids }) });
    const selected = kind === "pub" ? state.pubSelected : state.postSelected;
    for (const id of ids) selected.delete(id);
    await refresh({ soft: false });
    toast(`${result.deleted} eliminada(s).`, { title: "Historial actualizado" });
  });
}

Object.assign(actions, {
  "delete-one": (el) => deleteHistory(el.dataset.kind, [el.dataset.id], "one"),
  "delete-selected": (el) => {
    const kind = el.dataset.kind;
    const visible = new Set((kind === "pub" ? filteredPublications() : filteredPosts()).map((item) => item.id));
    const ids = [...(kind === "pub" ? state.pubSelected : state.postSelected)].filter((id) => visible.has(id));
    deleteHistory(kind, ids);
  },
  "delete-filtered": (el) => {
    const kind = el.dataset.kind;
    const ids = (kind === "pub" ? filteredPublications() : filteredPosts()).map((item) => item.id);
    const total = kind === "pub" ? state.publications.length : state.posts.length;
    deleteHistory(kind, ids, ids.length === total ? "all" : "some");
  },
  "clear-filters": (el) => {
    if (el.dataset.kind === "pub") state.pubFilter = { q: "", from: "", to: "", type: "", account: "", status: "", origin: "" };
    else state.postFilter = { q: "", from: "", to: "", type: "", owner: "" };
    renderView();
  },
  "posts-more": () => { state.postLimit += 60; renderView(); },
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (target.dataset.pubFilter) { state.pubFilter[target.dataset.pubFilter] = target.value; renderView(); }
  else if (target.dataset.postFilter) { state.postFilter[target.dataset.postFilter] = target.value; state.postLimit = 60; renderView(); }
  else if (target.dataset.selectItem) {
    const selected = target.dataset.selectItem === "pub" ? state.pubSelected : state.postSelected;
    selected[target.checked ? "add" : "delete"](target.dataset.id);
    renderView();
  } else if (target.dataset.selectAll) {
    const kind = target.dataset.selectAll;
    const selected = kind === "pub" ? state.pubSelected : state.postSelected;
    for (const item of kind === "pub" ? filteredPublications() : filteredPosts()) selected[target.checked ? "add" : "delete"](item.id);
    renderView();
  }
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (target.id === "pub-q") { state.pubFilter.q = target.value; rerenderKeepingFocus("pub-q"); }
  else if (target.id === "post-q") { state.postFilter.q = target.value; state.postLimit = 60; rerenderKeepingFocus("post-q"); }
});

/* ------------------------------------------------------------------ Tiempo real */
// Los módulos (explorador, CRM) registran acá sus oyentes del canal en vivo.
const streamHooks = [];
let pendingNew = [];
let pendingTimer = null;
function announceNewEvent(event) {
  pendingNew.push(event);
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    const batch = pendingNew;
    pendingNew = [];
    if (batch.length === 1) {
      const [item] = batch;
      const meta = KIND_META[item.kind] || KIND_META.other;
      toast((item.text || "").slice(0, 140), { title: meta.label === "Otras" ? "Nueva notificación" : meta.label, avatarHtml: avatar(eventSender(item), { size: "sm", image: eventImage(item) }), action: () => selectEvent(item.id), timeout: 8000 });
    } else {
      toast(`${batch.length} avisos nuevos en tu bandeja.`, { title: "Notificaciones", avatarHtml: `<span class="avatar sm solid-red">${icon("bell", "sm")}</span>`, action: () => navigate("#/notificaciones"), timeout: 8000 });
    }
    if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
      const first = batch[0];
      const notification = new Notification(batch.length === 1 ? `Niro · ${(KIND_META[first.kind] || KIND_META.other).label}` : `Niro · ${batch.length} avisos nuevos`, { body: (first.text || "").slice(0, 180), tag: "niro-events" });
      notification.onclick = () => { window.focus(); selectEvent(first.id); };
    }
  }, 1200);
}

function connectStream() {
  if (!("EventSource" in window)) return;
  const stream = new EventSource(BASE + "/api/stream");
  stream.addEventListener("event", (message) => {
    try {
      const { event } = JSON.parse(message.data);
      if (event && !state.events.some((item) => item.id === event.id)) { state.events.unshift(event); renderChrome(); announceNewEvent(event); }
    } catch { /* mensaje inválido */ }
    scheduleRefresh(1500);
  });
  stream.addEventListener("schedule", (message) => {
    try {
      const data = JSON.parse(message.data);
      if (data.finished) toast("Terminó la publicación de los pendientes.", { title: "Programación" });
      else if (data.status === "published") toast("Una publicación programada se envió.", { title: "Programación" });
      else if (data.status === "failed") toast("Una publicación programada falló. Revisala en Programación.", { error: true });
    } catch { /* mensaje inválido */ }
    scheduleRefresh(600);
  });
  stream.addEventListener("publication", () => scheduleRefresh(800));
  stream.addEventListener("posts", () => scheduleRefresh(1500));
  stream.addEventListener("sync", () => scheduleRefresh(500));
  stream.addEventListener("instagram", (message) => { try { const data = JSON.parse(message.data); if (data.kind === "done") { toast("Revisión de cuentas de Instagram terminada.", { title: "Instagram" }); scheduleRefresh(300); } } catch { /* mensaje inválido */ } });
  let aiTimer = null;
  stream.addEventListener("ai", (message) => {
    try {
      const data = JSON.parse(message.data);
      if (data.status === "pending") toast("Niro redactó una respuesta para aprobar.", { title: "Respuestas con IA", avatarHtml: `<span class="avatar sm solid-violet">${icon("sparkles", "sm")}</span>`, action: () => { state.ai.tab = "bandeja"; state.ai.status = "pending"; navigate("#/respuestas"); } });
      if (data.status === "sent") toast("Niro envió una respuesta.", { title: "Respuestas con IA" });
      if (data.status === "error") toast("Una respuesta con IA falló. Revisala en la bandeja.", { error: true });
    } catch { /* mensaje inválido */ }
    clearTimeout(aiTimer);
    aiTimer = setTimeout(() => { if (state.route === "respuestas") loadAi().catch(() => {}); scheduleRefresh(400); }, 700);
  });
  stream.addEventListener("sync-progress", (message) => {
    try {
      const next = JSON.parse(message.data);
      const wasRunning = state.sync?.state?.running;
      if (state.sync) state.sync.state = next;
      updateSyncViews();
      if (wasRunning && !next.running) toast(next.cancelRequested ? "Sincronización detenida." : "Sincronización terminada.", { title: "Sincronización" });
    } catch { /* mensaje inválido */ }
  });
  for (const hook of streamHooks) hook(stream);
}

/* ------------------------------------------------------------------ Módulos */
const moduleContext = { $, $$, state, actions, ROUTES, request, run, toast, icon, esc, avatar, timeAgo, when, emptyState, renderView, renderChrome, refresh, navigate, isTyping, rerenderKeepingFocus, selectOptions, cleanGroupName, streamHooks, openModal, chatName, profileName, hooks, uploadMediaFiles, dialogs };
installExplorer(moduleContext);
installCrm(moduleContext);
installAppearance({ ...moduleContext, closeDropdown, showDropdown });

/* ------------------------------------------------------------------ Arranque */
hydrateIcons(document);
state.route = parseRoute().name;
$$("[data-route]").forEach((link) => link.classList.toggle("active", link.dataset.route === state.route));
renderView();
refresh({ soft: false }).then(() => onRoute()).catch((error) => toast(error.message, { error: true }));
connectStream();
setInterval(() => { if (!document.hidden && !state.pendingAction) refresh().catch(() => {}); }, 60_000);
