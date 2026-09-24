// Respuestas inteligentes con Niro IA.
// Flujo: interacción detectada → normalización → contexto (publicación, hilo,
// prompts por capas) → reglas → API de Niro → validación → envío, aprobación,
// derivación o descarte. Todo queda en el historial (ai_reply_audit).
import { createHash, randomUUID } from "node:crypto";

export const AI_CATEGORIES = {
  product_question: "Pregunta sobre producto o servicio",
  price: "Consulta de precio",
  purchase_intent: "Interés de compra",
  complaint: "Reclamo",
  rude: "Comentario grosero",
  off_topic: "Ajeno al tema",
  spam: "Spam o repetido",
  opinion: "Opinión o debate",
  greeting: "Saludo o agradecimiento",
  other: "Otro",
};

export const AI_STATUSES = ["queued", "processing", "pending", "approved", "sending", "sent", "ignored", "derived", "notified", "error"];

const DEFAULT_SETTINGS = {
  enabled: false,
  emergencyStop: false,
  mode: "supervised",
  channels: { comments: true, mentions: false, messenger: true },
  accounts: {},
  voice: "owner",
  offTopic: "brief",
  knowledgeBase: "",
  limits: { maxRepliesPerThread: 3, cooldownMinutes: 3, maxPerHour: 40, maxLength: 600 },
  derivation: { departmentId: null, departmentName: "", agentName: "" },
  crm: { pushToNiro: true },
  takeovers: {},
};

const API_URL = (process.env.NIRO_AI_API_URL || "https://niro.cnid.com.py/api/v1").replace(/\/$/, "");
const API_KEY = process.env.NIRO_AI_API_KEY || "";

export function contentKey(text) {
  const normalized = String(text || "").toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 240);
  return normalized ? createHash("sha1").update(normalized).digest("hex").slice(0, 16) : null;
}

function words(text) {
  return new Set(String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((word) => word.length > 3));
}

function similarity(a, b) {
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

function notifType(url) {
  try { return new URL(url).searchParams.get("notif_t") || ""; } catch { return ""; }
}

function commentIdFrom(url) {
  try {
    const params = new URL(url).searchParams;
    return params.get("reply_comment_id") || params.get("comment_id") || null;
  } catch { return null; }
}

function threadUrl(url) {
  try {
    const link = new URL(url);
    for (const key of [...link.searchParams.keys()]) if (!["fbid", "story_fbid", "id", "set", "v"].includes(key)) link.searchParams.delete(key);
    link.hash = "";
    return link.href;
  } catch { return url; }
}

export function createAiReplies(deps) {
  const { getStore, persist, broadcast, facebook, now, cleanText, withBrowser, onInteraction = null } = deps;
  // El servidor reemplaza el store al cargar la base: siempre se lee el actual.
  const db = () => getStore();
  let timer = null;
  let working = false;
  let departmentsCache = { at: 0, items: [] };

  /* ---------------------------------------------------------- Configuración */
  function settings() {
    const saved = db().meta.aiReplies || {};
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      channels: { ...DEFAULT_SETTINGS.channels, ...(saved.channels || {}) },
      limits: { ...DEFAULT_SETTINGS.limits, ...(saved.limits || {}) },
      derivation: { ...DEFAULT_SETTINGS.derivation, ...(saved.derivation || {}) },
      crm: { ...DEFAULT_SETTINGS.crm, ...(saved.crm || {}) },
      accounts: { ...(saved.accounts || {}) },
      takeovers: { ...(saved.takeovers || {}) },
    };
  }

  async function updateSettings(patch, actor = "panel") {
    const current = settings();
    const next = { ...current };
    for (const key of ["enabled", "emergencyStop"]) if (typeof patch[key] === "boolean") next[key] = patch[key];
    if (["automatic", "supervised", "notify"].includes(patch.mode)) next.mode = patch.mode;
    if (["owner", "profile"].includes(patch.voice)) next.voice = patch.voice;
    if (["brief", "ignore"].includes(patch.offTopic)) next.offTopic = patch.offTopic;
    if (typeof patch.knowledgeBase === "string") next.knowledgeBase = patch.knowledgeBase.slice(0, 20_000);
    if (patch.channels && typeof patch.channels === "object") {
      for (const key of ["comments", "mentions", "messenger"]) if (typeof patch.channels[key] === "boolean") next.channels[key] = patch.channels[key];
    }
    if (patch.limits && typeof patch.limits === "object") {
      const bounds = { maxRepliesPerThread: [1, 50], cooldownMinutes: [0, 1_440], maxPerHour: [1, 500], maxLength: [80, 2_000] };
      for (const [key, [min, max]] of Object.entries(bounds)) {
        if (patch.limits[key] !== undefined && !Number.isNaN(Number(patch.limits[key]))) next.limits[key] = Math.max(min, Math.min(max, Math.round(Number(patch.limits[key]))));
      }
    }
    if (patch.accounts && typeof patch.accounts === "object") {
      for (const [key, value] of Object.entries(patch.accounts)) {
        if (["inherit", "automatic", "supervised", "notify", "off"].includes(value)) next.accounts[key] = value;
      }
    }
    if (patch.derivation && typeof patch.derivation === "object") {
      next.derivation = {
        departmentId: patch.derivation.departmentId || null,
        departmentName: String(patch.derivation.departmentName || "").slice(0, 120),
        agentName: String(patch.derivation.agentName || "").slice(0, 120),
      };
    }
    if (patch.crm && typeof patch.crm.pushToNiro === "boolean") next.crm.pushToNiro = patch.crm.pushToNiro;
    db().meta.aiReplies = next;
    audit(null, "settings", actor, summarizeSettingsChange(current, next));
    await persist();
    broadcast("ai", { kind: "settings" });
    return next;
  }

  function summarizeSettingsChange(before, after) {
    const changes = [];
    if (before.enabled !== after.enabled) changes.push(after.enabled ? "módulo activado" : "módulo desactivado");
    if (before.emergencyStop !== after.emergencyStop) changes.push(after.emergencyStop ? "PARADA DE EMERGENCIA" : "parada de emergencia levantada");
    if (before.mode !== after.mode) changes.push(`modo ${after.mode}`);
    return changes.join(" · ") || "configuración actualizada";
  }

  /* ---------------------------------------------------------- Prompts por capas */
  function prompts() { return db().aiPrompts; }

  async function savePrompt(input, actor = "panel") {
    const scope = ["general", "account", "campaign", "publication"].includes(input.scope) ? input.scope : "general";
    const scopeId = scope === "general" ? "general" : String(input.scopeId || "").slice(0, 200);
    if (scope !== "general" && !scopeId) throw new Error("Falta indicar a qué cuenta, campaña o publicación aplica.");
    const fields = {};
    for (const key of ["topic", "offer", "facts", "faq", "tone", "contact", "escalate", "instructions"]) fields[key] = String(input.fields?.[key] || "").slice(0, 8_000);
    const mode = ["inherit", "automatic", "supervised", "notify", "off"].includes(input.mode) ? input.mode : "inherit";
    let prompt = db().aiPrompts.find((item) => (input.id && item.id === input.id) || (item.scope === scope && item.scopeId === scopeId));
    if (prompt) {
      // Versionado: cada cambio guarda la versión anterior para auditar respuestas pasadas.
      prompt.history = [...(prompt.history || []), { version: prompt.version, fields: prompt.fields, mode: prompt.mode, updatedAt: prompt.updatedAt }].slice(-30);
      prompt.version += 1;
      Object.assign(prompt, { fields, mode, scopeName: input.scopeName || prompt.scopeName, updatedAt: now() });
    } else {
      prompt = { id: randomUUID(), scope, scopeId, scopeName: String(input.scopeName || scopeId).slice(0, 200), fields, mode, version: 1, history: [], createdAt: now(), updatedAt: now() };
      db().aiPrompts.push(prompt);
    }
    audit(null, "prompt", actor, `${scope}:${prompt.scopeName} v${prompt.version}`);
    await persist();
    broadcast("ai", { kind: "prompts" });
    return prompt;
  }

  async function deletePrompt(id) {
    const index = db().aiPrompts.findIndex((item) => item.id === id);
    if (index === -1) throw new Error("Prompt no encontrado.");
    const [removed] = db().aiPrompts.splice(index, 1);
    audit(null, "prompt", "panel", `eliminado ${removed.scope}:${removed.scopeName}`);
    await persist();
    return removed;
  }

  // Publicación → campaña → cuenta → general (la más específica manda).
  function promptLayers(context) {
    const find = (scope, scopeId) => scopeId ? db().aiPrompts.find((item) => item.scope === scope && item.scopeId === scopeId) : null;
    const layers = [
      find("general", "general"),
      find("account", context.accountKey),
      find("campaign", context.campaign),
      find("publication", context.publicationKey),
    ].filter(Boolean);
    return layers;
  }

  /* ---------------------------------------------------------- Captura */
  function channelFor(event) {
    if (event.source === "messenger") return "messenger";
    const type = notifType(event.url);
    if (/reaction|like/.test(type)) return null;
    if (/mention/.test(type)) return "mention";
    if (/comment|reply/.test(type)) return "comment";
    if (!type && event.kind === "comment" && !/le gusta|les gusta|reaccion/i.test(event.text || "")) return "comment";
    return null;
  }

  function isOwnName(name) {
    const own = [db().profile?.name, ...db().pages.map((page) => page.name)].filter(Boolean).map((item) => item.toLowerCase());
    return own.includes(String(name || "").toLowerCase().trim());
  }

  // Llamado por cada aviso nuevo. Una interacción por evento (externalId).
  async function captureEvent(event) {
    const config = settings();
    if (!config.enabled) return null;
    const channel = channelFor(event);
    if (!channel) return null;
    if (channel === "comment" && !config.channels.comments) return null;
    if (channel === "mention" && !config.channels.mentions) return null;
    if (channel === "messenger" && !config.channels.messenger) return null;
    const dedupeKey = `${event.source}:${event.externalId}`;
    if (db().aiInteractions.some((item) => item.dedupeKey === dedupeKey)) return null;
    // Evita bucles: la vista previa de Messenger "Tú: …" es un mensaje propio.
    if (channel === "messenger" && /(^|·\s*)(tú|you):/i.test(event.text || "")) return null;
    const chat = channel === "messenger" ? db().chats.find((item) => item.url === event.url || event.externalId?.startsWith(`${item.id}:`)) : null;
    const interaction = {
      id: randomUUID(),
      dedupeKey,
      eventId: event.id,
      channel,
      url: event.url,
      commentId: channel === "messenger" ? null : commentIdFrom(event.url),
      threadKey: channel === "messenger" ? `chat:${chat?.id || event.url}` : `post:${threadUrl(event.url)}`,
      person: { name: chat?.name || null, avatarUrl: chat?.avatarUrl || event.avatarUrl || null },
      account: null,
      post: null,
      text: channel === "messenger" ? cleanText(chat?.lastMessage || chat?.preview || event.text, 2_000) : null,
      notificationText: event.text,
      thread: [],
      category: null,
      confidence: null,
      suggestion: null,
      finalReply: null,
      status: "queued",
      mode: null,
      reason: null,
      promptVersions: [],
      assignment: null,
      attempts: 0,
      error: null,
      createdAt: now(),
      updatedAt: now(),
    };
    db().aiInteractions.unshift(interaction);
    if (db().aiInteractions.length > 5_000) db().aiInteractions.length = 5_000;
    audit(interaction.id, "received", "system", `${channel}: ${cleanText(event.text, 200)}`);
    await persist();
    broadcast("ai", { kind: "interaction", id: interaction.id, status: interaction.status });
    return interaction;
  }

  /* ---------------------------------------------------------- Contexto desde Facebook */
  async function readCommentContext(interaction) {
    await facebook.openUrl(interaction.url);
    await facebook.homePage.waitForSelector("[aria-label^='Comentario de'], [aria-label^='Respuesta de'], [aria-label^='Comment by'], [aria-label^='Reply by']", { timeout: 15_000 }).catch(() => {});
    await facebook.homePage.waitForTimeout(1_200);
    return facebook.homePage.evaluate((commentId) => {
      const compact = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const comments = Array.from(document.querySelectorAll("[aria-label^='Comentario de'], [aria-label^='Respuesta de'], [aria-label^='Comment by'], [aria-label^='Reply by']"));
      const parse = (element) => {
        const label = element.getAttribute("aria-label") || "";
        const author = compact(label.replace(/^(Comentario de|Respuesta de|Comment by|Reply by)\s+/i, "").replace(/\s+(hace|\d+\s|a las|el |yesterday|ayer).*$/i, ""));
        const textNode = element.querySelector("div[dir='auto'], span[dir='auto']");
        const bodies = Array.from(element.querySelectorAll("div[dir='auto']")).map((node) => compact(node.innerText)).filter(Boolean);
        const text = bodies.find((body) => body !== author) || compact(textNode?.innerText);
        const image = element.querySelector("svg image, img");
        const links = Array.from(element.querySelectorAll("a[href*='comment_id']")).map((anchor) => anchor.href);
        return { author, text, avatar: image ? image.getAttribute("xlink:href") || image.src : null, links };
      };
      const parsed = comments.map(parse);
      const target = parsed.find((item) => commentId && item.links.some((href) => href.includes(commentId))) || parsed[0] || null;
      const message = document.querySelector("[data-ad-rendering-role='story_message'], [data-ad-preview='message'], [data-ad-comet-preview='message']");
      const complementary = document.querySelector("[role='complementary']");
      const owner = compact((complementary || document).querySelector("h2, h3, strong, a[role='link'][aria-label]")?.innerText || "");
      const header = compact((complementary || document).innerText || "").slice(0, 300);
      let postText = compact(message?.innerText);
      if (!postText && complementary) {
        const firstComment = complementary.querySelector("[aria-label^='Comentario de'], [aria-label^='Comment by']");
        // Solo la descripción: fuera de comentarios, enlaces, botones y rótulos de la interfaz.
        const noise = /(estás comentando como|commenting as|view post)|^(esta foto es de una publicación|ver publicación|promocionar publicación|más relevantes|me gusta|comentar|compartir|responder|seguir|follow|haces|d+s*(min|h|d|sem))/i;
        const nodes = Array.from(complementary.querySelectorAll("div[dir='auto'], span[dir='auto']"))
          .filter((node) => (!firstComment || !firstComment.contains(node)) && !node.closest("a, [role='button'], [aria-label^='Comentario de'], [aria-label^='Comment by']"))
          .filter((node) => { const value = compact(node.innerText); return value.length > 2 && !noise.test(value); });
        postText = [...new Set(nodes.filter((node) => !nodes.some((other) => other !== node && other.contains(node))).map((node) => compact(node.innerText)))].join(" ").slice(0, 2_000);
        // Sin descripción: queda solo el nombre del autor y la fecha, que no aportan contexto.
        if (owner && postText.replace(owner, "").replace(/hace .*$/i, "").trim().length < 4) postText = "";
      }
      return {
        target,
        thread: parsed.slice(0, 12).map(({ author, text }) => ({ author, text: text?.slice(0, 500) })),
        post: { text: postText?.slice(0, 3_000) || "", owner, header },
      };
    }, interaction.commentId);
  }

  async function readChatTail(interaction) {
    const chatId = interaction.threadKey.replace(/^chat:/, "");
    const chat = db().chats.find((item) => item.id === chatId);
    if (!chat) return { messages: [] };
    const page = await facebook.context.newPage();
    try {
      await page.goto(chat.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector("[aria-roledescription][aria-label]", { timeout: 12_000 }).catch(() => {});
      await page.waitForTimeout(800);
      const rows = await facebook.extractMessageRows(page);
      return { chat, messages: rows.slice(-12) };
    } finally {
      await page.close().catch(() => {});
    }
  }

  /* ---------------------------------------------------------- Publicación asociada */
  function matchPublication(postText, postUrl) {
    const candidates = [
      ...db().publications.filter((item) => item.status === "published").map((item) => ({ kind: "niro", item, text: item.text, url: item.url })),
      ...db().posts.map((item) => ({ kind: "facebook", item, text: item.text, url: item.url })),
    ];
    const key = contentKey(postText);
    let best = null;
    for (const candidate of candidates) {
      let score = 0;
      if (postUrl && candidate.url && threadUrl(candidate.url) === threadUrl(postUrl)) score = 1;
      else if (key && contentKey(candidate.text) === key) score = 0.98;
      else score = similarity(postText, candidate.text);
      if (!best || score > best.score) best = { ...candidate, score };
    }
    if (!best || best.score < 0.55) return null;
    const ai = best.kind === "niro" ? best.item.ai || {} : {};
    return {
      kind: best.kind,
      id: best.item.id,
      score: Number(best.score.toFixed(2)),
      campaign: ai.campaign || null,
      publicationKey: ai.contentKey || contentKey(best.text),
      aiMode: ai.mode || "inherit",
      text: best.text,
    };
  }

  // Cuenta dueña de la publicación: coincidencia exacta o, si no, la página
  // propia cuyo nombre (el más largo) aparece en el encabezado o la notificación.
  function accountFor(ownerName, channel, hint = "") {
    if (channel === "messenger") return { key: `profile:${db().profile?.id || "me"}`, type: "profile", name: db().profile?.name || "Tu perfil" };
    const haystack = String(hint || "").toLowerCase();
    const page = db().pages.find((item) => item.name && ownerName && item.name.toLowerCase() === ownerName.toLowerCase())
      || [...db().pages].sort((a, b) => b.name.length - a.name.length).find((item) => item.name && haystack.includes(item.name.toLowerCase()));
    if (page) return { key: `page:${page.id}`, type: "page", id: page.id, name: page.name };
    return { key: `profile:${db().profile?.id || "me"}`, type: "profile", name: db().profile?.name || "Tu perfil" };
  }

  function resolveMode(interaction, layers) {
    const config = settings();
    const accountMode = config.accounts[interaction.account?.key] || "inherit";
    if (accountMode === "off") return { mode: "off", source: "cuenta" };
    if (interaction.publication?.aiMode === "off") return { mode: "off", source: "publicación" };
    // La capa más específica con modo propio decide; si no, la cuenta; si no, el general.
    const layered = [...layers].reverse().find((layer) => layer.mode && layer.mode !== "inherit");
    let mode = layered?.mode || (accountMode !== "inherit" ? accountMode : config.mode);
    if (mode === "automatic" && config.emergencyStop) mode = "supervised";
    return { mode, source: layered ? layered.scope : accountMode !== "inherit" ? "cuenta" : "general" };
  }

  /* ---------------------------------------------------------- Niro IA */
  async function callNiro(messages) {
    if (!API_KEY) throw new Error("Falta NIRO_AI_API_KEY en .env.");
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(`${API_URL}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({ messages }),
          signal: AbortSignal.timeout(60_000),
        });
        const payload = await response.json().catch(() => ({}));
        if (response.status === 401) throw Object.assign(new Error("La API Key de Niro es inválida o fue revocada."), { fatal: true });
        if (response.status === 402) throw Object.assign(new Error("Saldo insuficiente en la wallet de Niro."), { fatal: true });
        if (!response.ok) throw new Error(payload?.error?.message || `Niro respondió HTTP ${response.status}`);
        const content = payload?.choices?.[0]?.message?.content;
        if (!content) throw new Error("Niro no devolvió contenido.");
        return { content, model: payload.model, usage: payload.usage };
      } catch (error) {
        lastError = error;
        if (error.fatal) break;
        await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  function buildMessages(interaction, layers, config) {
    const account = interaction.account?.name || "la cuenta";
    const system = [
      `Sos el asistente que responde las interacciones de "${account}" en Facebook.`,
      "Tu trabajo: clasificar la interacción y, si corresponde, redactar la respuesta que se publicará tal cual.",
      "Reglas:",
      "- Respondé en el mismo idioma y registro de la persona, con amabilidad y de forma breve y natural (sin markdown, sin listas largas).",
      `- Máximo ${config.limits.maxLength} caracteres.`,
      "- Usá SOLO la información autorizada en las instrucciones y en la base de conocimiento. No inventes precios, plazos, stock ni condiciones.",
      "- Si preguntan algo que no está en la información autorizada (por ejemplo un precio que no figura), no lo inventes: invitá a escribir por privado o al contacto autorizado y marcá escalate=true.",
      "- La interacción siempre se refiere a la publicación original indicada, aunque no la nombre (por ejemplo \"¿cuánto cuesta?\").",
      "- Ante un reclamo: respondé con respeto, sin discutir, y marcá escalate=true.",
      "- Ante un comentario grosero: mantené la amabilidad, no discutas; podés no responder.",
      config.offTopic === "ignore" ? "- Si la interacción es ajena al tema, should_reply=false." : "- Si la interacción es ajena al tema, respondé muy breve y amable.",
      "- Spam, cadenas o comentarios repetidos: should_reply=false.",
      "- Solo compartí enlaces o datos de contacto que aparezcan como autorizados.",
      "- Si la persona muestra intención de compra o deja datos de contacto, completá lead.",
      "Devolvé SOLO un objeto JSON válido con esta forma exacta:",
      '{"category":"product_question|price|purchase_intent|complaint|rude|off_topic|spam|opinion|greeting|other","confidence":0.0,"should_reply":true,"reply":"texto","escalate":false,"escalate_reason":"","lead":{"is_lead":false,"name":"","phone":"","email":"","interest":""},"reason":"explicación breve de la decisión"}',
    ].join("\n");
    const layerText = layers.map((layer) => {
      const fields = layer.fields || {};
      const title = { general: "Instrucciones generales", account: `Cuenta ${layer.scopeName}`, campaign: `Campaña ${layer.scopeName}`, publication: "Esta publicación" }[layer.scope];
      const lines = [
        fields.topic && `Tema: ${fields.topic}`,
        fields.offer && `Qué se ofrece o comunica: ${fields.offer}`,
        fields.facts && `Datos autorizados: ${fields.facts}`,
        fields.faq && `Preguntas frecuentes: ${fields.faq}`,
        fields.tone && `Tono: ${fields.tone}`,
        fields.contact && `Contacto que se puede compartir: ${fields.contact}`,
        fields.escalate && `Derivar a una persona cuando: ${fields.escalate}`,
        fields.instructions && `Instrucciones: ${fields.instructions}`,
      ].filter(Boolean).join("\n");
      return lines ? `### ${title} (v${layer.version})\n${lines}` : "";
    }).filter(Boolean).join("\n\n");
    const context = [
      `Canal: ${interaction.channel === "messenger" ? "mensaje privado de Messenger" : "comentario en una publicación de Facebook"}`,
      `Cuenta que responde: ${account}`,
      interaction.post?.text ? `Publicación original:\n"""${interaction.post.text.slice(0, 2_500)}"""` : "Publicación original: (no disponible)",
      layerText ? `Instrucciones (de general a específica; la más específica tiene prioridad):\n${layerText}` : "",
      config.knowledgeBase ? `Base de conocimiento:\n${config.knowledgeBase.slice(0, 8_000)}` : "",
      interaction.thread?.length ? `Hilo reciente:\n${interaction.thread.map((item) => `- ${item.author}: ${item.text}`).join("\n")}` : "",
      `Interacción a responder, de ${interaction.person?.name || "una persona"}:\n"""${interaction.text || interaction.notificationText}"""`,
    ].filter(Boolean).join("\n\n");
    return [{ role: "system", content: system }, { role: "user", content: context }];
  }

  function parseDecision(content) {
    const raw = String(content).replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    const decision = JSON.parse(raw.slice(start, end + 1));
    return {
      category: AI_CATEGORIES[decision.category] ? decision.category : "other",
      confidence: Math.max(0, Math.min(1, Number(decision.confidence) || 0)),
      shouldReply: decision.should_reply !== false,
      reply: cleanText(decision.reply || "", 2_000),
      escalate: decision.escalate === true,
      escalateReason: cleanText(decision.escalate_reason || "", 300),
      lead: decision.lead && typeof decision.lead === "object" ? decision.lead : null,
      reason: cleanText(decision.reason || "", 400),
    };
  }

  // Validador: longitud, enlaces no autorizados y texto vacío.
  function validateReply(reply, layers, config) {
    const problems = [];
    if (!reply) problems.push("respuesta vacía");
    if (reply.length > config.limits.maxLength + 50) problems.push("respuesta demasiado larga");
    const allowed = layers.map((layer) => layer.fields?.contact || "").join(" ") + " " + config.knowledgeBase;
    for (const link of reply.match(/https?:\/\/\S+|www\.\S+/gi) || []) {
      const host = link.replace(/^https?:\/\//, "").split(/[/?#]/)[0].replace(/^www\./, "");
      if (!allowed.includes(host)) problems.push(`enlace no autorizado (${host})`);
    }
    if (/[{}]|```/.test(reply)) problems.push("formato inválido");
    return problems;
  }

  /* ---------------------------------------------------------- Reglas */
  function sentInThread(threadKey) {
    return db().aiInteractions.filter((item) => item.threadKey === threadKey && item.status === "sent");
  }

  function hourlySent() {
    const since = Date.now() - 3_600_000;
    return db().aiInteractions.filter((item) => item.status === "sent" && Date.parse(item.sentAt) > since).length;
  }

  function setStatus(interaction, status, patch = {}, actor = "system", detail = "") {
    Object.assign(interaction, patch, { status, updatedAt: now() });
    audit(interaction.id, status, actor, detail || patch.reason || "");
    broadcast("ai", { kind: "interaction", id: interaction.id, status });
    // El CRM completa la tarjeta con la categoría, los datos aportados y la respuesta enviada.
    if (onInteraction && status !== "processing") Promise.resolve(onInteraction(interaction)).catch((error) => console.error("[crm] interacción", error.message));
  }

  async function prepare(interaction) {
    const config = settings();
    setStatus(interaction, "processing");
    // 1) Contexto real desde Facebook (usa el navegador con candado).
    if (interaction.channel === "messenger") {
      const tail = await withBrowser(() => readChatTail(interaction));
      if (tail === null) { interaction.status = "queued"; return "busy"; }
      const last = tail.messages.at(-1);
      if (last && /^(tú|you)$/i.test(last.sender || "")) {
        setStatus(interaction, "ignored", { reason: "El último mensaje del chat es propio." });
        return "done";
      }
      interaction.thread = tail.messages.map((row) => ({ author: row.sender, text: row.text?.slice(0, 500) }));
      const incoming = [...tail.messages].reverse().find((row) => !/^(tú|you)$/i.test(row.sender || ""));
      interaction.text = incoming?.text || interaction.text;
      interaction.person.name = incoming?.sender || interaction.person.name;
      interaction.account = accountFor(null, "messenger");
      interaction.post = null;
    } else {
      const context = await withBrowser(() => readCommentContext(interaction));
      if (context === null) { interaction.status = "queued"; return "busy"; }
      if (!context.target?.text) {
        setStatus(interaction, "error", { error: "No encontré el comentario en la publicación (pudo haberse borrado).", attempts: interaction.attempts + 1 });
        return "done";
      }
      interaction.text = context.target.text;
      interaction.person = { name: context.target.author || interaction.person.name, avatarUrl: interaction.person.avatarUrl };
      interaction.thread = context.thread;
      interaction.post = { text: context.post.text, owner: context.post.owner, url: threadUrl(interaction.url) };
      interaction.account = accountFor(context.post.owner, "comment", [context.post.header, interaction.notificationText].join(" "));
      interaction.publication = matchPublication(context.post.text, interaction.url);
    }
    if (interaction.status !== "processing") return "done";
    // 2) Reglas previas a la IA.
    if (isOwnName(interaction.person?.name)) {
      setStatus(interaction, "ignored", { reason: "La interacción la escribió la propia cuenta (evita bucles)." });
      return "done";
    }
    const takeover = config.takeovers[interaction.threadKey];
    if (takeover) {
      setStatus(interaction, "notified", { reason: `Hilo atendido por ${takeover.agent || "un agente"}: la IA no interviene.` });
      return "done";
    }
    if (sentInThread(interaction.threadKey).length >= config.limits.maxRepliesPerThread) {
      setStatus(interaction, "ignored", { reason: `Límite de ${config.limits.maxRepliesPerThread} respuestas en este hilo.` });
      return "done";
    }
    const layers = promptLayers({ accountKey: interaction.account?.key, campaign: interaction.publication?.campaign, publicationKey: interaction.publication?.publicationKey });
    interaction.promptVersions = layers.map((layer) => ({ id: layer.id, scope: layer.scope, name: layer.scopeName, version: layer.version }));
    const { mode, source } = resolveMode(interaction, layers);
    interaction.mode = mode;
    if (mode === "off") {
      setStatus(interaction, "ignored", { reason: `Respuestas apagadas (${source}).` });
      return "done";
    }
    if (mode === "notify") {
      setStatus(interaction, "notified", { reason: "Modo solo notificar." });
      return "done";
    }
    // 3) Niro IA.
    const messages = buildMessages(interaction, layers, config);
    const result = await callNiro(messages);
    const decision = parseDecision(result.content);
    if (interaction.status !== "processing") return "done";
    Object.assign(interaction, {
      category: decision.category,
      confidence: decision.confidence,
      suggestion: decision.reply,
      finalReply: decision.reply,
      reason: decision.reason,
      model: result.model,
      lead: decision.lead,
    });
    audit(interaction.id, "generated", "niro", `${decision.category} (${Math.round(decision.confidence * 100)}%): ${decision.reply}`, { promptVersions: interaction.promptVersions });
    if (decision.lead?.is_lead) await registerLead(interaction, decision.lead);
    if (decision.category === "spam") {
      setStatus(interaction, "ignored", { reason: decision.reason || "Spam o comentario repetido." });
      return "done";
    }
    if (!decision.shouldReply) {
      setStatus(interaction, decision.escalate ? "derived" : "ignored", { reason: decision.reason || "Niro decidió no responder.", assignment: decision.escalate ? derivation(decision.escalateReason) : null });
      return "done";
    }
    const problems = validateReply(decision.reply, layers, config);
    const needsHuman = decision.escalate || problems.length || decision.confidence < 0.5;
    if (decision.escalate) interaction.assignment = derivation(decision.escalateReason || decision.reason);
    if (mode === "automatic" && !problems.length && !(decision.escalate && decision.category !== "complaint") && decision.confidence >= 0.5) {
      if (hourlySent() >= config.limits.maxPerHour) {
        setStatus(interaction, "pending", { reason: `Límite de ${config.limits.maxPerHour} respuestas por hora: queda para aprobar.` });
        return "done";
      }
      setStatus(interaction, "approved", { approvedBy: "niro (automático)" });
      return "done";
    }
    setStatus(interaction, "pending", { reason: problems.length ? `Revisar: ${problems.join(", ")}` : needsHuman ? (decision.escalateReason || "Requiere revisión humana.") : "Modo supervisado." });
    return "done";
  }

  function derivation(reason) {
    const config = settings();
    return { departmentId: config.derivation.departmentId, departmentName: config.derivation.departmentName || "Agentes", agent: config.derivation.agentName || null, reason: reason || "Requiere atención humana", at: now() };
  }

  async function registerLead(interaction, lead) {
    const existing = db().leads.find((item) => item.interactionId === interaction.id);
    if (existing) return existing;
    const record = {
      id: randomUUID(),
      interactionId: interaction.id,
      name: cleanText(lead.name || interaction.person?.name || "", 200),
      phone: cleanText(lead.phone || "", 40),
      email: cleanText(lead.email || "", 200),
      interest: cleanText(lead.interest || "", 500),
      channel: interaction.channel,
      account: interaction.account?.name || null,
      postText: interaction.post?.text?.slice(0, 500) || null,
      postUrl: interaction.post?.url || interaction.url,
      question: interaction.text,
      createdAt: now(),
      niroContactId: null,
      pushError: null,
    };
    db().leads.unshift(record);
    audit(interaction.id, "lead", "niro", `Prospecto: ${record.name}${record.phone ? ` (${record.phone})` : ""}`);
    if (record.phone && settings().crm.pushToNiro && API_KEY) {
      try {
        const response = await fetch(`${API_URL}/whatsapp/contacts`, {
          method: "POST",
          headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({ phoneNumber: record.phone, fullName: record.name || undefined, email: record.email || undefined }),
          signal: AbortSignal.timeout(20_000),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
        record.niroContactId = payload?.contact?.id || payload?.contacts?.[0]?.id || payload?.id || "ok";
      } catch (error) {
        record.pushError = error.message;
      }
    }
    return record;
  }

  /* ---------------------------------------------------------- Envío a Facebook */
  async function sendCommentReply(interaction, text) {
    await facebook.openUrl(interaction.url);
    const page = facebook.homePage;
    await page.waitForSelector("[aria-label^='Comentario de'], [aria-label^='Comment by']", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1_200);
    const name = interaction.person?.name || "";
    // Caja "Responde a <nombre>"; si no está abierta, se pulsa "Responder" en ese comentario.
    let box = page.locator(`[contenteditable='true'][aria-label^='Responde a'], [contenteditable='true'][aria-label^='Reply to']`).first();
    if (!(await box.isVisible().catch(() => false))) {
      const comment = page.locator(`[aria-label^='Comentario de ${name.replace(/'/g, "\\'")}'], [aria-label^='Comment by ${name.replace(/'/g, "\\'")}']`).first();
      const reply = comment.getByRole("button", { name: /^(Responder|Reply)$/i }).first();
      if (await reply.count()) await reply.click();
      await page.waitForTimeout(900);
      box = page.locator(`[contenteditable='true'][aria-label^='Responde a'], [contenteditable='true'][aria-label^='Reply to']`).first();
    }
    if (!(await box.isVisible().catch(() => false))) throw new Error("Facebook no mostró la caja de respuesta del comentario.");
    const label = await box.getAttribute("aria-label") || "";
    if (name && !label.toLowerCase().includes(name.split(" ")[0].toLowerCase())) throw new Error(`La caja de respuesta no corresponde a ${name} (${label}).`);
    // Voz: responder como la página dueña de la publicación.
    let voice = db().profile?.name || "perfil";
    if (settings().voice === "owner" && interaction.account?.type === "page") {
      const container = box.locator("xpath=ancestor::*[.//*[@aria-label='Voces disponibles, cambiar de perfil' or @aria-label='Available voices, switch profile']][1]");
      const switcher = container.getByRole("button", { name: /Voces disponibles|Available voices/i }).first();
      if (await switcher.count()) {
        await switcher.click();
        // Diálogo "Tus perfiles y páginas": cambia la identidad solo para esta publicación.
        const name = interaction.account.name;
        const quoted = name.replace(/"/g, '\\"');
        const search = page.locator("input[placeholder*='Buscar perfiles'], input[placeholder*='Search profiles'], input[aria-label*='Buscar perfiles']").first();
        if (await search.waitFor({ state: "visible", timeout: 6_000 }).then(() => true).catch(() => false)) {
          await search.fill(name);
          await page.waitForTimeout(1_200);
        }
        const option = await page.locator(`[role="button"][aria-label^="${quoted},"], [role="button"][aria-label="${quoted}"]`)
          .filter({ hasNot: page.locator("[contenteditable]") })
          .first()
          .waitFor({ state: "visible", timeout: 6_000 })
          .then(() => page.locator(`[role="button"][aria-label^="${quoted},"], [role="button"][aria-label="${quoted}"]`).first())
          .catch(() => null);
        if (option) {
          facebook.identitySwitched = true;
          await option.click();
          await page.waitForTimeout(1_500);
          const identity = await page.evaluate(() => (document.body.innerText.match(/(?:Estás comentando como|You're commenting as)\s+([^\n.]+)/i) || [])[1] || "").catch(() => "");
          if (identity && identity.trim().toLowerCase() !== interaction.account.name.toLowerCase()) {
            throw new Error(`Facebook sigue comentando como ${identity.trim()}; no se envió nada.`);
          }
          voice = interaction.account.name;
        } else {
          await page.keyboard.press("Escape");
          throw new Error(`No pude elegir la voz de la página ${interaction.account.name}.`);
        }
        box = page.locator(`[contenteditable='true'][aria-label^='Responde a'], [contenteditable='true'][aria-label^='Reply to']`).first();
      }
    }
    await box.click();
    await box.fill(text);
    await page.waitForTimeout(400);
    await box.press("Enter");
    await page.waitForTimeout(2_500);
    const posted = await page.evaluate((snippet) => Array.from(document.querySelectorAll("[aria-label^='Respuesta de'], [aria-label^='Comentario de'], [aria-label^='Reply by'], [aria-label^='Comment by']"))
      .some((element) => (element.innerText || "").includes(snippet)), text.slice(0, 40)).catch(() => false);
    // Volver al perfil personal: el cambio de voz afecta a toda la sesión.
    if (facebook.identitySwitched) {
      const restore = await facebook.ensurePersonalProfile().catch((error) => ({ restored: false, reason: error.message }));
      if (!restore.restored && facebook.identitySwitched) audit(interaction.id, "identity", "system", `No se pudo volver al perfil personal: ${restore.reason}`);
    }
    if (!posted) throw new Error("Facebook no confirmó la respuesta publicada.");
    return { voice };
  }

  async function sendMessengerReply(interaction, text) {
    const chatId = interaction.threadKey.replace(/^chat:/, "");
    const chat = db().chats.find((item) => item.id === chatId);
    if (!chat) throw new Error("El chat ya no está en la lista.");
    const page = await facebook.context.newPage();
    try {
      await page.goto(chat.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const box = page.locator("[contenteditable='true'][role='textbox'][aria-label*='ensaje'], [contenteditable='true'][role='textbox'][aria-label*='essage']").first();
      await box.waitFor({ state: "visible", timeout: 15_000 });
      await box.click();
      await box.fill(text);
      await page.waitForTimeout(300);
      await box.press("Enter");
      await page.waitForTimeout(2_000);
      const rows = await facebook.extractMessageRows(page);
      if (!rows.some((row) => /^(tú|you)$/i.test(row.sender || "") && row.text.includes(text.slice(0, 30)))) throw new Error("Messenger no confirmó el mensaje enviado.");
      return { voice: db().profile?.name || "perfil" };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async function send(interaction) {
    try {
      return await sendOnce(interaction);
    } catch (error) {
      if (facebook.identitySwitched) await withBrowser(() => facebook.ensurePersonalProfile()).catch(() => {});
      throw error;
    }
  }

  async function sendOnce(interaction) {
    const text = cleanText(interaction.finalReply || interaction.suggestion || "", 2_000);
    if (!text) throw new Error("No hay texto para enviar.");
    setStatus(interaction, "sending");
    const result = await withBrowser(() => interaction.channel === "messenger" ? sendMessengerReply(interaction, text) : sendCommentReply(interaction, text));
    if (result === null) { interaction.status = "approved"; return "busy"; }
    setStatus(interaction, "sent", { sentText: text, sentAt: now(), voice: result.voice, error: null }, interaction.approvedBy || "panel", `Enviado como ${result.voice}: ${text}`);
    return "done";
  }

  /* ---------------------------------------------------------- Cola */
  async function tick() {
    if (working) return;
    const config = settings();
    if (!config.enabled || !facebook.isOpen) return;
    const approved = db().aiInteractions.filter((item) => item.status === "approved").at(-1);
    const queued = db().aiInteractions.filter((item) => item.status === "queued" || (item.status === "error" && item.retryable && item.attempts < 3 && Date.now() - Date.parse(item.updatedAt) > 60_000)).at(-1);
    const next = config.emergencyStop ? queued : approved || queued;
    if (!next) return;
    working = true;
    let stage = "prepare";
    try {
      stage = next.status === "approved" ? "send" : "prepare";
      const outcome = stage === "send" ? await send(next) : await prepare(next);
      if (outcome !== "busy") await persist();
    } catch (error) {
      next.attempts = (next.attempts || 0) + 1;
      setStatus(next, "error", { error: error.message, stage, retryable: stage === "prepare" && !error.fatal && next.attempts < 3 }, "system", error.message);
      await persist();
      console.error(`[ai] ${next.id}: ${error.message}`);
    } finally {
      working = false;
    }
  }

  function start() {
    // Recupera trabajos que quedaron a medias si el panel se reinició.
    for (const item of db().aiInteractions) {
      if (item.status === "processing") item.status = "queued";
      if (item.status === "sending") item.status = "approved";
    }
    if (!timer) timer = setInterval(() => tick().catch(() => {}), 6_000);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /* ---------------------------------------------------------- Acciones del panel */
  async function act(id, action, body = {}, actor = "panel") {
    const interaction = db().aiInteractions.find((item) => item.id === id);
    if (!interaction) throw new Error("Interacción no encontrada.");
    const reply = typeof body.reply === "string" ? cleanText(body.reply, 2_000) : null;
    if (["processing", "sending"].includes(interaction.status) && !["takeover", "release"].includes(action)) throw new Error("Niro está trabajando en esta interacción. Esperá unos segundos.");
    if (action === "approve") {
      if (["sent", "sending"].includes(interaction.status)) throw new Error("Esta interacción ya se respondió.");
      const text = reply ?? interaction.finalReply ?? interaction.suggestion;
      if (!text) throw new Error("Escribí una respuesta antes de aprobar.");
      interaction.finalReply = text;
      interaction.edited = Boolean(reply && reply !== interaction.suggestion);
      setStatus(interaction, "approved", { approvedBy: actor }, actor, interaction.edited ? `Aprobada con edición: ${text}` : "Aprobada");
    } else if (action === "edit") {
      if (!reply) throw new Error("La respuesta está vacía.");
      interaction.finalReply = reply;
      interaction.edited = reply !== interaction.suggestion;
      audit(interaction.id, "edited", actor, reply);
    } else if (action === "ignore") {
      setStatus(interaction, "ignored", { reason: body.reason || "Ignorada desde el panel." }, actor);
    } else if (action === "derive") {
      setStatus(interaction, "derived", { assignment: { ...derivation(body.reason || "Derivada desde el panel."), agent: body.agent || settings().derivation.agentName || null } }, actor);
    } else if (action === "regenerate") {
      if (["sent", "sending"].includes(interaction.status)) throw new Error("Esta interacción ya se respondió.");
      interaction.attempts = 0;
      setStatus(interaction, "queued", { error: null }, actor, "Regenerar respuesta");
    } else if (action === "retry") {
      interaction.attempts = 0;
      setStatus(interaction, interaction.finalReply && interaction.status === "error" && interaction.suggestion ? "approved" : "queued", { error: null }, actor, "Reintentar");
    } else if (action === "takeover" || action === "release") {
      const config = settings();
      if (action === "takeover") config.takeovers[interaction.threadKey] = { agent: body.agent || "agente", at: now() };
      else delete config.takeovers[interaction.threadKey];
      db().meta.aiReplies = config;
      audit(interaction.id, action, actor, action === "takeover" ? `Hilo tomado por ${body.agent || "agente"}` : "Hilo devuelto a la IA");
    } else {
      throw new Error("Acción no reconocida.");
    }
    await persist();
    broadcast("ai", { kind: "interaction", id: interaction.id, status: interaction.status });
    return interaction;
  }

  // Prueba sin Facebook ni envío: sirve para ajustar prompts.
  async function test({ postText = "", comment = "", accountKey = null, campaign = null, publicationKey = null, channel = "comment", personName = "Cliente" }) {
    if (!comment.trim()) throw new Error("Escribí el comentario o mensaje de prueba.");
    const config = settings();
    const account = accountKey?.startsWith("page:") ? db().pages.find((page) => `page:${page.id}` === accountKey) : null;
    const interaction = {
      channel,
      account: account ? { key: accountKey, type: "page", name: account.name } : { key: accountKey || `profile:${db().profile?.id || "me"}`, type: "profile", name: db().profile?.name || "Tu perfil" },
      post: { text: postText },
      person: { name: personName },
      text: comment,
      thread: [],
    };
    const layers = promptLayers({ accountKey: interaction.account.key, campaign, publicationKey: publicationKey || contentKey(postText) });
    const result = await callNiro(buildMessages(interaction, layers, config));
    const decision = parseDecision(result.content);
    return { decision, problems: decision.reply ? validateReply(decision.reply, layers, config) : [], layers: layers.map((layer) => ({ scope: layer.scope, name: layer.scopeName, version: layer.version })), model: result.model, mode: resolveMode(interaction, layers).mode };
  }

  // Incorpora avisos ya existentes (por ejemplo, al activar el módulo por primera vez).
  async function backfill(hours = 24) {
    const since = Date.now() - Math.max(1, Math.min(168, Number(hours) || 24)) * 3_600_000;
    let added = 0;
    for (const event of [...db().events].reverse()) {
      if (Date.parse(event.firstSeenAt) < since) continue;
      if (await captureEvent(event)) added += 1;
    }
    return added;
  }

  async function departments() {
    if (Date.now() - departmentsCache.at < 10 * 60_000) return departmentsCache.items;
    if (!API_KEY) return [];
    try {
      const response = await fetch(`${API_URL}/whatsapp/departments`, { headers: { authorization: `Bearer ${API_KEY}` }, signal: AbortSignal.timeout(15_000) });
      const payload = await response.json();
      departmentsCache = { at: Date.now(), items: (payload.departments || []).map(({ id, name, color }) => ({ id, name, color })) };
    } catch { /* se reintenta en la próxima consulta */ }
    return departmentsCache.items;
  }

  function stats() {
    const counts = Object.fromEntries(AI_STATUSES.map((status) => [status, 0]));
    const byCategory = {};
    const byPost = new Map();
    for (const item of db().aiInteractions) {
      counts[item.status] = (counts[item.status] || 0) + 1;
      if (item.category) byCategory[item.category] = (byCategory[item.category] || 0) + 1;
      const key = item.post?.url || item.threadKey;
      if (!byPost.has(key)) byPost.set(key, { key, text: item.post?.text || item.notificationText, account: item.account?.name, url: item.post?.url || item.url, total: 0, sent: 0, automatic: 0, approved: 0, derived: 0, ignored: 0, pending: 0 });
      const row = byPost.get(key);
      row.total += 1;
      if (item.status === "sent") { row.sent += 1; if (item.approvedBy?.startsWith("niro")) row.automatic += 1; else row.approved += 1; }
      if (item.status === "derived") row.derived += 1;
      if (item.status === "ignored") row.ignored += 1;
      if (item.status === "pending") row.pending += 1;
    }
    return { counts, byCategory, byPost: [...byPost.values()].sort((a, b) => b.total - a.total).slice(0, 100), apiConfigured: Boolean(API_KEY) };
  }

  function audit(interactionId, action, actor, details, extra = {}) {
    db().aiAudit.unshift({ id: randomUUID(), interactionId, action, actor, details: String(details || "").slice(0, 2_000), ...extra, at: now() });
    if (db().aiAudit.length > 20_000) db().aiAudit.length = 20_000;
  }

  return { settings, updateSettings, prompts, savePrompt, deletePrompt, captureEvent, backfill, act, test, stats, departments, start, stop, tick, contentKey };
}
