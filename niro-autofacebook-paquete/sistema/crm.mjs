// CRM visual integrado con Autopost y Messenger.
// Tableros con columnas (y embudos opcionales), contactos con identidades por
// canal, oportunidades (tarjetas) con su atribución, actividades, tareas de
// seguimiento, historial de etapas, fuentes de campaña y campañas dirigidas a
// segmentos del CRM.
// Reglas: un «me gusta» o un compartido solo suma métricas (no crea tarjetas ni
// permiso para escribir); cada evento tiene un identificador único para no
// duplicar tarjetas; la unión de contactos entre canales es supervisada.
import { randomUUID } from "node:crypto";

export const STAGE_KINDS = {
  new: "Nuevo interés",
  contacted: "Contactado",
  quote: "Cotización",
  followup: "Seguimiento",
  open: "En proceso",
  won: "Ganado",
  lost: "Perdido",
};

export const CRM_CHANNELS = {
  messenger: "Messenger",
  instagram: "Instagram",
  comment: "Comentario",
  mention: "Mención",
  meta_form: "Formulario de Meta",
  google_form: "Formulario de Google Ads",
  web_form: "Formulario web",
  manual: "Carga manual",
};

const DEFAULT_STAGES = [
  ["Nuevo interés", "new", "#6857e7"],
  ["Contactado", "contacted", "#1877f2"],
  ["Cotización enviada", "quote", "#e98a2e"],
  ["Seguimiento", "followup", "#0f9fb0"],
  ["Ganado", "won", "#22a86b"],
  ["Perdido", "lost", "#d2556a"],
];

// Comentarios que piden seguimiento: precio, información, consultas, contacto.
const INTEREST = /precio|cu[aá]nto (sale|cuesta|es|vale|cobr)|costo|valor|info\b|informaci[oó]n|m[aá]s datos|detalles|interesad|me interesa|quiero|quisiera|consulta|cotiza|presupuesto|disponib|stock|whats?app|wsp|n[uú]mero|tel[eé]fono|contacto|inbox|privado|\bdm\b|env[ií]o|delivery|c[oó]mo (compro|hago|funciona|adquiero)|d[oó]nde (queda|est[aá]n|compro)|horario|precios?\?/i;
const INTEREST_CATEGORIES = ["price", "purchase_intent", "product_question"];
const MILESTONES = ["contacted", "quote", "followup", "won", "lost"];
const DAY = 86_400_000;

const DEFAULT_SETTINGS = {
  defaultBoardId: null,
  capture: { messenger: true, comments: true, aiLeads: true, reactions: true },
  agents: [],
  departments: ["Ventas", "Soporte"],
};

function plain(value, max = 4_000) {
  return String(value ?? "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

// Estado de conexión de Messenger: nunca es el nombre de una persona.
const PRESENCE = /^(activ[oa]|active|en l[ií]nea|online)(\s+(ahora|now|hace\s+.+|\d+\s*\S+(\s+ago)?))?$/i;

function usableName(name) {
  const clean = String(name || "").trim();
  return clean && !PRESENCE.test(clean) && clean !== "Sin nombre" ? clean : "";
}

function normalizeName(name) {
  return String(name || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// Paraguay y la región: +595 981 123 456 y 0981 123456 son el mismo número.
export function phoneKey(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-9) : null;
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

export function createCrm(deps) {
  const { getStore, persist, broadcast, now, cleanText } = deps;
  const db = () => getStore();
  // Un solo reloj (el del servidor) para vencimientos y la ventana de 24 h.
  const nowMs = () => Date.parse(now());
  let timer = null;

  /* ---------------------------------------------------------- Configuración */
  function settings() {
    const saved = db().meta.crm || {};
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      capture: { ...DEFAULT_SETTINGS.capture, ...(saved.capture || {}) },
      agents: Array.isArray(saved.agents) ? saved.agents : [],
      departments: Array.isArray(saved.departments) && saved.departments.length ? saved.departments : DEFAULT_SETTINGS.departments,
    };
  }

  async function updateSettings(patch = {}) {
    const next = settings();
    if (patch.defaultBoardId !== undefined && db().crmBoards.some((board) => board.id === patch.defaultBoardId)) next.defaultBoardId = patch.defaultBoardId;
    if (patch.capture && typeof patch.capture === "object") {
      for (const key of Object.keys(DEFAULT_SETTINGS.capture)) if (typeof patch.capture[key] === "boolean") next.capture[key] = patch.capture[key];
    }
    if (Array.isArray(patch.agents)) {
      next.agents = patch.agents.map((agent) => ({ name: cleanText(agent?.name, 80), department: cleanText(agent?.department, 80) || null, boardIds: Array.isArray(agent?.boardIds) ? agent.boardIds.filter((id) => typeof id === "string") : [] }))
        .filter((agent) => agent.name).slice(0, 100);
    }
    if (Array.isArray(patch.departments)) next.departments = [...new Set(patch.departments.map((item) => cleanText(item, 80)).filter(Boolean))].slice(0, 50);
    db().meta.crm = next;
    await persist();
    broadcast("crm", { kind: "settings" });
    return next;
  }

  const actorName = (actor) => cleanText(actor, 80) || db().profile?.name || "Panel";

  /* ---------------------------------------------------------- Tableros, embudos y columnas */
  function board(id) { return db().crmBoards.find((item) => item.id === id) || null; }
  function stage(id) { return db().crmStages.find((item) => item.id === id) || null; }

  function stagesOf(boardId, pipelineId = null) {
    return db().crmStages.filter((item) => item.boardId === boardId && (!pipelineId || item.pipelineId === pipelineId)).sort((a, b) => a.position - b.position);
  }

  function firstStage(boardId, pipelineId = null) {
    const target = board(boardId);
    const pipeline = pipelineId || target?.pipelines?.[0]?.id || "main";
    const list = stagesOf(boardId, pipeline);
    return list.find((item) => item.kind === "new") || list.find((item) => !["won", "lost"].includes(item.kind)) || list[0] || null;
  }

  function addStages(boardId, pipelineId, template) {
    const base = stagesOf(boardId, pipelineId).length;
    return template.map(([name, kind, color], index) => {
      const item = { id: randomUUID(), boardId, pipelineId, name, kind, color, position: base + index, createdAt: now() };
      db().crmStages.push(item);
      return item;
    });
  }

  function ensureDefaults() {
    if (!db().crmBoards.length) {
      const item = { id: randomUUID(), name: "Ventas", color: "#6857e7", description: "Interesados que llegan desde publicaciones, Messenger y formularios.", routingKeywords: [], pipelines: [{ id: "main", name: "Principal" }], archived: false, createdAt: now(), updatedAt: now() };
      db().crmBoards.push(item);
      addStages(item.id, "main", DEFAULT_STAGES);
      db().meta.crm = { ...settings(), defaultBoardId: item.id };
      return true;
    }
    let changed = false;
    for (const item of db().crmBoards) {
      if (!Array.isArray(item.pipelines) || !item.pipelines.length) { item.pipelines = [{ id: "main", name: "Principal" }]; changed = true; }
    }
    if (!board(settings().defaultBoardId)) {
      db().meta.crm = { ...settings(), defaultBoardId: db().crmBoards.find((item) => !item.archived)?.id || db().crmBoards[0].id };
      changed = true;
    }
    return changed;
  }

  async function saveBoard(input = {}) {
    const name = cleanText(input.name, 80);
    if (!name) throw new Error("Poné un nombre al tablero.");
    const keywords = [...new Set((Array.isArray(input.routingKeywords) ? input.routingKeywords : String(input.routingKeywords || "").split(/[,\n]/)).map((item) => cleanText(item, 60).toLowerCase()).filter(Boolean))].slice(0, 40);
    const pipelines = Array.isArray(input.pipelines)
      ? input.pipelines.map((pipeline) => ({ id: cleanText(pipeline?.id, 60) || randomUUID(), name: cleanText(pipeline?.name, 60) })).filter((pipeline) => pipeline.name).slice(0, 10)
      : null;
    let item = board(input.id);
    if (item) {
      Object.assign(item, { name, color: /^#[0-9a-f]{6}$/i.test(input.color || "") ? input.color : item.color, description: cleanText(input.description, 300), routingKeywords: keywords, updatedAt: now() });
      if (typeof input.archived === "boolean") item.archived = input.archived;
      if (pipelines?.length) {
        const kept = new Set(pipelines.map((pipeline) => pipeline.id));
        const removed = item.pipelines.filter((pipeline) => !kept.has(pipeline.id));
        for (const pipeline of removed) {
          if (db().crmOpportunities.some((opportunity) => opportunity.boardId === item.id && opportunity.pipelineId === pipeline.id)) throw new Error(`El embudo “${pipeline.name}” tiene tarjetas: movelas antes de quitarlo.`);
        }
        db().crmStages = db().crmStages.filter((entry) => !(entry.boardId === item.id && removed.some((pipeline) => pipeline.id === entry.pipelineId)));
        item.pipelines = pipelines;
        for (const pipeline of pipelines) if (!stagesOf(item.id, pipeline.id).length) addStages(item.id, pipeline.id, DEFAULT_STAGES);
      }
    } else {
      item = { id: randomUUID(), name, color: /^#[0-9a-f]{6}$/i.test(input.color || "") ? input.color : "#6857e7", description: cleanText(input.description, 300), routingKeywords: keywords, pipelines: pipelines?.length ? pipelines : [{ id: "main", name: "Principal" }], archived: false, createdAt: now(), updatedAt: now() };
      db().crmBoards.push(item);
      for (const pipeline of item.pipelines) addStages(item.id, pipeline.id, input.template === "empty" ? [["Nuevo interés", "new", "#6857e7"]] : DEFAULT_STAGES);
    }
    if (!board(settings().defaultBoardId)) db().meta.crm = { ...settings(), defaultBoardId: item.id };
    await persist();
    broadcast("crm", { kind: "boards" });
    return item;
  }

  async function deleteBoard(id) {
    const item = board(id);
    if (!item) throw new Error("Tablero no encontrado.");
    if (db().crmBoards.length === 1) throw new Error("Tiene que quedar al menos un tablero.");
    if (db().crmOpportunities.some((opportunity) => opportunity.boardId === id)) throw new Error("El tablero tiene tarjetas: archivalo o mové las tarjetas antes de eliminarlo.");
    db().crmBoards = db().crmBoards.filter((entry) => entry.id !== id);
    db().crmStages = db().crmStages.filter((entry) => entry.boardId !== id);
    if (settings().defaultBoardId === id) db().meta.crm = { ...settings(), defaultBoardId: db().crmBoards[0].id };
    await persist();
    broadcast("crm", { kind: "boards" });
  }

  async function saveStage(input = {}) {
    const name = cleanText(input.name, 60);
    if (!name) throw new Error("Poné un nombre a la columna.");
    const kind = STAGE_KINDS[input.kind] ? input.kind : "open";
    const color = /^#[0-9a-f]{6}$/i.test(input.color || "") ? input.color : null;
    let item = stage(input.id);
    if (item) Object.assign(item, { name, kind, color: color || item.color, updatedAt: now() });
    else {
      const target = board(input.boardId);
      if (!target) throw new Error("Tablero no encontrado.");
      const pipelineId = target.pipelines.some((pipeline) => pipeline.id === input.pipelineId) ? input.pipelineId : target.pipelines[0].id;
      [item] = addStages(target.id, pipelineId, [[name, kind, color || "#858797"]]);
      // Las columnas nuevas quedan antes de Ganado/Perdido.
      const list = stagesOf(target.id, pipelineId);
      const closed = list.filter((entry) => ["won", "lost"].includes(entry.kind) && entry.id !== item.id);
      if (!["won", "lost"].includes(kind) && closed.length) {
        const ordered = [...list.filter((entry) => !closed.includes(entry) && entry.id !== item.id), item, ...closed];
        ordered.forEach((entry, index) => { entry.position = index; });
      }
    }
    await persist();
    broadcast("crm", { kind: "stages" });
    return item;
  }

  async function reorderStages(ids = []) {
    ids.forEach((id, index) => { const item = stage(id); if (item) item.position = index; });
    await persist();
    broadcast("crm", { kind: "stages" });
  }

  async function deleteStage(id, moveTo = null, actor = null) {
    const item = stage(id);
    if (!item) throw new Error("Columna no encontrada.");
    const siblings = stagesOf(item.boardId, item.pipelineId).filter((entry) => entry.id !== id);
    if (!siblings.length) throw new Error("Cada embudo necesita al menos una columna.");
    const cards = db().crmOpportunities.filter((opportunity) => opportunity.stageId === id);
    const target = cards.length ? stage(moveTo) : null;
    if (cards.length && (!target || target.boardId !== item.boardId || target.pipelineId !== item.pipelineId)) throw new Error("Elegí a qué columna pasan las tarjetas de esta columna.");
    for (const opportunity of cards) applyMove(opportunity, target, { actor, reason: `Columna “${item.name}” eliminada` });
    db().crmStages = db().crmStages.filter((entry) => entry.id !== id);
    siblings.forEach((entry, index) => { entry.position = index; });
    await persist();
    broadcast("crm", { kind: "stages" });
  }

  /* ---------------------------------------------------------- Contactos e identidades */
  const identityId = (channel, externalId) => `${channel}:${String(externalId).slice(0, 300)}`;

  function contact(id) { return db().crmContacts.find((item) => item.id === id) || null; }
  function identitiesOf(contactId) { return db().crmIdentities.filter((item) => item.contactId === contactId); }

  function contactByIdentity(channel, externalId) {
    if (!externalId) return null;
    const identity = db().crmIdentities.find((item) => item.id === identityId(channel, externalId));
    return identity ? contact(identity.contactId) : null;
  }

  // Si el identificador ya es de otra persona no se reasigna: queda como
  // sugerencia de unión para que la decida un agente.
  function ensureIdentity(target, channel, externalId, extra = {}) {
    if (!externalId) return null;
    const id = identityId(channel, externalId);
    const existing = db().crmIdentities.find((item) => item.id === id);
    if (existing) {
      if (existing.contactId !== target.id) suggestMerge(target, contact(existing.contactId), CRM_CHANNELS[channel] || channel);
      else Object.assign(existing, Object.fromEntries(Object.entries(extra).filter(([, value]) => value != null && value !== "")));
      return existing;
    }
    const identity = { id, contactId: target.id, channel, externalId: String(externalId).slice(0, 300), displayName: extra.displayName || null, url: extra.url || null, lastInboundAt: extra.lastInboundAt || null, createdAt: now() };
    db().crmIdentities.push(identity);
    return identity;
  }

  function suggestMerge(a, b, reason) {
    if (!a || !b || a.id === b.id) return;
    for (const [left, right] of [[a, b], [b, a]]) {
      left.duplicates = (left.duplicates || []).filter((entry) => entry.contactId !== right.id);
      if (!(left.dismissedDuplicates || []).includes(right.id)) left.duplicates.push({ contactId: right.id, reason, at: now() });
    }
  }

  function upsertContact({ channel, externalId, name, phone, email, avatarUrl, url, displayName }) {
    let target = contactByIdentity(channel, externalId);
    const cleanName = cleanText(usableName(name) || usableName(displayName), 120);
    if (!target) {
      target = { id: randomUUID(), name: cleanName || "Sin nombre", phone: null, email: null, avatarUrl: avatarUrl || null, company: null, tags: [], consent: {}, notes: "", duplicates: [], createdAt: now(), updatedAt: now() };
      db().crmContacts.push(target);
      // Mismo nombre en otro canal (comentario ↔ Messenger): sugerencia supervisada.
      const key = normalizeName(cleanName);
      if (key.length > 3) {
        const namesake = db().crmContacts.find((item) => item.id !== target.id && normalizeName(item.name) === key);
        if (namesake) suggestMerge(target, namesake, "Mismo nombre en otro canal");
      }
    } else {
      // El nombre de Messenger manda (la persona pudo cambiarlo), salvo que un agente lo haya editado.
      if (cleanName && target.nameSource !== "manual" && target.name !== cleanName && (!usableName(target.name) || channel === "messenger")) renameContact(target, cleanName);
      if (avatarUrl && !target.avatarUrl) target.avatarUrl = avatarUrl;
      target.updatedAt = now();
    }
    if (externalId) ensureIdentity(target, channel, externalId, { displayName: displayName || cleanName, url });
    setContactData(target, { phone, email });
    return target;
  }

  // Cambia el nombre y, con él, el título de las tarjetas que lo repetían.
  function renameContact(target, name) {
    for (const card of db().crmOpportunities) if (card.contactId === target.id && (card.title === target.name || !usableName(card.title))) card.title = name;
    target.name = name;
  }

  // Llamado al actualizar la lista de chats: la persona pudo cambiar su nombre en
  // Messenger o una lectura anterior pudo traer un estado ("Activo ahora").
  function syncChatNames(chats = []) {
    let changed = 0;
    for (const chat of chats) {
      const name = cleanText(usableName(chat?.name), 120);
      if (!name) continue;
      const identity = db().crmIdentities.find((item) => item.id === identityId("messenger", chat.id));
      const target = identity ? contact(identity.contactId) : null;
      if (!target || target.nameSource === "manual" || target.name === name) continue;
      renameContact(target, name);
      identity.displayName = name;
      changed += 1;
    }
    if (changed) {
      for (const target of db().crmContacts) target.duplicates = (target.duplicates || []).filter((entry) => entry.reason !== "Mismo nombre en otro canal" || normalizeName(contact(entry.contactId)?.name) === normalizeName(target.name));
      broadcast("crm", { kind: "contacts" });
    }
    return changed;
  }

  // Repara nombres que eran un estado de conexión y sugerencias de unión por un nombre que ya no coincide.
  function repairNames() {
    let changed = 0;
    for (const target of db().crmContacts) {
      if (usableName(target.name)) continue;
      const identity = identitiesOf(target.id).find((item) => item.channel === "messenger");
      const chat = identity ? db().chats.find((item) => item.id === identity.externalId) : null;
      const name = usableName(chat?.name) || usableName(identity?.displayName) || "Sin nombre";
      if (identity && !usableName(identity.displayName) && usableName(name)) identity.displayName = name;
      if (name === target.name) continue;
      renameContact(target, name);
      changed += 1;
    }
    for (const target of db().crmContacts) {
      const before = (target.duplicates || []).length;
      target.duplicates = (target.duplicates || []).filter((entry) => entry.reason !== "Mismo nombre en otro canal" || normalizeName(contact(entry.contactId)?.name) === normalizeName(target.name));
      if (target.duplicates.length !== before) changed += 1;
    }
    return changed;
  }

  function setContactData(target, { phone, email }) {
    const cleanPhone = cleanText(phone, 40);
    if (cleanPhone && phoneKey(cleanPhone)) {
      if (!target.phone) target.phone = cleanPhone;
      ensureIdentity(target, "phone", phoneKey(cleanPhone), { displayName: cleanPhone });
    }
    const cleanEmail = cleanText(email, 200).toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
      if (!target.email) target.email = cleanEmail;
      ensureIdentity(target, "email", cleanEmail, { displayName: cleanEmail });
    }
  }

  async function updateContact(id, patch = {}, actor = null) {
    const target = contact(id);
    if (!target) throw new Error("Contacto no encontrado.");
    if (patch.name !== undefined && cleanText(patch.name, 120) && cleanText(patch.name, 120) !== target.name) {
      renameContact(target, cleanText(patch.name, 120));
      target.nameSource = "manual";
    }
    if (patch.company !== undefined) target.company = cleanText(patch.company, 120) || null;
    if (patch.notes !== undefined) target.notes = plain(patch.notes, 4_000);
    if (Array.isArray(patch.tags)) target.tags = [...new Set(patch.tags.map((tag) => cleanText(tag, 40)).filter(Boolean))].slice(0, 30);
    if (patch.phone !== undefined) {
      const previous = phoneKey(target.phone);
      target.phone = cleanText(patch.phone, 40) || null;
      if (previous && previous !== phoneKey(target.phone)) db().crmIdentities = db().crmIdentities.filter((item) => item.id !== identityId("phone", previous) || item.contactId !== target.id);
      setContactData(target, { phone: target.phone });
    }
    if (patch.email !== undefined) {
      const previous = target.email;
      target.email = cleanText(patch.email, 200).toLowerCase() || null;
      if (previous && previous !== target.email) db().crmIdentities = db().crmIdentities.filter((item) => item.id !== identityId("email", previous) || item.contactId !== target.id);
      setContactData(target, { email: target.email });
    }
    if (patch.consent && typeof patch.consent === "object") {
      target.consent = { ...(target.consent || {}) };
      for (const channel of ["sms", "whatsapp", "email", "messenger"]) {
        if (["granted", "denied", "unknown"].includes(patch.consent[channel])) {
          if (target.consent[channel]?.status !== patch.consent[channel]) target.consent[channel] = { status: patch.consent[channel], at: now(), by: actorName(actor) };
        }
      }
    }
    target.updatedAt = now();
    await persist();
    broadcast("crm", { kind: "contact", id });
    return target;
  }

  // Borra a la persona y todo lo suyo (tarjetas, mensajes, tareas, historial).
  async function deleteContact(id) {
    const target = contact(id);
    if (!target) throw new Error("Contacto no encontrado.");
    const cards = new Set(db().crmOpportunities.filter((item) => item.contactId === id).map((item) => item.id));
    db().crmContacts = db().crmContacts.filter((item) => item.id !== id);
    db().crmIdentities = db().crmIdentities.filter((item) => item.contactId !== id);
    db().crmOpportunities = db().crmOpportunities.filter((item) => item.contactId !== id);
    db().crmActivities = db().crmActivities.filter((item) => item.contactId !== id && !cards.has(item.opportunityId));
    db().crmTasks = db().crmTasks.filter((item) => item.contactId !== id && !cards.has(item.opportunityId));
    db().crmStageHistory = db().crmStageHistory.filter((item) => !cards.has(item.opportunityId));
    db().campaignRecipients = db().campaignRecipients.filter((item) => item.contactId !== id);
    for (const other of db().crmContacts) other.duplicates = (other.duplicates || []).filter((entry) => entry.contactId !== id);
    await persist();
    broadcast("crm", { kind: "contacts" });
    return { removedCards: cards.size };
  }

  async function dismissDuplicate(id, otherId) {
    const target = contact(id);
    const other = contact(otherId);
    for (const [left, right] of [[target, other], [other, target]]) {
      if (!left) continue;
      left.duplicates = (left.duplicates || []).filter((entry) => entry.contactId !== right?.id);
      left.dismissedDuplicates = [...new Set([...(left.dismissedDuplicates || []), right?.id].filter(Boolean))];
    }
    await persist();
  }

  // Unión supervisada: todo lo del contacto origen pasa al destino.
  async function mergeContacts(targetId, sourceId, actor = null) {
    const target = contact(targetId);
    const source = contact(sourceId);
    if (!target || !source || target.id === source.id) throw new Error("Elegí dos contactos distintos para unir.");
    for (const identity of db().crmIdentities) if (identity.contactId === source.id) identity.contactId = target.id;
    for (const opportunity of db().crmOpportunities) if (opportunity.contactId === source.id) opportunity.contactId = target.id;
    for (const activity of db().crmActivities) if (activity.contactId === source.id) activity.contactId = target.id;
    for (const task of db().crmTasks) if (task.contactId === source.id) task.contactId = target.id;
    for (const recipient of db().campaignRecipients) if (recipient.contactId === source.id) recipient.contactId = target.id;
    for (const key of ["phone", "email", "avatarUrl", "company"]) if (!target[key] && source[key]) target[key] = source[key];
    if (target.name === "Sin nombre" && source.name) target.name = source.name;
    target.tags = [...new Set([...(target.tags || []), ...(source.tags || [])])];
    target.consent = { ...(source.consent || {}), ...(target.consent || {}) };
    target.notes = [target.notes, source.notes].filter(Boolean).join("\n\n");
    target.duplicates = [...(target.duplicates || []), ...(source.duplicates || [])].filter((entry, index, list) => entry.contactId !== target.id && entry.contactId !== source.id && list.findIndex((other) => other.contactId === entry.contactId) === index);
    for (const other of db().crmContacts) other.duplicates = (other.duplicates || []).filter((entry) => entry.contactId !== source.id);
    db().crmContacts = db().crmContacts.filter((item) => item.id !== source.id);
    target.updatedAt = now();
    const opportunity = db().crmOpportunities.find((item) => item.contactId === target.id && item.status === "open");
    addActivity({ opportunityId: opportunity?.id || null, contactId: target.id, type: "system", text: `Contacto unido con “${source.name}” por ${actorName(actor)}.`, actor: actorName(actor) });
    await persist();
    broadcast("crm", { kind: "contacts" });
    return target;
  }

  /* ---------------------------------------------------------- Actividades */
  // externalId: identificador único del evento de origen (evita duplicados).
  function addActivity({ opportunityId = null, contactId = null, type, text = "", channel = null, url = null, externalId = null, actor = null, at = null, meta = null, mediaIds = [] }) {
    if (externalId && db().crmActivities.some((item) => item.externalId === externalId)) return null;
    const activity = { id: randomUUID(), opportunityId, contactId, type, text: plain(text, 5_000), channel, url, externalId, actor, at: at || now(), meta, mediaIds: Array.isArray(mediaIds) ? mediaIds.slice(0, 10) : [] };
    db().crmActivities.push(activity);
    return activity;
  }

  /* ---------------------------------------------------------- Oportunidades (tarjetas) */
  function opportunity(id) { return db().crmOpportunities.find((item) => item.id === id) || null; }

  function nextRank(stageId) {
    const ranks = db().crmOpportunities.filter((item) => item.stageId === stageId).map((item) => Number(item.rank) || 0);
    return ranks.length ? Math.min(...ranks) - 1 : 0;
  }

  // Tablero de destino: el de la publicación de origen, el que tenga una palabra
  // clave en el texto, o el tablero por defecto.
  function routeFor({ publicationId = null, text = "", boardId = null, stageId = null, agent = null }) {
    const valid = (id) => { const item = board(id); return item && !item.archived ? item : null; };
    if (valid(boardId)) return { boardId, stageId: stage(stageId)?.boardId === boardId ? stageId : null, agent, reason: "manual" };
    const publication = publicationId ? db().publications.find((item) => item.id === publicationId) : null;
    const routing = publication?.ai?.crm;
    if (routing?.boardId && valid(routing.boardId)) return { boardId: routing.boardId, stageId: stage(routing.stageId)?.boardId === routing.boardId ? routing.stageId : null, agent: routing.agent || null, department: routing.department || null, reason: "publicación" };
    const haystack = normalizeName(text);
    const byKeyword = db().crmBoards.find((item) => !item.archived && (item.routingKeywords || []).some((keyword) => haystack.includes(normalizeName(keyword))));
    if (byKeyword) return { boardId: byKeyword.id, stageId: null, agent: null, reason: "palabra clave" };
    const fallback = valid(settings().defaultBoardId) || db().crmBoards.find((item) => !item.archived);
    return { boardId: fallback?.id || null, stageId: null, agent: null, reason: "tablero por defecto" };
  }

  function createOpportunity({ contact: target, route, title, source = {}, value = null, product = null, priority = "normal", tags = [], actor = null }) {
    const destination = board(route.boardId);
    if (!destination) throw new Error("No hay un tablero de destino.");
    const firstColumn = stage(route.stageId) || firstStage(destination.id);
    if (!firstColumn) throw new Error("El tablero no tiene columnas.");
    const item = {
      id: randomUUID(),
      boardId: destination.id,
      pipelineId: firstColumn.pipelineId,
      stageId: firstColumn.id,
      contactId: target.id,
      title: cleanText(title, 160) || target.name,
      value: Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : null,
      currency: "PYG",
      product: cleanText(product, 160) || null,
      priority: ["low", "normal", "high"].includes(priority) ? priority : "normal",
      tags: tags.map((tag) => cleanText(tag, 40)).filter(Boolean),
      agent: cleanText(route.agent, 80) || null,
      department: cleanText(route.department, 80) || null,
      status: firstColumn.kind === "won" ? "won" : firstColumn.kind === "lost" ? "lost" : "open",
      source: { ...source, routedBy: route.reason || null },
      lastMessage: null,
      milestones: { new: now() },
      rank: nextRank(firstColumn.id),
      createdAt: now(),
      updatedAt: now(),
      stageChangedAt: now(),
      createdBy: actorName(actor),
    };
    db().crmOpportunities.push(item);
    db().crmStageHistory.push({ id: randomUUID(), opportunityId: item.id, boardId: item.boardId, fromStageId: null, toStageId: firstColumn.id, fromName: null, toName: firstColumn.name, actor: item.createdBy, reason: source.channel ? `Creada desde ${CRM_CHANNELS[source.channel] || source.channel}` : "Creada", at: now() });
    return item;
  }

  // Reusa la tarjeta abierta del contacto: si vuelve a escribir no se crea otra.
  // Solo una consulta que llega por una publicación con tablero propio (o una
  // carga manual) abre otra tarjeta en ese tablero: es otro interés.
  function ensureCard({ identity, route, title, source, actor = null, existingContact = null }) {
    const target = existingContact || upsertContact(identity);
    if (existingContact) {
      if (identity.externalId) ensureIdentity(target, identity.channel, identity.externalId, { displayName: identity.displayName || identity.name, url: identity.url });
      setContactData(target, identity);
    }
    const open = db().crmOpportunities.filter((item) => item.contactId === target.id && item.status === "open").sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const strongRoute = ["publicación", "manual"].includes(route.reason);
    const existing = open.find((item) => item.boardId === route.boardId) || (strongRoute ? null : open[0]);
    if (existing) {
      existing.updatedAt = now();
      return { contact: target, opportunity: existing, created: false };
    }
    return { contact: target, opportunity: createOpportunity({ contact: target, route, title, source, actor }), created: true };
  }

  function applyMove(item, target, { actor = null, reason = "" } = {}) {
    const from = stage(item.stageId);
    if (from?.id === target.id) return null;
    item.stageId = target.id;
    item.pipelineId = target.pipelineId;
    item.boardId = target.boardId;
    item.status = target.kind === "won" ? "won" : target.kind === "lost" ? "lost" : "open";
    item.closedAt = item.status === "open" ? null : now();
    if (item.status === "lost") item.lostReason = cleanText(reason, 300) || item.lostReason || null;
    item.milestones = { ...(item.milestones || {}) };
    if (MILESTONES.includes(target.kind) && !item.milestones[target.kind]) item.milestones[target.kind] = now();
    item.stageChangedAt = now();
    item.updatedAt = now();
    const entry = { id: randomUUID(), opportunityId: item.id, boardId: item.boardId, fromStageId: from?.id || null, toStageId: target.id, fromName: from?.name || null, toName: target.name, actor: actorName(actor), reason: cleanText(reason, 300) || null, at: now() };
    db().crmStageHistory.push(entry);
    return entry;
  }

  async function moveOpportunity(id, { stageId, beforeId = null, reason = "", actor = null } = {}) {
    const item = opportunity(id);
    if (!item) throw new Error("Tarjeta no encontrada.");
    const target = stage(stageId);
    if (!target) throw new Error("Columna no encontrada.");
    const entry = applyMove(item, target, { actor, reason });
    // Orden dentro de la columna: se inserta antes de beforeId (o al final).
    const column = db().crmOpportunities.filter((other) => other.stageId === target.id && other.id !== item.id).sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));
    const index = beforeId ? column.findIndex((other) => other.id === beforeId) : -1;
    column.splice(index === -1 ? column.length : index, 0, item);
    column.forEach((other, position) => { other.rank = position; });
    await persist();
    broadcast("crm", { kind: "moved", id: item.id, stageId: target.id });
    return { opportunity: item, history: entry };
  }

  async function updateOpportunity(id, patch = {}, actor = null) {
    const item = opportunity(id);
    if (!item) throw new Error("Tarjeta no encontrada.");
    const changes = [];
    if (patch.title !== undefined) item.title = cleanText(patch.title, 160) || item.title;
    if (patch.value !== undefined) item.value = patch.value === null || patch.value === "" || !Number.isFinite(Number(patch.value)) ? null : Number(patch.value);
    if (patch.product !== undefined) item.product = cleanText(patch.product, 160) || null;
    if (patch.priority !== undefined && ["low", "normal", "high"].includes(patch.priority)) item.priority = patch.priority;
    if (Array.isArray(patch.tags)) item.tags = [...new Set(patch.tags.map((tag) => cleanText(tag, 40)).filter(Boolean))].slice(0, 20);
    if (patch.agent !== undefined && cleanText(patch.agent, 80) !== (item.agent || "")) { item.agent = cleanText(patch.agent, 80) || null; changes.push(`Responsable: ${item.agent || "sin asignar"}`); }
    if (patch.department !== undefined) item.department = cleanText(patch.department, 80) || null;
    if (patch.lostReason !== undefined) item.lostReason = cleanText(patch.lostReason, 300) || null;
    item.updatedAt = now();
    if (changes.length) addActivity({ opportunityId: item.id, contactId: item.contactId, type: "system", text: changes.join(" · "), actor: actorName(actor) });
    await persist();
    broadcast("crm", { kind: "updated", id: item.id });
    return item;
  }

  async function deleteOpportunity(id) {
    const item = opportunity(id);
    if (!item) throw new Error("Tarjeta no encontrada.");
    db().crmOpportunities = db().crmOpportunities.filter((entry) => entry.id !== id);
    for (const task of db().crmTasks) if (task.opportunityId === id && task.status === "open") Object.assign(task, { status: "cancelled", completedAt: now(), result: "Tarjeta eliminada." });
    await persist();
    broadcast("crm", { kind: "deleted", id });
  }

  async function createManual(input = {}, actor = null) {
    const name = cleanText(input.name, 120);
    if (!name && !input.phone && !input.email) throw new Error("Poné al menos el nombre, un teléfono o un correo.");
    const route = routeFor({ boardId: input.boardId, stageId: input.stageId, agent: input.agent, text: `${input.title || ""} ${input.product || ""}` });
    const target = upsertContact({ channel: "manual", externalId: null, name, phone: input.phone, email: input.email });
    const item = createOpportunity({ contact: target, route: { ...route, agent: input.agent || route.agent }, title: input.title || name, source: { channel: "manual", text: plain(input.note, 1_000) || null }, value: input.value, product: input.product, priority: input.priority, actor });
    if (input.note) addActivity({ opportunityId: item.id, contactId: target.id, type: "note", text: input.note, actor: actorName(actor) });
    await persist();
    broadcast("crm", { kind: "created", id: item.id });
    return item;
  }

  async function addNote(id, { text, kind = "note", mediaIds = [], actor = null } = {}) {
    const item = opportunity(id);
    if (!item) throw new Error("Tarjeta no encontrada.");
    const type = ["note", "call", "quote", "file"].includes(kind) ? kind : "note";
    if (!plain(text) && !mediaIds.length) throw new Error("Escribí la nota o adjuntá un archivo.");
    const activity = addActivity({ opportunityId: item.id, contactId: item.contactId, type, text, actor: actorName(actor), mediaIds });
    if (type === "quote" && item.milestones && !item.milestones.quote) item.milestones.quote = now();
    item.updatedAt = now();
    await persist();
    broadcast("crm", { kind: "updated", id: item.id });
    return activity;
  }

  async function setHistoryReason(id, reason) {
    const entry = db().crmStageHistory.find((item) => item.id === id);
    if (!entry) throw new Error("Movimiento no encontrado.");
    entry.reason = cleanText(reason, 300) || null;
    const item = opportunity(entry.opportunityId);
    if (item?.status === "lost" && stage(entry.toStageId)?.kind === "lost") item.lostReason = entry.reason;
    await persist();
    return entry;
  }

  /* ---------------------------------------------------------- Tareas de seguimiento */
  async function saveTask(input = {}, actor = null) {
    let task = db().crmTasks.find((item) => item.id === input.id);
    if (!task) {
      const item = opportunity(input.opportunityId);
      if (!item) throw new Error("Tarjeta no encontrada.");
      const title = cleanText(input.title, 200);
      const dueAt = Date.parse(input.dueAt);
      if (!title) throw new Error("Describí la próxima acción.");
      if (Number.isNaN(dueAt)) throw new Error("Elegí fecha y hora del seguimiento.");
      task = { id: randomUUID(), opportunityId: item.id, contactId: item.contactId, title, dueAt: new Date(dueAt).toISOString(), agent: cleanText(input.agent, 80) || item.agent || null, status: "open", result: null, notifiedAt: null, createdAt: now(), createdBy: actorName(actor) };
      db().crmTasks.push(task);
      addActivity({ opportunityId: item.id, contactId: item.contactId, type: "task", text: `Seguimiento programado: ${title} (${new Date(dueAt).toLocaleString("es-PY", { dateStyle: "medium", timeStyle: "short" })})`, actor: actorName(actor) });
      item.updatedAt = now();
    } else {
      if (input.title !== undefined) task.title = cleanText(input.title, 200) || task.title;
      if (input.dueAt !== undefined && !Number.isNaN(Date.parse(input.dueAt))) { task.dueAt = new Date(input.dueAt).toISOString(); task.notifiedAt = null; }
      if (input.agent !== undefined) task.agent = cleanText(input.agent, 80) || null;
      if (["done", "cancelled", "open"].includes(input.status) && input.status !== task.status) {
        task.status = input.status;
        task.result = plain(input.result, 1_000) || task.result;
        task.completedAt = input.status === "open" ? null : now();
        task.completedBy = input.status === "open" ? null : actorName(actor);
        const item = opportunity(task.opportunityId);
        if (item && input.status !== "open") addActivity({ opportunityId: item.id, contactId: item.contactId, type: "task", text: `${input.status === "done" ? "Seguimiento hecho" : "Seguimiento cancelado"}: ${task.title}${task.result ? ` — Resultado: ${task.result}` : ""}`, actor: actorName(actor) });
      }
    }
    await persist();
    broadcast("crm", { kind: "tasks", id: task.id });
    return task;
  }

  function nextTaskOf(opportunityId) {
    return db().crmTasks.filter((task) => task.opportunityId === opportunityId && task.status === "open").sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0] || null;
  }

  // "Volver a contactar el jueves a las 10:00": avisa una vez al vencer.
  async function tickTasks() {
    const due = db().crmTasks.filter((task) => task.status === "open" && !task.notifiedAt && Date.parse(task.dueAt) <= nowMs());
    if (!due.length) return;
    for (const task of due) {
      task.notifiedAt = now();
      const item = opportunity(task.opportunityId);
      broadcast("crm", { kind: "task-due", task: { id: task.id, title: task.title, dueAt: task.dueAt, agent: task.agent, opportunityId: task.opportunityId, contactName: contact(task.contactId)?.name || item?.title || "" } });
    }
    await persist();
  }

  /* ---------------------------------------------------------- Captura automática */
  function chatForEvent(event) {
    return db().chats.find((item) => item.url === event.url || event.externalId?.startsWith(`${item.id}:`)) || null;
  }

  function personFromNotification(text) {
    const clean = String(text || "").replace(/^No leída\s+/i, "");
    const name = clean.match(/^(.{2,80}?)\s+(?:y\s+(?:\d+|otras?)\s+personas?\s+más\s+)?(?:comentó|comentaron|respondió|respondieron|te mencionó|mencionó|te etiquetó|commented|replied|mentioned)/i)?.[1]?.trim() || null;
    const quote = clean.match(/[“"«]([^”"»]{2,400})[”"»]/)?.[1]?.trim() || null;
    return { name, quote };
  }

  function publicationByText(text) {
    let best = null;
    for (const item of db().publications) {
      if (item.status !== "published") continue;
      const score = similarity(text, item.text);
      if (!best || score > best.score) best = { item, score };
    }
    return best && best.score >= 0.6 ? best.item : null;
  }

  // Llamado por cada aviso nuevo (Messenger y notificaciones de Facebook).
  async function captureEvent(event) {
    const config = settings();
    const eventKey = `event:${event.key || `${event.source}:${event.externalId}`}`;
    if (event.source === "messenger") {
      if (!config.capture.messenger) return null;
      const chat = chatForEvent(event);
      const chatId = chat?.id || String(event.externalId || "").split(":")[0];
      if (!chatId) return null;
      const text = cleanText(chat?.lastMessage || chat?.preview || event.text, 2_000);
      // La vista previa "Tú: …" es un mensaje propio: solo se registra si ya hay tarjeta.
      if (/(^|·\s*)(tú|you):/i.test(event.text || "")) {
        const known = contactByIdentity("messenger", chatId);
        const item = known && db().crmOpportunities.find((entry) => entry.contactId === known.id && entry.status === "open");
        if (item && addActivity({ opportunityId: item.id, contactId: known.id, type: "message_out", channel: "messenger", text: text.replace(/^(tú|you):\s*/i, ""), url: chat?.url || event.url, externalId: eventKey })) {
          item.lastMessage = { text: text.replace(/^(tú|you):\s*/i, ""), at: now(), direction: "out" };
          item.milestones = { ...(item.milestones || {}), contacted: item.milestones?.contacted || now() };
          await persist();
          broadcast("crm", { kind: "updated", id: item.id });
        }
        return null;
      }
      if (db().crmActivities.some((item) => item.externalId === eventKey)) return null;
      const route = routeFor({ text });
      if (!route.boardId) return null;
      const { contact: target, opportunity: item, created } = ensureCard({
        identity: { channel: "messenger", externalId: chatId, name: chat?.name, avatarUrl: chat?.avatarUrl || event.avatarUrl, url: chat?.url || event.url },
        route,
        title: chat?.name || "Conversación de Messenger",
        source: { channel: "messenger", network: "facebook", text, url: chat?.url || event.url, eventId: event.id, chatId },
      });
      item.chatId = item.chatId || chatId;
      const identity = db().crmIdentities.find((entry) => entry.id === identityId("messenger", chatId));
      if (identity) identity.lastInboundAt = now();
      addActivity({ opportunityId: item.id, contactId: target.id, type: "message_in", channel: "messenger", text, url: chat?.url || event.url, externalId: eventKey });
      item.lastMessage = { text, at: now(), direction: "in" };
      await persist();
      broadcast("crm", { kind: created ? "created" : "updated", id: item.id, contactName: target.name, channel: "messenger" });
      return item;
    }
    if (["comment", "mention"].includes(event.kind)) {
      if (!config.capture.comments) return null;
      const { name, quote } = personFromNotification(event.text);
      // Sin el texto del comentario no se sabe si es una consulta: lo decide la IA después.
      if (!name || !INTEREST.test(quote || "")) return null;
      return captureComment({ eventKey, name, text: quote, url: event.url, avatarUrl: event.avatarUrl, eventId: event.id, channel: event.kind });
    }
    if (["reaction", "share"].includes(event.kind) && config.capture.reactions) {
      // Métrica de la publicación: no crea tarjetas ni habilita escribirle a la persona.
      const quote = personFromNotification(event.text).quote || event.text;
      const publication = publicationByText(quote);
      if (!publication) return null;
      // "A Pedro y 4 personas más" = 5; "A Pedro y Ana" = 2; "A Pedro" = 1.
      const others = Number(String(event.text).match(/y\s+(\d+)\s+personas?\s+más/i)?.[1] || 0);
      const head = String(event.text).split(/les gusta|le gusta|reaccion|compart/i)[0];
      const people = others ? others + 1 : /\sy\s/.test(head) ? 2 : 1;
      publication.metrics = { ...(publication.metrics || {}) };
      publication.metrics[event.kind === "share" ? "shares" : "reactions"] = (publication.metrics[event.kind === "share" ? "shares" : "reactions"] || 0) + people;
      await persist();
      return null;
    }
    return null;
  }

  async function captureComment({ eventKey, name, text, url, avatarUrl = null, eventId = null, channel = "comment", post = null, publication = null, account = null, interactionId = null, category = null, boardId = null }) {
    const route = routeFor({ boardId, publicationId: publication?.kind === "niro" ? publication.id : null, text: `${text} ${post?.text || ""}` });
    if (!route.boardId) return null;
    const { contact: target, opportunity: item, created } = ensureCard({
      identity: { channel: "facebook_name", externalId: normalizeName(name), name, avatarUrl, displayName: name },
      route,
      title: name,
      source: { channel, network: "facebook", text, url, eventId, postUrl: post?.url || url, postText: post?.text?.slice(0, 600) || null, publicationId: publication?.kind === "niro" ? publication.id : null, campaign: publication?.campaign || null, account: account?.name || null, interactionId, category },
    });
    const added = addActivity({ opportunityId: item.id, contactId: target.id, type: "comment", channel, text, url, externalId: eventKey, meta: { postUrl: post?.url || null, postText: post?.text?.slice(0, 300) || null } });
    if (added) item.lastMessage = { text, at: now(), direction: "in" };
    await persist();
    broadcast("crm", { kind: created ? "created" : "updated", id: item.id, contactName: target.name, channel });
    return item;
  }

  // La IA completa lo que la notificación no trae: texto real del comentario,
  // categoría, publicación de origen y datos de contacto aportados.
  async function onInteraction(interaction) {
    const config = settings();
    if (!interaction?.dedupeKey) return null;
    const eventKey = `event:${interaction.dedupeKey}`;
    if (interaction.channel === "messenger") {
      const chatId = String(interaction.threadKey || "").replace(/^chat:/, "");
      const target = contactByIdentity("messenger", chatId);
      if (!target) return null;
      if (interaction.person?.name && target.name === "Sin nombre") target.name = interaction.person.name;
      if (interaction.lead?.is_lead) setContactData(target, interaction.lead);
      const item = db().crmOpportunities.find((entry) => entry.contactId === target.id && entry.status === "open");
      if (item && interaction.category && !item.source?.category) item.source = { ...item.source, category: interaction.category };
      if (item && interaction.lead?.interest && !item.product) item.product = cleanText(interaction.lead.interest, 160);
      await persist();
      return item || null;
    }
    if (!["comment", "mention"].includes(interaction.channel) || !config.capture.comments) return null;
    const interested = INTEREST_CATEGORIES.includes(interaction.category) || interaction.lead?.is_lead;
    const existing = db().crmActivities.find((item) => item.externalId === eventKey);
    if (!interested && !existing) return null;
    const name = interaction.person?.name;
    if (!name) return null;
    const item = existing ? opportunity(existing.opportunityId) : await captureComment({
      eventKey, name, text: interaction.text || interaction.notificationText, url: interaction.url, avatarUrl: interaction.person?.avatarUrl,
      eventId: interaction.eventId, channel: interaction.channel, post: interaction.post, publication: interaction.publication, account: interaction.account,
      interactionId: interaction.id, category: interaction.category,
    });
    if (!item) return null;
    if (existing && interaction.text) existing.text = plain(interaction.text, 5_000);
    item.source = { ...item.source, category: interaction.category || item.source?.category || null, interactionId: interaction.id, postUrl: interaction.post?.url || item.source?.postUrl || null, postText: interaction.post?.text?.slice(0, 600) || item.source?.postText || null, publicationId: interaction.publication?.kind === "niro" ? interaction.publication.id : item.source?.publicationId || null, campaign: interaction.publication?.campaign || item.source?.campaign || null, account: interaction.account?.name || item.source?.account || null };
    const target = contact(item.contactId);
    if (target && interaction.lead?.is_lead) setContactData(target, interaction.lead);
    if (interaction.lead?.interest && !item.product) item.product = cleanText(interaction.lead.interest, 160);
    if (interaction.status === "sent" && (interaction.sentText || interaction.finalReply)) {
      if (addActivity({ opportunityId: item.id, contactId: item.contactId, type: "reply", channel: interaction.channel, text: interaction.sentText || interaction.finalReply, url: interaction.url, externalId: `reply:${interaction.id}`, actor: interaction.approvedBy || "Niro" })) {
        item.milestones = { ...(item.milestones || {}), contacted: item.milestones?.contacted || now() };
      }
    }
    item.updatedAt = now();
    await persist();
    broadcast("crm", { kind: "updated", id: item.id });
    return item;
  }

  // "Enviar conversación al CRM" desde Messenger.
  async function captureChat(chatId, { boardId = null, actor = null } = {}) {
    const chat = db().chats.find((item) => item.id === chatId);
    if (!chat) throw new Error("Chat no encontrado.");
    const route = routeFor({ boardId, text: chat.lastMessage || chat.preview || "" });
    if (!route.boardId) throw new Error("Creá un tablero antes de enviar conversaciones.");
    const { contact: target, opportunity: item, created } = ensureCard({
      identity: { channel: "messenger", externalId: chat.id, name: chat.name, avatarUrl: chat.avatarUrl, url: chat.url },
      route,
      title: chat.name || "Conversación de Messenger",
      source: { channel: "messenger", network: "facebook", text: cleanText(chat.lastMessage || chat.preview, 600), url: chat.url, chatId: chat.id },
      actor,
    });
    item.chatId = chat.id;
    if (!item.lastMessage && (chat.lastMessage || chat.preview)) item.lastMessage = { text: cleanText(chat.lastMessage || chat.preview, 600), at: chat.lastSeenAt || now(), direction: "in" };
    addActivity({ opportunityId: item.id, contactId: target.id, type: "system", text: created ? `Conversación enviada al CRM por ${actorName(actor)}.` : `Conversación vinculada de nuevo por ${actorName(actor)}.`, actor: actorName(actor) });
    await persist();
    broadcast("crm", { kind: created ? "created" : "updated", id: item.id });
    return { opportunity: item, created };
  }

  // "Enviar al CRM" desde un aviso: un mensaje vincula la conversación; un
  // comentario o mención crea el interés aunque no traiga palabras clave.
  async function captureEventManual(eventId, { boardId = null, actor = null } = {}) {
    const event = db().events.find((item) => item.id === eventId);
    if (!event) throw new Error("Aviso no encontrado.");
    if (event.source === "messenger") {
      const chat = chatForEvent(event);
      if (!chat) throw new Error("Sincronizá la lista de chats para vincular esta conversación.");
      return captureChat(chat.id, { boardId, actor });
    }
    if (!["comment", "mention"].includes(event.kind)) throw new Error("Solo los comentarios, menciones y mensajes pueden ir al CRM: un «me gusta» no identifica a alguien con quien conversar.");
    const { name, quote } = personFromNotification(event.text);
    if (!name) throw new Error("No pude identificar a la persona en este aviso.");
    const eventKey = `event:${event.key || `${event.source}:${event.externalId}`}`;
    const already = db().crmActivities.find((item) => item.externalId === eventKey);
    if (already?.opportunityId && opportunity(already.opportunityId)) return { opportunity: opportunity(already.opportunityId), created: false };
    const item = await captureComment({ eventKey, name, text: quote || event.text, url: event.url, avatarUrl: event.avatarUrl, eventId: event.id, channel: event.kind, boardId });
    if (!item) throw new Error("No hay un tablero de destino.");
    addActivity({ opportunityId: item.id, contactId: item.contactId, type: "system", text: `Enviado al CRM desde Notificaciones por ${actorName(actor)}.`, actor: actorName(actor) });
    await persist();
    return { opportunity: item, created: true };
  }

  // Respuesta enviada desde el panel (Messenger o comentario): queda en la tarjeta.
  async function recordReply(event, text, actor = null) {
    if (!event) return null;
    const eventKey = `event:${event.key || `${event.source}:${event.externalId}`}`;
    let item = null;
    if (event.source === "messenger") {
      const chat = chatForEvent(event);
      const target = chat && contactByIdentity("messenger", chat.id);
      item = target && db().crmOpportunities.find((entry) => entry.contactId === target.id && entry.status === "open");
    } else {
      const activity = db().crmActivities.find((entry) => entry.externalId === eventKey);
      item = activity && opportunity(activity.opportunityId);
    }
    if (!item) return null;
    addActivity({ opportunityId: item.id, contactId: item.contactId, type: event.source === "messenger" ? "message_out" : "reply", channel: event.source === "messenger" ? "messenger" : "comment", text, url: event.url, actor: actorName(actor) });
    item.lastMessage = { text: cleanText(text, 600), at: now(), direction: "out" };
    item.milestones = { ...(item.milestones || {}), contacted: item.milestones?.contacted || now() };
    item.updatedAt = now();
    await persist();
    broadcast("crm", { kind: "updated", id: item.id });
    return item;
  }

  // Formularios de anuncios (Meta, Google Ads) y formularios web propios.
  async function captureLead({ provider, leadId, name, phone, email, fields = [], attribution = {}, boardId = null, stageId = null, receivedAt = null }) {
    const channel = { meta: "meta_form", google: "google_form", web: "web_form" }[provider] || "web_form";
    const externalId = leadId ? `${provider}:${leadId}` : null;
    const eventKey = externalId ? `lead:${externalId}` : null;
    if (eventKey && db().crmActivities.some((item) => item.externalId === eventKey)) return { duplicate: true };
    const route = routeFor({ boardId: boardId || attribution.boardId, stageId, text: [attribution.campaign, attribution.formName, attribution.adName].filter(Boolean).join(" ") });
    if (!route.boardId) throw new Error("No hay un tablero de destino para el formulario.");
    // Misma persona que ya completó un formulario del mismo tipo (teléfono o correo): se reusa.
    // Entre canales distintos la unión queda como sugerencia supervisada.
    const cleanEmail = cleanText(email, 200).toLowerCase();
    const known = [phoneKey(phone) && contactByIdentity("phone", phoneKey(phone)), cleanEmail && contactByIdentity("email", cleanEmail)]
      .find((candidate) => candidate && identitiesOf(candidate.id).some((identity) => identity.channel === channel)) || null;
    const { contact: target, opportunity: item, created } = ensureCard({
      existingContact: known,
      identity: { channel, externalId: leadId ? `${provider}:${leadId}` : null, name, phone, email, displayName: name },
      route,
      title: name || phone || email || "Prospecto de formulario",
      source: { channel, network: provider === "google" ? "google" : provider === "meta" ? "meta" : "web", campaign: attribution.campaign || null, campaignId: attribution.campaignId || null, adId: attribution.adId || null, adName: attribution.adName || null, formId: attribution.formId || null, formName: attribution.formName || null, pageId: attribution.pageId || null, leadId: leadId || null, text: fields.map((field) => `${field.name}: ${field.value}`).join("\n").slice(0, 1_500) },
    });
    addActivity({ opportunityId: item.id, contactId: target.id, type: "form", channel, text: fields.map((field) => `${field.name}: ${field.value}`).join("\n") || "Formulario recibido sin campos.", externalId: eventKey, at: receivedAt || now(), meta: { attribution, fields } });
    item.lastMessage = { text: `Formulario: ${fields.slice(0, 3).map((field) => field.value).join(" · ")}`.slice(0, 300), at: now(), direction: "in" };
    ensureCampaignSource({ kind: provider === "web" ? "web" : "ad", network: provider, campaign: attribution.campaign || null, campaignId: attribution.campaignId || null, adId: attribution.adId || null, formId: attribution.formId || null, label: attribution.formName || attribution.adName || attribution.campaign || CRM_CHANNELS[channel] });
    await persist();
    broadcast("crm", { kind: created ? "created" : "updated", id: item.id, contactName: target.name, channel });
    return { opportunity: item, created };
  }

  /* ---------------------------------------------------------- Fuentes de campaña */
  function ensureCampaignSource(input) {
    const key = [input.kind, input.network, input.publicationId || input.scheduleId || input.formId || input.adId || input.campaignId || input.campaign || input.label].filter(Boolean).join(":");
    let source = db().campaignSources.find((item) => item.key === key);
    if (!source) {
      source = { id: randomUUID(), key, createdAt: now() };
      db().campaignSources.push(source);
    }
    Object.assign(source, Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)), { updatedAt: now() });
    return source;
  }

  // Cada publicación con "Enviar interesados al tablero" queda como fuente de campaña.
  function registerPublication(publication) {
    const routing = publication?.ai?.crm;
    if (!routing?.boardId && !publication?.ai?.campaign) return null;
    return ensureCampaignSource({ kind: "publication", network: publication.target?.type === "instagram" ? "instagram" : "facebook", publicationId: publication.id, scheduleId: publication.scheduleId || null, account: publication.target?.name || null, campaign: publication.ai?.campaign || null, url: publication.url || null, text: String(publication.text || "").slice(0, 300), boardId: routing?.boardId || null, stageId: routing?.stageId || null, agent: routing?.agent || null, label: String(publication.text || "").slice(0, 80) });
  }

  // Normaliza la configuración "Enviar interesados al tablero" del editor de Autopost.
  function sanitizeRouting(input) {
    if (!input || typeof input !== "object" || !input.boardId) return null;
    const target = board(input.boardId);
    if (!target) return null;
    const column = stage(input.stageId);
    return { boardId: target.id, stageId: column?.boardId === target.id ? column.id : null, agent: cleanText(input.agent, 80) || null, department: cleanText(input.department, 80) || null };
  }

  /* ---------------------------------------------------------- Campañas dirigidas */
  function lastContactAt(contactId) {
    return db().crmActivities.filter((item) => item.contactId === contactId && ["message_in", "message_out", "comment", "reply", "form", "call"].includes(item.type)).map((item) => item.at).sort().at(-1) || null;
  }

  function availability(target, channel, requireConsent) {
    const consent = target.consent?.[channel]?.status || "unknown";
    if (consent === "denied") return { ok: false, reason: "Pidió no recibir mensajes por este canal" };
    if (["sms", "whatsapp"].includes(channel)) {
      if (!phoneKey(target.phone)) return { ok: false, reason: "Sin teléfono" };
      if (requireConsent && consent !== "granted") return { ok: false, reason: "Sin autorización registrada para este canal" };
      return { ok: true };
    }
    if (channel === "email") {
      if (!target.email) return { ok: false, reason: "Sin correo" };
      if (requireConsent && consent !== "granted") return { ok: false, reason: "Sin autorización registrada para este canal" };
      return { ok: true };
    }
    if (channel === "messenger") {
      const identity = identitiesOf(target.id).find((item) => item.channel === "messenger");
      if (!identity) return { ok: false, reason: "Sin conversación de Messenger" };
      // Meta: ventana estándar de 24 h desde el último mensaje de la persona.
      if (!identity.lastInboundAt || nowMs() - Date.parse(identity.lastInboundAt) > DAY) return { ok: false, reason: "Fuera de la ventana de 24 h de Messenger" };
      return { ok: true };
    }
    return { ok: false, reason: "Canal no disponible" };
  }

  function selectRecipients(filters = {}) {
    const stageIds = new Set(Array.isArray(filters.stageIds) ? filters.stageIds : []);
    const tags = (Array.isArray(filters.tags) ? filters.tags : []).map((tag) => tag.toLowerCase());
    const product = String(filters.product || "").toLowerCase().trim();
    const source = String(filters.source || "").trim();
    const from = filters.lastContactFrom ? Date.parse(`${filters.lastContactFrom}T00:00:00`) : null;
    const to = filters.lastContactTo ? Date.parse(`${filters.lastContactTo}T23:59:59`) : null;
    const byContact = new Map();
    for (const item of db().crmOpportunities) {
      if (filters.boardId && item.boardId !== filters.boardId) continue;
      if (stageIds.size && !stageIds.has(item.stageId)) continue;
      if (product && !String(item.product || "").toLowerCase().includes(product)) continue;
      if (source && ![item.source?.publicationId, item.source?.campaign, item.source?.formId, item.source?.campaignId].includes(source)) continue;
      const target = contact(item.contactId);
      if (!target) continue;
      const allTags = [...(item.tags || []), ...(target.tags || [])].map((tag) => tag.toLowerCase());
      if (tags.length && !tags.every((tag) => allTags.includes(tag))) continue;
      const current = byContact.get(target.id);
      if (!current || String(item.updatedAt) > String(current.opportunity.updatedAt)) byContact.set(target.id, { contact: target, opportunity: item });
    }
    const rows = [];
    for (const { contact: target, opportunity: item } of byContact.values()) {
      const last = lastContactAt(target.id);
      if ((from || to) && (!last || (from && Date.parse(last) < from) || (to && Date.parse(last) > to))) continue;
      const check = availability(target, filters.channel || "whatsapp", filters.requireConsent !== false);
      rows.push({ contactId: target.id, opportunityId: item.id, name: target.name, phone: target.phone, email: target.email, stage: stage(item.stageId)?.name || "", lastContactAt: last, available: check.ok, reason: check.reason || null });
    }
    return rows.sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name));
  }

  function previewCampaign(filters = {}) {
    const rows = selectRecipients(filters);
    const excluded = {};
    for (const row of rows) if (!row.available) excluded[row.reason] = (excluded[row.reason] || 0) + 1;
    return { total: rows.length, available: rows.filter((row) => row.available).length, excluded, rows: rows.slice(0, 300) };
  }

  async function saveCampaign(input = {}, actor = null) {
    const name = cleanText(input.name, 120);
    if (!name) throw new Error("Poné un nombre a la campaña.");
    const channel = ["sms", "whatsapp", "email", "messenger"].includes(input.filters?.channel) ? input.filters.channel : "whatsapp";
    const rows = selectRecipients({ ...input.filters, channel });
    if (!rows.length) throw new Error("La selección no tiene contactos.");
    const campaign = { id: randomUUID(), name, channel, message: plain(input.message, 2_000) || null, filters: { ...input.filters, channel }, total: rows.length, available: rows.filter((row) => row.available).length, status: "ready", createdAt: now(), createdBy: actorName(actor) };
    db().crmCampaigns.unshift(campaign);
    for (const row of rows) {
      db().campaignRecipients.push({ id: randomUUID(), campaignId: campaign.id, contactId: row.contactId, opportunityId: row.opportunityId, channel, status: row.available ? "eligible" : "excluded", reason: row.reason, createdAt: now() });
      if (row.available) addActivity({ opportunityId: row.opportunityId, contactId: row.contactId, type: "campaign", channel, text: `Incluido en la campaña “${name}” (${channel}).`, actor: actorName(actor), externalId: `campaign:${campaign.id}:${row.contactId}` });
    }
    await persist();
    broadcast("crm", { kind: "campaigns" });
    return campaign;
  }

  function campaignRecipients(campaignId) {
    return db().campaignRecipients.filter((item) => item.campaignId === campaignId).map((item) => {
      const target = contact(item.contactId);
      return { ...item, name: target?.name || "(contacto eliminado)", phone: target?.phone || null, email: target?.email || null };
    });
  }

  /* ---------------------------------------------------------- Reportes */
  function reports({ boardId = null, from = null, to = null } = {}) {
    const start = from ? Date.parse(`${from}T00:00:00`) : null;
    const end = to ? Date.parse(`${to}T23:59:59`) : null;
    const inRange = (value) => (!start || Date.parse(value) >= start) && (!end || Date.parse(value) <= end);
    const cards = db().crmOpportunities.filter((item) => (!boardId || item.boardId === boardId) && inRange(item.createdAt));
    const reached = (item, kinds) => kinds.some((kind) => item.milestones?.[kind]) || kinds.includes(stage(item.stageId)?.kind);
    const summarize = (list) => ({
      interested: list.length,
      contacted: list.filter((item) => reached(item, ["contacted", "quote", "followup", "won"])).length,
      quotes: list.filter((item) => reached(item, ["quote", "followup", "won"])).length,
      won: list.filter((item) => item.status === "won").length,
      lost: list.filter((item) => item.status === "lost").length,
      wonValue: list.filter((item) => item.status === "won").reduce((sum, item) => sum + (Number(item.value) || 0), 0),
    });
    const group = (keyOf, labelOf) => {
      const map = new Map();
      for (const item of cards) {
        const key = keyOf(item);
        if (!map.has(key)) map.set(key, { key, label: labelOf(item), items: [] });
        map.get(key).items.push(item);
      }
      return [...map.values()].map(({ key, label, items }) => ({ key, label, ...summarize(items) })).sort((a, b) => b.interested - a.interested);
    };
    const bySource = group(
      (item) => item.source?.publicationId || item.source?.formId || item.source?.campaign || item.source?.channel || "otro",
      (item) => {
        const publication = item.source?.publicationId ? db().publications.find((entry) => entry.id === item.source.publicationId) : null;
        if (publication) return `Publicación: ${String(publication.text || "").slice(0, 70)} (${publication.target?.name || ""})`;
        if (item.source?.formName || item.source?.formId) return `Formulario: ${item.source.formName || item.source.formId}`;
        if (item.source?.campaign) return `Campaña: ${item.source.campaign}`;
        return CRM_CHANNELS[item.source?.channel] || "Otro origen";
      },
    ).map((row) => {
      const publication = db().publications.find((entry) => entry.id === row.key);
      return publication ? { ...row, reactions: publication.metrics?.reactions || 0, shares: publication.metrics?.shares || 0, url: publication.url || null } : row;
    });
    const stagesList = boardId ? stagesOf(boardId) : [];
    return {
      totals: summarize(cards),
      funnel: stagesList.map((item) => ({ id: item.id, name: item.name, kind: item.kind, color: item.color, pipelineId: item.pipelineId, count: db().crmOpportunities.filter((card) => card.stageId === item.id).length, value: db().crmOpportunities.filter((card) => card.stageId === item.id).reduce((sum, card) => sum + (Number(card.value) || 0), 0) })),
      bySource,
      byChannel: group((item) => item.source?.channel || "otro", (item) => CRM_CHANNELS[item.source?.channel] || "Otro"),
      byAgent: group((item) => item.agent || "", (item) => item.agent || "Sin asignar"),
      lostReasons: Object.entries(cards.filter((item) => item.status === "lost").reduce((acc, item) => { const key = item.lostReason || "Sin motivo"; acc[key] = (acc[key] || 0) + 1; return acc; }, {})).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
      publicationsWithoutLeads: db().publications.filter((item) => item.status === "published" && (item.metrics?.reactions || item.metrics?.shares) && !cards.some((card) => card.source?.publicationId === item.id)).slice(0, 20).map((item) => ({ id: item.id, text: String(item.text || "").slice(0, 90), target: item.target?.name || "", reactions: item.metrics?.reactions || 0, shares: item.metrics?.shares || 0 })),
    };
  }

  /* ---------------------------------------------------------- Lecturas para el panel */
  function cardView(item) {
    const target = contact(item.contactId);
    const task = nextTaskOf(item.id);
    return {
      ...item,
      contact: target ? { id: target.id, name: target.name, phone: target.phone, email: target.email, avatarUrl: target.avatarUrl, duplicates: (target.duplicates || []).length } : null,
      nextTask: task ? { id: task.id, title: task.title, dueAt: task.dueAt, agent: task.agent } : null,
      channels: target ? [...new Set(identitiesOf(target.id).map((identity) => identity.channel))] : [],
    };
  }

  function boardState(boardId) {
    const target = board(boardId) || board(settings().defaultBoardId) || db().crmBoards[0] || null;
    const openTasks = db().crmTasks.filter((task) => task.status === "open");
    // Tarjeta vinculada a cada chat y a cada aviso (botones "Ver en CRM").
    const chatLinks = {};
    const eventLinks = {};
    for (const item of [...db().crmOpportunities].sort((a, b) => (a.status === "open") - (b.status === "open") || String(a.updatedAt).localeCompare(String(b.updatedAt)))) {
      const chatId = item.chatId || item.source?.chatId;
      if (chatId) chatLinks[chatId] = item.id;
      if (item.source?.eventId) eventLinks[item.source.eventId] = item.id;
    }
    return {
      settings: settings(),
      boards: db().crmBoards,
      stageKinds: STAGE_KINDS,
      channels: CRM_CHANNELS,
      board: target,
      // Columnas de todos los tableros: el editor de Autopost elige tablero y columna inicial.
      stages: [...db().crmStages].sort((a, b) => a.position - b.position),
      cards: target ? db().crmOpportunities.filter((item) => item.boardId === target.id).map(cardView) : [],
      chatLinks,
      eventLinks,
      counts: {
        cards: db().crmOpportunities.length,
        contacts: db().crmContacts.length,
        tasksOpen: openTasks.length,
        tasksOverdue: openTasks.filter((task) => Date.parse(task.dueAt) <= nowMs()).length,
        duplicates: db().crmContacts.filter((item) => (item.duplicates || []).length).length,
      },
    };
  }

  function opportunityDetail(id) {
    const item = opportunity(id);
    if (!item) return null;
    const target = contact(item.contactId);
    const publication = item.source?.publicationId ? db().publications.find((entry) => entry.id === item.source.publicationId) : null;
    const chatId = item.chatId || identitiesOf(item.contactId).find((identity) => identity.channel === "messenger")?.externalId || null;
    const chat = chatId ? db().chats.find((entry) => entry.id === chatId) : null;
    const messages = chat ? db().messages.filter((message) => message.chatId === chat.id).slice(-60) : [];
    return {
      opportunity: cardView(item),
      contact: target,
      identities: target ? identitiesOf(target.id) : [],
      duplicates: (target?.duplicates || []).map((entry) => ({ ...entry, contact: contact(entry.contactId) })).filter((entry) => entry.contact),
      activities: db().crmActivities.filter((activity) => activity.opportunityId === id || (target && activity.contactId === target.id && !activity.opportunityId)).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 200),
      history: db().crmStageHistory.filter((entry) => entry.opportunityId === id).sort((a, b) => String(b.at).localeCompare(String(a.at))),
      tasks: db().crmTasks.filter((task) => task.opportunityId === id).sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt))),
      otherCards: target ? db().crmOpportunities.filter((entry) => entry.contactId === target.id && entry.id !== id).map((entry) => ({ id: entry.id, title: entry.title, boardId: entry.boardId, boardName: board(entry.boardId)?.name || "", stageName: stage(entry.stageId)?.name || "", status: entry.status })) : [],
      campaigns: target ? db().campaignRecipients.filter((entry) => entry.contactId === target.id).map((entry) => ({ ...entry, name: db().crmCampaigns.find((campaign) => campaign.id === entry.campaignId)?.name || "Campaña" })) : [],
      publication: publication ? { id: publication.id, text: publication.text, url: publication.url, target: publication.target, createdAt: publication.createdAt, campaign: publication.ai?.campaign || null, metrics: publication.metrics || null } : null,
      chat: chat ? { id: chat.id, name: chat.name, url: chat.url, avatarUrl: chat.avatarUrl, lastMessage: chat.lastMessage || chat.preview } : null,
      messages,
    };
  }

  function contactsList({ q = "", duplicates = false } = {}) {
    const query = normalizeName(q);
    return db().crmContacts.filter((item) => (!duplicates || (item.duplicates || []).length) && (!query || normalizeName(`${item.name} ${item.phone || ""} ${item.email || ""}`).includes(query)))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 500)
      .map((item) => {
        const cards = db().crmOpportunities.filter((entry) => entry.contactId === item.id).sort((a, b) => (a.status === "open") - (b.status === "open") || String(a.updatedAt).localeCompare(String(b.updatedAt)));
        return { ...item, channels: [...new Set(identitiesOf(item.id).map((identity) => identity.channel))], cards: cards.length, latestOpportunityId: cards.at(-1)?.id || null, lastContactAt: lastContactAt(item.id), duplicates: (item.duplicates || []).map((entry) => ({ ...entry, name: contact(entry.contactId)?.name || "" })) };
      });
  }

  function tasksList({ scope = "open" } = {}) {
    return db().crmTasks.filter((task) => scope === "all" || task.status === "open").sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt))).slice(0, 500).map((task) => {
      const item = opportunity(task.opportunityId);
      return { ...task, contactName: contact(task.contactId)?.name || "", opportunityTitle: item?.title || "", boardName: board(item?.boardId)?.name || "", stageName: stage(item?.stageId)?.name || "" };
    });
  }

  function start() {
    const created = ensureDefaults();
    if (repairNames() || created) persist().catch(() => {});
    // unref: el recordatorio no retiene el proceso (el servidor HTTP ya lo mantiene vivo).
    if (!timer) timer = setInterval(() => tickTasks().catch((error) => console.error("[crm] recordatorios", error.message)), 30_000).unref();
  }

  return {
    settings, updateSettings, ensureDefaults, boardState, opportunityDetail, contactsList, tasksList,
    saveBoard, deleteBoard, saveStage, reorderStages, deleteStage,
    createManual, updateOpportunity, moveOpportunity, deleteOpportunity, addNote, setHistoryReason,
    saveTask, tickTasks, updateContact, mergeContacts, dismissDuplicate, deleteContact, syncChatNames,
    captureEvent, onInteraction, captureChat, captureEventManual, recordReply, captureLead,
    registerPublication, sanitizeRouting, previewCampaign, saveCampaign, campaignRecipients, reports, start,
  };
}
