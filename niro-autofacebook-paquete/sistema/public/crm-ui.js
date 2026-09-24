// CRM visual: tableros con arrastrar y soltar, ficha de la tarjeta, tareas de
// seguimiento, contactos (con unión supervisada), campañas dirigidas y reportes.
// Se instala sobre el panel (app.js): mismo router, acciones delegadas por
// data-action y el mismo canal en vivo. También agrega "Enviar interesados al
// tablero" al editor de Autopost y "Enviar al CRM" en Messenger y Notificaciones.
export function installCrm(ctx) {
  const { $, state, actions, ROUTES, request, run, toast, icon, esc, avatar, timeAgo, when, emptyState, renderView, navigate, isTyping, rerenderKeepingFocus, streamHooks, openModal, profileName, hooks, uploadMediaFiles, selectOptions, dialogs } = ctx;

  const CHANNEL_ICONS = { messenger: "message", instagram: "image", comment: "message", mention: "at", meta_form: "file", google_form: "file", web_form: "globe", manual: "edit" };
  const PRIORITY = { low: "Baja", normal: "Normal", high: "Alta" };
  const ACTIVITY_META = {
    message_in: ["message", "Mensaje recibido"], message_out: ["send", "Mensaje enviado"], comment: ["message", "Comentario"], reply: ["send", "Respuesta en el hilo"],
    form: ["file", "Formulario"], note: ["edit", "Nota interna"], call: ["activity", "Llamada"], quote: ["file", "Cotización"], file: ["clip", "Archivo"],
    task: ["clock", "Seguimiento"], campaign: ["rocket", "Campaña"], system: ["zap", "Sistema"],
  };
  const CONSENT = { unknown: "Sin dato", granted: "Autorizó", denied: "No autorizó" };
  const CAMPAIGN_CHANNELS = { whatsapp: "WhatsApp", sms: "SMS", email: "Correo", messenger: "Messenger" };
  const IDENTITY_LABELS = { messenger: "Messenger", facebook_name: "Facebook (nombre)", phone: "Teléfono", email: "Correo", meta_form: "Formulario de Meta", google_form: "Formulario de Google", web_form: "Formulario web", manual: "Manual" };

  const storage = {
    get(key, fallback) { try { const value = localStorage.getItem(key); return value == null ? fallback : JSON.parse(value); } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento */ } },
  };
  const localDate = (date = new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  const localDateTime = (date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const money = (value) => (value == null || value === "" ? "" : new Intl.NumberFormat("es-PY", { style: "currency", currency: "PYG", maximumFractionDigits: 0 }).format(Number(value)));
  const initialsOf = (name = "") => String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "?";
  const post = (path, body = {}) => request(path, { method: "POST", body: JSON.stringify({ actor: actor(), ...body }) });
  const patch = (path, body = {}) => request(path, { method: "PATCH", body: JSON.stringify({ actor: actor(), ...body }) });

  state.crm = {
    data: null,
    boardId: storage.get("niro-crm-board", null),
    pipelineId: null,
    tab: "tablero",
    search: "",
    filter: { agent: "", channel: "" },
    columnLimit: {},
    dragging: null,
    openId: null,
    detail: null,
    noteMedia: [],
    tasks: [],
    taskScope: "open",
    contacts: [],
    contactsQuery: "",
    onlyDuplicates: false,
    campaigns: [],
    campaign: { filters: { boardId: "", stageIds: [], tags: "", product: "", source: "", lastContactFrom: "", lastContactTo: "", channel: "whatsapp", requireConsent: true }, preview: null, name: "", message: "" },
    report: null,
    reportFilter: { boardId: "", from: "", to: "", preset: "30" },
    webhooks: null,
    actor: storage.get("niro-crm-actor", ""),
  };
  const actor = () => state.crm.actor || profileName();

  /* ---------------------------------------------------------- Datos */
  let loading = null;
  async function loadCrm({ render = true } = {}) {
    const crm = state.crm;
    loading = request(`/api/crm/state?${new URLSearchParams(crm.boardId ? { boardId: crm.boardId } : {})}`);
    const data = await loading.finally(() => { loading = null; });
    crm.data = data;
    crm.boardId = data.board?.id || null;
    const pipelines = data.board?.pipelines || [];
    if (!pipelines.some((pipeline) => pipeline.id === crm.pipelineId)) crm.pipelineId = pipelines[0]?.id || "main";
    await loadTab();
    if (render && state.route === "crm" && !isTyping()) renderView();
  }

  async function loadTab() {
    const crm = state.crm;
    if (crm.tab === "tareas") crm.tasks = (await request(`/api/crm/tasks?scope=${crm.taskScope}`)).tasks;
    if (crm.tab === "contactos") crm.contacts = (await request(`/api/crm/contacts?${new URLSearchParams({ q: crm.contactsQuery, duplicates: crm.onlyDuplicates ? "1" : "" })}`)).contacts;
    if (crm.tab === "campanas") crm.campaigns = (await request("/api/crm/campaigns")).campaigns;
    if (crm.tab === "reportes") crm.report = (await request(`/api/crm/reports?${new URLSearchParams(reportQuery())}`)).report;
    if (crm.tab === "configuracion") crm.webhooks = await request("/api/crm/webhooks-status");
  }

  function reportQuery() {
    const filter = state.crm.reportFilter;
    const query = { boardId: filter.boardId || state.crm.boardId || "" };
    if (filter.preset && filter.preset !== "custom" && filter.preset !== "all") {
      const from = new Date();
      from.setDate(from.getDate() - Number(filter.preset) + 1);
      query.from = localDate(from);
    } else if (filter.preset === "custom") {
      if (filter.from) query.from = filter.from;
      if (filter.to) query.to = filter.to;
    }
    return query;
  }

  const stagesOf = (boardId, pipelineId = null) => (state.crm.data?.stages || []).filter((stage) => stage.boardId === boardId && (!pipelineId || stage.pipelineId === pipelineId)).sort((a, b) => a.position - b.position);
  const boardName = (id) => state.crm.data?.boards.find((board) => board.id === id)?.name || "";
  const agentNames = () => [...new Set([profileName(), ...(state.crm.data?.settings.agents || []).map((agent) => agent.name)].filter(Boolean))];
  const channelLabel = (channel) => state.crm.data?.channels?.[channel] || channel || "";

  function originLabel(card) {
    const source = card.source || {};
    if (source.formName || source.formId) return `Formulario ${source.formName || source.formId}${source.campaign ? ` · ${source.campaign}` : ""}`;
    if (source.publicationId || source.postText) return `Publicación${source.campaign ? ` · ${source.campaign}` : ""}${source.postText ? `: ${source.postText.slice(0, 70)}` : ""}`;
    if (source.campaign) return `Campaña ${source.campaign}`;
    if (source.channel === "messenger") return "Conversación de Messenger";
    return "";
  }

  function dueLabel(value) {
    const date = new Date(value);
    const today = new Date();
    const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
    const time = date.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
    if (date.toDateString() === today.toDateString()) return `Hoy ${time}`;
    if (date.toDateString() === tomorrow.toDateString()) return `Mañana ${time}`;
    return `${date.toLocaleDateString("es", { weekday: "short", day: "numeric", month: "short" })} ${time}`;
  }

  /* ---------------------------------------------------------- Vista principal */
  function renderCrm() {
    const crm = state.crm;
    if (crm.dragging) return;
    if (!crm.data) {
      $("#view").innerHTML = `<div class="card empty"><span class="empty-icon">${icon("users")}</span><strong>Cargando el CRM…</strong></div>`;
      if (!loading) loadCrm().catch((error) => toast(error.message, { error: true }));
      return;
    }
    const scrollLeft = $(".crm-board")?.scrollLeft || 0;
    const data = crm.data;
    const boards = data.boards.filter((board) => !board.archived || board.id === data.board?.id);
    const tabs = [["tablero", "kanban", "Tablero"], ["tareas", "clock", `Tareas${data.counts.tasksOverdue ? ` (${data.counts.tasksOverdue})` : ""}`], ["contactos", "users", "Contactos"], ["campanas", "rocket", "Campañas"], ["reportes", "activity", "Reportes"], ["configuracion", "zap", "Configuración"]];
    const body = { tablero: boardTab, tareas: tasksTab, contactos: contactsTab, campanas: campaignsTab, reportes: reportsTab, configuracion: settingsTab }[crm.tab]();
    $("#view").innerHTML = `
      <div class="page-title"><div><span class="eyebrow">Ventas y seguimiento</span><h1>CRM</h1><p>Cada consulta identificable (mensaje, comentario con interés o formulario) llega a una tarjeta con su origen. Movela por el tablero, conversá y programá el próximo contacto.</p></div>
        <div class="actions">
          <label class="field crm-actor">Trabajás como<input id="crm-actor" list="crm-agents" value="${esc(actor())}" /></label>
          <label class="field">Tablero<select id="crm-board-select">${boards.map((board) => `<option value="${esc(board.id)}" ${board.id === data.board?.id ? "selected" : ""}>${esc(board.name)}${board.archived ? " (archivado)" : ""}</option>`).join("")}</select></label>
          <button class="btn primary" data-action="crm-new">${icon("plus", "sm")} Nueva tarjeta</button>
        </div></div>
      <datalist id="crm-agents">${agentNames().map((name) => `<option value="${esc(name)}"></option>`).join("")}</datalist>
      ${data.counts.duplicates ? `<section class="card card-pad crm-banner">${icon("users", "sm")}<span class="grow">${data.counts.duplicates} contacto(s) podrían ser la misma persona en otro canal. La unión la decidís vos.</span><button class="btn soft sm" data-action="crm-show-duplicates">Revisar</button></section>` : ""}
      <div class="segmented">${tabs.map(([key, iconName, label]) => `<button class="${crm.tab === key ? "active" : ""}" data-action="crm-tab" data-tab="${key}">${icon(iconName, "sm")} ${esc(label)}</button>`).join("")}</div>
      ${crm.newCard ? newCardForm() : ""}
      ${body}`;
    const board = $(".crm-board");
    if (board) board.scrollLeft = scrollLeft;
  }

  function newCardForm() {
    const crm = state.crm;
    const stages = stagesOf(crm.boardId, crm.pipelineId).filter((stage) => !["won", "lost"].includes(stage.kind));
    return `<section class="card"><div class="card-head"><h3>Nueva tarjeta en ${esc(boardName(crm.boardId))}</h3><button class="round-btn" data-action="crm-new-cancel" aria-label="Cerrar">${icon("x", "sm")}</button></div>
      <div class="card-body"><form id="crm-new-form" class="prompt-grid">
        <label class="field">Nombre<input name="name" required maxlength="120" placeholder="Persona o empresa" /></label>
        <label class="field">Teléfono<input name="phone" inputmode="tel" placeholder="0981 123 456" /></label>
        <label class="field">Correo<input name="email" type="email" placeholder="nombre@empresa.com" /></label>
        <label class="field">Oportunidad<input name="title" placeholder="Ej: Niro Bot para su tienda" /></label>
        <label class="field">Producto o servicio<input name="product" placeholder="Niro Bot, SMS masivo…" /></label>
        <label class="field">Valor potencial (Gs.)<input name="value" type="number" min="0" step="1000" /></label>
        <label class="field">Columna<select name="stageId">${stages.map((stage) => `<option value="${esc(stage.id)}" ${stage.id === crm.newCard?.stageId ? "selected" : ""}>${esc(stage.name)}</option>`).join("")}</select></label>
        <label class="field">Responsable<input name="agent" list="crm-agents" value="${esc(actor())}" /></label>
        <label class="field" style="grid-column:1/-1">Nota inicial<textarea name="note" placeholder="Cómo llegó, qué necesita…"></textarea></label>
        <div class="actions" style="grid-column:1/-1"><button type="submit" class="btn primary sm">${icon("check", "sm")} Crear tarjeta</button></div>
      </form></div></section>`;
  }

  /* ---------------------------------------------------------- Tablero */
  function filteredCards() {
    const crm = state.crm;
    const query = crm.search.trim().toLowerCase();
    return crm.data.cards.filter((card) => {
      if (crm.filter.agent && (crm.filter.agent === "_none" ? card.agent : card.agent !== crm.filter.agent)) return false;
      if (crm.filter.channel && card.source?.channel !== crm.filter.channel) return false;
      if (query && !`${card.title} ${card.contact?.name || ""} ${card.product || ""} ${(card.tags || []).join(" ")} ${card.contact?.phone || ""} ${card.lastMessage?.text || ""}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }

  function boardTab() {
    const crm = state.crm;
    const data = crm.data;
    const board = data.board;
    if (!board) return `<section class="card">${emptyState("layers", "Sin tableros", "Creá un tablero en Configuración.")}</section>`;
    const stages = stagesOf(board.id, crm.pipelineId);
    const cards = filteredCards();
    const agents = [...new Set(data.cards.map((card) => card.agent).filter(Boolean))];
    const channels = [...new Set(data.cards.map((card) => card.source?.channel).filter(Boolean))];
    return `<section class="card card-pad crm-toolbar">
        <input type="search" id="crm-q" placeholder="Buscar persona, producto, etiqueta o mensaje…" value="${esc(crm.search)}" />
        <label class="field">Responsable<select data-crm-filter="agent"><option value="">Todos</option>${agents.map((name) => `<option value="${esc(name)}" ${crm.filter.agent === name ? "selected" : ""}>${esc(name)}</option>`).join("")}<option value="_none" ${crm.filter.agent === "_none" ? "selected" : ""}>Sin asignar</option></select></label>
        <label class="field">Canal<select data-crm-filter="channel">${selectOptions(channels.map((channel) => [channel, channelLabel(channel)]), crm.filter.channel, "Todos")}</select></label>
        ${(board.pipelines || []).length > 1 ? `<div class="segmented crm-pipelines">${board.pipelines.map((pipeline) => `<button class="${pipeline.id === crm.pipelineId ? "active" : ""}" data-action="crm-pipeline" data-id="${esc(pipeline.id)}">${esc(pipeline.name)}</button>`).join("")}</div>` : ""}
        <span class="sub">${cards.length} tarjeta(s) · arrastrá para mover · Enter abre la ficha</span>
      </section>
      <div class="crm-board" role="list">${stages.map((stage) => column(stage, cards.filter((card) => card.stageId === stage.id))).join("")}</div>`;
  }

  function column(stage, cards) {
    const crm = state.crm;
    const total = cards.reduce((sum, card) => sum + (Number(card.value) || 0), 0);
    const sorted = [...cards].sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const limit = crm.columnLimit[stage.id] || 50;
    return `<section class="crm-col" role="listitem" style="--stage:${esc(stage.color || "#858797")}" aria-label="${esc(stage.name)}: ${cards.length} tarjeta(s)">
      <header class="crm-col-head"><span class="crm-dot"></span><strong>${esc(stage.name)}</strong><span class="crm-count">${cards.length}</span>${total ? `<span class="crm-sum">${esc(money(total))}</span>` : ""}</header>
      <div class="crm-col-body" data-crm-drop="${esc(stage.id)}" data-keep-scroll="crm-col-${esc(stage.id)}">
        ${sorted.slice(0, limit).map(cardHtml).join("") || '<p class="crm-empty">Soltá una tarjeta acá</p>'}
        ${sorted.length > limit ? `<button class="btn ghost xs" data-action="crm-col-more" data-stage="${esc(stage.id)}">Ver ${sorted.length - limit} más</button>` : ""}
      </div>
      ${["won", "lost"].includes(stage.kind) ? "" : `<button class="crm-add" data-action="crm-new" data-stage="${esc(stage.id)}">${icon("plus", "xs")} Agregar tarjeta</button>`}
    </section>`;
  }

  function cardHtml(card) {
    const contact = card.contact || {};
    const channel = card.source?.channel;
    const origin = originLabel(card);
    const task = card.nextTask;
    const overdue = task && Date.parse(task.dueAt) <= Date.now();
    const name = contact.name || card.title;
    return `<article class="crm-card prio-${esc(card.priority || "normal")} ${card.status !== "open" ? "closed" : ""}" draggable="true" tabindex="0" data-crm-card="${esc(card.id)}" data-action="crm-open" data-id="${esc(card.id)}" aria-label="${esc(name)}">
      <div class="crm-card-head">${avatar(name, { size: "sm", seed: contact.id || card.id, image: contact.avatarUrl })}<div class="grow"><strong>${esc(name)}</strong><small>${icon(CHANNEL_ICONS[channel] || "globe", "xs")} ${esc(channelLabel(channel))}</small></div>${card.priority === "high" ? '<span class="tag red">Alta</span>' : ""}</div>
      ${card.title && card.title !== name ? `<p class="crm-card-title">${esc(card.title)}</p>` : ""}
      ${origin ? `<p class="crm-card-origin">${icon("layers", "xs")} <span>${esc(origin)}</span></p>` : ""}
      ${card.lastMessage?.text ? `<p class="crm-card-msg">${card.lastMessage.direction === "out" ? "<b>Vos:</b> " : ""}${esc(card.lastMessage.text)} <span class="time">${timeAgo(card.lastMessage.at)}</span></p>` : ""}
      <div class="crm-card-foot">
        ${(card.tags || []).slice(0, 3).map((tag) => `<span class="tag">${esc(tag)}</span>`).join("")}
        ${task ? `<span class="tag ${overdue ? "red" : "blue"}" title="${esc(task.title)}">${icon("clock", "xs")} ${esc(dueLabel(task.dueAt))}</span>` : ""}
        ${contact.duplicates ? `<span class="tag orange" title="Posible misma persona en otro canal">${icon("users", "xs")}</span>` : ""}
        <span class="grow"></span>
        ${card.value ? `<b class="crm-value">${esc(money(card.value))}</b>` : ""}
        ${card.agent ? `<span class="crm-agent" title="Responsable: ${esc(card.agent)}">${esc(initialsOf(card.agent))}</span>` : ""}
      </div>
    </article>`;
  }

  /* ---------------------------------------------------------- Arrastrar y soltar */
  let marker = null;
  const clearDrop = () => {
    marker?.remove();
    document.querySelectorAll(".crm-col-body.drop-target").forEach((node) => node.classList.remove("drop-target"));
  };
  document.addEventListener("dragstart", (event) => {
    const card = event.target.closest?.("[data-crm-card]");
    if (!card) return;
    state.crm.dragging = card.dataset.crmCard;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", state.crm.dragging);
    requestAnimationFrame(() => card.classList.add("dragging"));
  });
  document.addEventListener("dragover", (event) => {
    const zone = event.target.closest?.("[data-crm-drop]");
    if (!zone || !state.crm.dragging) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (!zone.classList.contains("drop-target")) { clearDrop(); zone.classList.add("drop-target"); }
    marker ||= Object.assign(document.createElement("div"), { className: "crm-drop-marker" });
    const next = [...zone.querySelectorAll("[data-crm-card]:not(.dragging)")].find((node) => event.clientY < node.getBoundingClientRect().top + node.offsetHeight / 2);
    if (next) zone.insertBefore(marker, next);
    else zone.appendChild(marker);
  });
  document.addEventListener("drop", (event) => {
    const zone = event.target.closest?.("[data-crm-drop]");
    const id = state.crm.dragging;
    if (!zone || !id) return;
    event.preventDefault();
    let beforeId = null;
    for (let node = marker?.nextElementSibling; node; node = node.nextElementSibling) {
      if (node.dataset?.crmCard && node.dataset.crmCard !== id) { beforeId = node.dataset.crmCard; break; }
    }
    clearDrop();
    state.crm.dragging = null;
    moveCard(id, zone.dataset.crmDrop, beforeId);
  });
  document.addEventListener("dragend", () => {
    clearDrop();
    if (state.crm.dragging) { state.crm.dragging = null; if (state.route === "crm") renderView(); }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.crm.openId && $("#modal").classList.contains("hidden")) { closeDrawer(); return; }
    const card = event.target.closest?.("[data-crm-card]");
    if (card && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openCard(card.dataset.crmCard); }
  });

  async function moveCard(id, stageId, beforeId = null, reasonOverride = null) {
    const crm = state.crm;
    const card = crm.data?.cards.find((item) => item.id === id);
    const target = crm.data?.stages.find((stage) => stage.id === stageId);
    if (!target) return;
    let reason = reasonOverride || "";
    if (target.kind === "lost" && card?.stageId !== stageId && !reasonOverride) {
      const answer = await dialogs.prompt({ title: `¿Por qué se perdió ${card?.contact?.name || "la oportunidad"}?`, message: "Queda en el historial de la tarjeta y en los reportes de motivos de pérdida.", label: "Motivo", placeholder: "Ej: eligió otro proveedor, el precio, no volvió a responder", confirmLabel: "Marcar perdida", tone: "danger", iconName: "x" });
      if (answer === null) { renderView(); return; }
      reason = answer;
    }
    if (card) { card.stageId = stageId; card.rank = -1; }
    renderView();
    try {
      const result = await post(`/api/crm/opportunities/${encodeURIComponent(id)}/move`, { stageId, beforeId, reason });
      if (result.history) {
        toast(result.history.reason ? `Motivo: ${result.history.reason}` : "Tocá acá para agregar el motivo del cambio.", { title: `${card?.contact?.name || "Tarjeta"} → ${target.name}`, action: result.history.reason ? null : () => addHistoryReason(result.history.id), timeout: 7000 });
      }
      await loadCrm();
      if (crm.openId === id) await reloadDetail();
    } catch (error) {
      toast(error.message, { error: true });
      await loadCrm();
    }
  }

  async function addHistoryReason(historyId) {
    const reason = await dialogs.prompt({ title: "Motivo del cambio", message: "Queda en el historial junto a quién movió la tarjeta y cuándo.", label: "¿Por qué se movió?", placeholder: "Ej: pidió propuesta formal", required: true, confirmLabel: "Guardar motivo", iconName: "edit" });
    if (!reason) return;
    try {
      await patch(`/api/crm/history/${encodeURIComponent(historyId)}`, { reason });
      toast("Motivo guardado en el historial.");
      if (state.crm.openId) await reloadDetail();
    } catch (error) { toast(error.message, { error: true }); }
  }

  /* ---------------------------------------------------------- Ficha de la tarjeta */
  const drawer = document.createElement("div");
  drawer.id = "crm-drawer";
  drawer.className = "crm-drawer hidden";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-modal", "true");
  drawer.setAttribute("aria-label", "Ficha de la tarjeta");
  document.body.appendChild(drawer);
  const fileInput = Object.assign(document.createElement("input"), { type: "file", multiple: true, hidden: true, id: "crm-file" });
  document.body.appendChild(fileInput);

  async function openCard(id) {
    const crm = state.crm;
    crm.openId = id;
    crm.detail = null;
    crm.noteMedia = [];
    renderDrawer();
    try {
      crm.detail = await request(`/api/crm/opportunities/${encodeURIComponent(id)}`);
      renderDrawer();
      drawer.querySelector(".crm-drawer-panel")?.focus();
    } catch (error) {
      toast(error.message, { error: true });
      closeDrawer();
    }
  }

  function closeDrawer() {
    state.crm.openId = null;
    state.crm.detail = null;
    drawer.classList.add("hidden");
    drawer.innerHTML = "";
  }

  async function reloadDetail() {
    const crm = state.crm;
    if (!crm.openId) return;
    try {
      crm.detail = await request(`/api/crm/opportunities/${encodeURIComponent(crm.openId)}`);
      renderDrawer();
    } catch { closeDrawer(); }
  }

  // Los textos a medio escribir sobreviven a las actualizaciones en vivo.
  function renderDrawer() {
    const crm = state.crm;
    if (!crm.openId) { closeDrawer(); return; }
    drawer.classList.remove("hidden");
    const kept = new Map([...drawer.querySelectorAll("[data-keep-value]")].map((node) => [node.dataset.keepValue, node.value]));
    const focused = document.activeElement?.dataset?.keepValue || null;
    const scroll = drawer.querySelector(".crm-drawer-body")?.scrollTop || 0;
    drawer.innerHTML = `<div class="crm-drawer-backdrop" data-action="crm-close"></div><aside class="crm-drawer-panel" tabindex="-1">${crm.detail ? drawerContent(crm.detail) : `<div class="empty"><strong>Cargando la tarjeta…</strong></div>`}</aside>`;
    for (const [key, value] of kept) { const node = drawer.querySelector(`[data-keep-value="${CSS.escape(key)}"]`); if (node && value) node.value = value; }
    if (focused) drawer.querySelector(`[data-keep-value="${CSS.escape(focused)}"]`)?.focus();
    const body = drawer.querySelector(".crm-drawer-body");
    if (body) body.scrollTop = scroll;
  }

  function linkedEvent(detail) {
    const card = detail.opportunity;
    if (detail.chat) return (state.events || []).find((event) => event.source === "messenger" && (event.url === detail.chat.url || event.externalId?.startsWith(`${detail.chat.id}:`))) || null;
    if (card.source?.eventId) return (state.events || []).find((event) => event.id === card.source.eventId) || null;
    return null;
  }

  function drawerContent(detail) {
    const crm = state.crm;
    const card = detail.opportunity;
    const contact = detail.contact || {};
    const stages = stagesOf(card.boardId, card.pipelineId);
    const stage = stages.find((item) => item.id === card.stageId);
    const source = card.source || {};
    const event = linkedEvent(detail);
    const openTasks = detail.tasks.filter((task) => task.status === "open");
    const doneTasks = detail.tasks.filter((task) => task.status !== "open");
    const defaultDue = new Date(Date.now() + 86_400_000); defaultDue.setHours(10, 0, 0, 0);
    const consent = contact.consent || {};
    const timeline = [
      ...detail.history.map((entry) => ({ at: entry.at, html: `<span class="crm-tl-icon">${icon("right", "xs")}</span><div><b>${entry.fromName ? `${esc(entry.fromName)} → ${esc(entry.toName)}` : `Creada en ${esc(entry.toName)}`}</b><small>${esc(entry.actor || "")} · ${when(entry.at)}</small>${entry.reason ? `<p>${esc(entry.reason)}</p>` : entry.fromName ? `<button class="link-btn" data-action="crm-history-reason" data-id="${esc(entry.id)}">Agregar motivo</button>` : ""}</div>` })),
      ...detail.activities.map((activity) => {
        const [iconName, label] = ACTIVITY_META[activity.type] || ["zap", activity.type];
        return { at: activity.at, html: `<span class="crm-tl-icon">${icon(iconName, "xs")}</span><div><b>${esc(label)}${activity.channel ? ` · ${esc(channelLabel(activity.channel))}` : ""}</b><small>${esc(activity.actor || "")}${activity.actor ? " · " : ""}${when(activity.at)}</small>${activity.text ? `<p>${esc(activity.text)}</p>` : ""}${(activity.mediaIds || []).map((id) => `<a class="crm-file" href="${window.NIRO_BASE || ""}/api/media/${encodeURIComponent(id)}/file" target="_blank" rel="noopener">${icon("clip", "xs")} Ver adjunto</a>`).join("")}</div>` };
      }),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const messages = detail.messages.length
      ? detail.messages.map((message) => `<div class="bubble ${message.fromMe || /^(tú|you)$/i.test(message.sender || "") ? "me" : ""}">${esc(message.text)}<small>${esc(message.sentAt ? when(message.sentAt) : message.timestamp || "")}</small></div>`).join("")
      : detail.activities.filter((activity) => ["message_in", "message_out", "comment", "reply"].includes(activity.type)).reverse().map((activity) => `<div class="bubble ${["message_out", "reply"].includes(activity.type) ? "me" : ""}">${esc(activity.text)}<small>${when(activity.at)}</small></div>`).join("");
    return `<header class="crm-drawer-head">${avatar(contact.name || card.title, { size: "lg", seed: contact.id || card.id, image: contact.avatarUrl })}
        <div class="grow"><span class="eyebrow">${esc(boardName(card.boardId))}</span><h2>${esc(contact.name || card.title)}</h2><span class="sub">${esc(card.title !== contact.name ? card.title : "")}${card.title !== contact.name ? " · " : ""}creada ${when(card.createdAt)} por ${esc(card.createdBy || "Niro")}</span></div>
        <button class="round-btn" data-action="crm-close" aria-label="Cerrar ficha">${icon("x", "sm")}</button></header>
      <div class="crm-drawer-body">
        <section class="crm-move">
          <label class="field">Etapa<select id="crm-move-select">${stages.map((item) => `<option value="${esc(item.id)}" ${item.id === card.stageId ? "selected" : ""}>${esc(item.name)}</option>`).join("")}</select></label>
          <label class="field">Motivo del cambio (opcional)<input id="crm-move-reason" data-keep-value="move-reason" placeholder="Ej: pidió propuesta formal" /></label>
          <div class="actions">${stage?.kind !== "won" ? `<button class="btn success sm" data-action="crm-mark" data-kind="won">${icon("check", "sm")} Ganada</button>` : ""}${stage?.kind !== "lost" ? `<button class="btn danger sm" data-action="crm-mark" data-kind="lost">${icon("x", "sm")} Perdida</button>` : ""}</div>
          ${card.status === "lost" && card.lostReason ? `<p class="sub">Motivo de pérdida: ${esc(card.lostReason)}</p>` : ""}
        </section>
        ${detail.duplicates.length ? `<section class="crm-section crm-warn"><h3>${icon("users", "sm")} ¿Es la misma persona?</h3>${detail.duplicates.map((entry) => `<div class="row"><span class="grow"><span class="title">${esc(entry.contact.name)}</span><span class="sub">${esc(entry.reason)} · ${esc([entry.contact.phone, entry.contact.email].filter(Boolean).join(" · ") || "sin datos de contacto")}</span></span><button class="btn soft xs" data-action="crm-merge" data-target="${esc(contact.id)}" data-source="${esc(entry.contact.id)}">Unir aquí</button><button class="btn ghost xs" data-action="crm-dismiss-dup" data-contact="${esc(contact.id)}" data-other="${esc(entry.contact.id)}">No es la misma</button></div>`).join("")}</section>` : ""}
        <section class="crm-section"><h3>Contacto</h3>
          <form id="crm-contact-form" class="prompt-grid" data-id="${esc(contact.id)}">
            <label class="field">Nombre<input name="name" value="${esc(contact.name || "")}" /></label>
            <label class="field">Teléfono<input name="phone" inputmode="tel" value="${esc(contact.phone || "")}" /></label>
            <label class="field">Correo<input name="email" type="email" value="${esc(contact.email || "")}" /></label>
            <label class="field">Empresa<input name="company" value="${esc(contact.company || "")}" /></label>
            <label class="field">Etiquetas del contacto<input name="tags" value="${esc((contact.tags || []).join(", "))}" placeholder="cliente, mayorista" /></label>
            <fieldset class="crm-consent"><legend>Autorización para mensajes</legend>${Object.entries(CAMPAIGN_CHANNELS).map(([channel, label]) => `<label class="field">${label}<select name="consent-${channel}">${Object.entries(CONSENT).map(([key, text]) => `<option value="${key}" ${(consent[channel]?.status || "unknown") === key ? "selected" : ""}>${text}</option>`).join("")}</select></label>`).join("")}</fieldset>
            <div class="actions" style="grid-column:1/-1"><button type="submit" class="btn soft sm">${icon("check", "sm")} Guardar contacto</button><span class="sub">Canales: ${detail.identities.map((identity) => esc(IDENTITY_LABELS[identity.channel] || identity.channel)).join(" · ") || "—"}</span></div>
          </form>
        </section>
        <section class="crm-section"><h3>Oportunidad</h3>
          <form id="crm-opp-form" class="prompt-grid" data-id="${esc(card.id)}">
            <label class="field">Título<input name="title" value="${esc(card.title || "")}" /></label>
            <label class="field">Producto o servicio consultado<input name="product" value="${esc(card.product || "")}" /></label>
            <label class="field">Valor potencial (Gs.)<input name="value" type="number" min="0" step="1000" value="${esc(card.value ?? "")}" /></label>
            <label class="field">Prioridad<select name="priority">${Object.entries(PRIORITY).map(([key, label]) => `<option value="${key}" ${card.priority === key ? "selected" : ""}>${label}</option>`).join("")}</select></label>
            <label class="field">Responsable<input name="agent" list="crm-agents" value="${esc(card.agent || "")}" /></label>
            <label class="field">Departamento<input name="department" list="crm-departments" value="${esc(card.department || "")}" /></label>
            <label class="field" style="grid-column:1/-1">Etiquetas<input name="tags" value="${esc((card.tags || []).join(", "))}" placeholder="urgente, mayorista" /></label>
            <div class="actions" style="grid-column:1/-1"><button type="submit" class="btn soft sm">${icon("check", "sm")} Guardar oportunidad</button></div>
          </form>
          <datalist id="crm-departments">${(state.crm.data?.settings.departments || []).map((name) => `<option value="${esc(name)}"></option>`).join("")}</datalist>
        </section>
        <section class="crm-section"><h3>Origen</h3>
          <div class="crm-origin">
            <span class="tag blue">${icon(CHANNEL_ICONS[source.channel] || "globe", "xs")} ${esc(channelLabel(source.channel) || "—")}</span>
            ${source.account ? `<span class="tag">${esc(source.account)}</span>` : ""}${source.campaign ? `<span class="tag violet">Campaña: ${esc(source.campaign)}</span>` : ""}${source.category ? `<span class="tag">${esc(source.category)}</span>` : ""}${source.routedBy ? `<span class="tag">Destino: ${esc(source.routedBy)}</span>` : ""}
          </div>
          ${detail.publication ? `<div class="ai-post"><span class="eyebrow">Publicación de origen · ${esc(detail.publication.target?.name || "")} · ${when(detail.publication.createdAt)}</span><p>${esc(String(detail.publication.text || "").slice(0, 400))}</p>${detail.publication.metrics ? `<small>${detail.publication.metrics.reactions || 0} reacciones · ${detail.publication.metrics.shares || 0} compartidos (según avisos)</small>` : ""}${detail.publication.url ? `<button class="link-btn" data-action="open-url" data-url="${esc(detail.publication.url)}">Abrir publicación</button>` : ""}</div>` : source.postText ? `<div class="ai-post"><span class="eyebrow">Publicación</span><p>${esc(source.postText)}</p>${source.postUrl ? `<button class="link-btn" data-action="open-url" data-url="${esc(source.postUrl)}">Abrir publicación</button>` : ""}</div>` : ""}
          ${source.text ? `<div class="ai-comment"><span class="eyebrow">${source.channel === "messenger" ? "Primer mensaje" : ["meta_form", "google_form", "web_form"].includes(source.channel) ? "Formulario" : "Comentario original"}</span><p>${esc(source.text)}</p></div>` : ""}
          ${source.adName || source.formName || source.formId ? `<p class="sub">${esc([source.adName && `Anuncio: ${source.adName}`, source.formName && `Formulario: ${source.formName}`, !source.formName && source.formId && `Formulario ${source.formId}`, source.leadId && `Lead ${source.leadId}`].filter(Boolean).join(" · "))}</p>` : ""}
        </section>
        <section class="crm-section"><h3>Conversación</h3>
          ${detail.chat ? `<div class="actions" style="margin-bottom:8px"><button class="btn ghost xs" data-action="crm-open-chat" data-chat="${esc(detail.chat.id)}">${icon("message", "xs")} Abrir en Messenger</button><button class="btn ghost xs" data-action="sync-chat" data-chat="${esc(detail.chat.id)}">${icon("refresh", "xs")} Traer historial</button></div>` : ""}
          <div class="crm-bubbles">${messages || '<p class="sub">Sin mensajes guardados todavía.</p>'}</div>
          ${event ? `<div class="crm-reply"><textarea id="crm-reply" data-keep-value="reply" maxlength="2000" placeholder="${detail.chat ? "Escribí un mensaje por Messenger…" : "Respondé en el hilo del comentario…"}"></textarea><button class="btn primary sm" data-action="crm-reply" data-event="${esc(event.id)}" data-messenger="${detail.chat ? "1" : ""}">${icon("send", "sm")} Preparar ${detail.chat ? "mensaje" : "respuesta"}</button></div><p class="sub">Se pide confirmación antes de enviar.${detail.chat ? " Messenger permite responder libremente dentro de las 24 h del último mensaje de la persona." : ""}</p>`
            : `<p class="sub">${detail.chat ? "Actualizá los avisos para poder responder este chat desde Niro." : "Esta tarjeta no tiene un hilo para responder desde Niro."}</p>`}
        </section>
        <section class="crm-section"><h3>Próxima acción</h3>
          ${openTasks.map((task) => `<div class="row crm-task ${Date.parse(task.dueAt) <= Date.now() ? "overdue" : ""}">${icon("clock", "sm")}<span class="grow"><span class="title">${esc(task.title)}</span><span class="sub">${esc(dueLabel(task.dueAt))}${task.agent ? ` · ${esc(task.agent)}` : ""}</span></span><button class="btn soft xs" data-action="crm-task-done" data-id="${esc(task.id)}">${icon("check", "xs")} Hecha</button><button class="btn ghost xs" data-action="crm-task-snooze" data-id="${esc(task.id)}">+1 día</button><button class="btn ghost xs" data-action="crm-task-cancel" data-id="${esc(task.id)}">${icon("x", "xs")}</button></div>`).join("") || '<p class="sub">Sin seguimientos programados.</p>'}
          <form id="crm-task-form" class="crm-inline-form" data-id="${esc(card.id)}">
            <input name="title" data-keep-value="task-title" required placeholder="Ej: Volver a contactar" />
            <input name="dueAt" type="datetime-local" required value="${esc(localDateTime(defaultDue))}" />
            <input name="agent" list="crm-agents" value="${esc(card.agent || actor())}" aria-label="Responsable" />
            <button type="submit" class="btn primary sm">${icon("calendar", "sm")} Programar</button>
          </form>
          ${doneTasks.length ? `<details class="crm-done"><summary>${doneTasks.length} seguimiento(s) terminados</summary>${doneTasks.map((task) => `<div class="sub">${task.status === "done" ? "✓" : "✕"} ${esc(task.title)} · ${when(task.completedAt)}${task.result ? ` — ${esc(task.result)}` : ""}</div>`).join("")}</details>` : ""}
        </section>
        <section class="crm-section"><h3>Notas, cotizaciones y archivos</h3>
          <form id="crm-note-form" data-id="${esc(card.id)}">
            <div class="crm-note-kind">${[["note", "Nota"], ["call", "Llamada"], ["quote", "Cotización"]].map(([key, label], index) => `<label class="check-chip"><input type="radio" name="kind" value="${key}" ${index === 0 ? "checked" : ""} /> ${label}</label>`).join("")}</div>
            <textarea name="text" data-keep-value="note" placeholder="Nota interna: lo que conversaron, condiciones, próxima propuesta…"></textarea>
            <div class="actions">${state.crm.noteMedia.map((item) => `<span class="tag">${icon("clip", "xs")} ${esc(item.name)}</span>`).join("")}<button type="button" class="btn ghost sm" data-action="crm-attach">${icon("clip", "sm")} Adjuntar archivo</button><span class="grow"></span><button type="submit" class="btn soft sm">${icon("check", "sm")} Guardar</button></div>
          </form>
        </section>
        ${detail.otherCards.length ? `<section class="crm-section"><h3>Otras tarjetas de esta persona</h3>${detail.otherCards.map((other) => `<button class="row hover crm-other" data-action="crm-open" data-id="${esc(other.id)}"><span class="grow"><span class="title">${esc(other.title)}</span><span class="sub">${esc(other.boardName)} · ${esc(other.stageName)}</span></span><span class="tag">${esc({ open: "Abierta", won: "Ganada", lost: "Perdida" }[other.status] || other.status)}</span></button>`).join("")}</section>` : ""}
        ${detail.campaigns.length ? `<section class="crm-section"><h3>Campañas recibidas</h3>${detail.campaigns.map((entry) => `<div class="sub">${esc(entry.name)} · ${esc(CAMPAIGN_CHANNELS[entry.channel] || entry.channel)} · ${entry.status === "eligible" ? "incluido" : `excluido (${esc(entry.reason || "")})`}</div>`).join("")}</section>` : ""}
        <section class="crm-section"><h3>Historial</h3><div class="crm-timeline">${timeline.map((item) => `<div class="crm-tl">${item.html}</div>`).join("") || '<p class="sub">Sin movimientos.</p>'}</div></section>
      </div>
      <footer class="crm-drawer-foot"><button class="btn danger sm" data-action="crm-delete" data-id="${esc(card.id)}">${icon("trash", "sm")} Eliminar tarjeta</button><button class="btn ghost sm" data-action="crm-delete-contact" data-id="${esc(contact.id)}" title="Borra a la persona con todas sus tarjetas, mensajes y tareas">Borrar datos del contacto</button><span class="grow"></span><span class="sub">Estado: ${esc({ open: "Abierta", won: "Ganada", lost: "Perdida" }[card.status] || card.status)}</span></footer>`;
  }

  fileInput.addEventListener("change", async () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = "";
    if (!files.length) return;
    await run(null, null, async () => {
      const uploaded = await uploadMediaFiles(files);
      state.crm.noteMedia.push(...uploaded);
      renderDrawer();
      toast(`${uploaded.length} archivo(s) listo(s): guardá la nota para adjuntarlos.`);
    });
  });

  /* ---------------------------------------------------------- Tareas */
  function tasksTab() {
    const crm = state.crm;
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
    const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
    const groups = crm.taskScope === "open"
      ? [
        ["Vencidas", crm.tasks.filter((task) => Date.parse(task.dueAt) <= Date.now())],
        ["Hoy", crm.tasks.filter((task) => Date.parse(task.dueAt) > Date.now() && Date.parse(task.dueAt) <= endToday.getTime())],
        ["Próximas", crm.tasks.filter((task) => Date.parse(task.dueAt) > endToday.getTime())],
      ]
      : [["Todos los seguimientos", crm.tasks]];
    return `<div class="pills"><button class="pill ${crm.taskScope === "open" ? "active" : ""}" data-action="crm-task-scope" data-scope="open">Pendientes</button><button class="pill ${crm.taskScope === "all" ? "active" : ""}" data-action="crm-task-scope" data-scope="all">Todos</button></div>
      ${groups.map(([title, items]) => `<section class="card"><div class="card-head"><h3>${esc(title)} <span class="tag ${title === "Vencidas" && items.length ? "red" : ""}">${items.length}</span></h3></div><div class="card-body"><div class="rows">${items.length ? items.map((task) => `<div class="row">
          <span class="kpi-icon ${task.status !== "open" ? "bg-green" : Date.parse(task.dueAt) <= Date.now() ? "bg-red" : "bg-blue"}">${icon(task.status === "done" ? "check" : "clock")}</span>
          <span class="grow"><span class="title">${esc(task.title)} · ${esc(task.contactName)}</span><span class="sub">${esc(dueLabel(task.dueAt))} · ${esc(task.boardName)} / ${esc(task.stageName)}${task.agent ? ` · ${esc(task.agent)}` : ""}${task.result ? ` · Resultado: ${esc(task.result)}` : ""}</span></span>
          ${task.status === "open" ? `<button class="btn soft xs" data-action="crm-task-done" data-id="${esc(task.id)}">${icon("check", "xs")} Hecha</button><button class="btn ghost xs" data-action="crm-task-snooze" data-id="${esc(task.id)}">+1 día</button>` : `<span class="tag ${task.status === "done" ? "green" : ""}">${task.status === "done" ? "Hecha" : "Cancelada"}</span>`}
          <button class="btn ghost xs" data-action="crm-open" data-id="${esc(task.opportunityId)}">Abrir</button></div>`).join("") : '<p class="sub">Nada por acá.</p>'}</div></div></section>`).join("")}`;
  }

  /* ---------------------------------------------------------- Contactos */
  function contactsTab() {
    const crm = state.crm;
    return `<section class="card card-pad filter-bar">
        <input type="search" id="crm-contacts-q" placeholder="Buscar por nombre, teléfono o correo…" value="${esc(crm.contactsQuery)}" />
        <label class="check-chip"><input type="checkbox" id="crm-only-dups" ${crm.onlyDuplicates ? "checked" : ""} /> Solo posibles duplicados</label>
        <a class="btn ghost sm" href="${window.NIRO_BASE || ""}/api/export?kind=crm-contacts&format=csv" download>${icon("download", "sm")} Contactos CSV</a>
        <a class="btn ghost sm" href="${window.NIRO_BASE || ""}/api/export?kind=crm-opportunities&format=csv" download>${icon("download", "sm")} Oportunidades CSV</a>
      </section>
      <section class="card"><div class="card-body">${crm.contacts.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Persona</th><th>Contacto</th><th>Canales</th><th>Tarjetas</th><th>Último contacto</th><th>Posible duplicado</th><th></th></tr></thead><tbody>
        ${crm.contacts.map((contact) => `<tr>
          <td><div style="display:flex;gap:8px;align-items:center">${avatar(contact.name, { size: "sm", seed: contact.id, image: contact.avatarUrl })}<b>${esc(contact.name)}</b></div></td>
          <td>${esc([contact.phone, contact.email].filter(Boolean).join(" · ") || "—")}</td>
          <td>${contact.channels.map((channel) => `<span class="tag">${esc(IDENTITY_LABELS[channel] || channel)}</span>`).join(" ")}</td>
          <td class="mono">${contact.cards}</td>
          <td class="time">${contact.lastContactAt ? timeAgo(contact.lastContactAt) : "—"}</td>
          <td>${contact.duplicates.map((entry) => `<div class="crm-dup"><span>${esc(entry.name)} <small class="sub">(${esc(entry.reason)})</small></span><button class="btn soft xs" data-action="crm-merge" data-target="${esc(contact.id)}" data-source="${esc(entry.contactId)}">Unir</button><button class="btn ghost xs" data-action="crm-dismiss-dup" data-contact="${esc(contact.id)}" data-other="${esc(entry.contactId)}">No es</button></div>`).join("") || "—"}</td>
          <td><div class="actions" style="flex-wrap:nowrap">${contact.latestOpportunityId ? `<button class="btn ghost xs" data-action="crm-open" data-id="${esc(contact.latestOpportunityId)}">Ver tarjeta</button>` : ""}<button class="round-btn danger-btn" data-action="crm-delete-contact" data-id="${esc(contact.id)}" title="Borrar datos del contacto" aria-label="Borrar datos de ${esc(contact.name)}">${icon("trash", "sm")}</button></div></td>
        </tr>`).join("")}</tbody></table></div>` : emptyState("users", crm.contactsQuery || crm.onlyDuplicates ? "Sin resultados" : "Todavía no hay contactos", "Los contactos se crean solos cuando alguien escribe, comenta con interés o completa un formulario.")}</div></section>`;
  }

  /* ---------------------------------------------------------- Campañas */
  function campaignsTab() {
    const crm = state.crm;
    const filters = crm.campaign.filters;
    const boardId = filters.boardId || "";
    const stages = boardId ? stagesOf(boardId) : [];
    const preview = crm.campaign.preview;
    const sources = new Map();
    for (const card of crm.data.cards) {
      if (card.source?.publicationId) sources.set(card.source.publicationId, `Publicación: ${(state.publications || []).find((item) => item.id === card.source.publicationId)?.text?.slice(0, 50) || card.source.publicationId}`);
      if (card.source?.campaign) sources.set(card.source.campaign, `Campaña: ${card.source.campaign}`);
      if (card.source?.formId) sources.set(card.source.formId, `Formulario: ${card.source.formName || card.source.formId}`);
    }
    return `<section class="card"><div class="card-head"><div><h3>Destinatarios desde el CRM</h3><span class="sub">El CRM elige a las personas; cada canal decide si puede recibir ese mensaje. Un «me gusta» nunca cuenta como permiso para escribir.</span></div></div>
        <div class="card-body"><form id="crm-campaign-form" class="prompt-grid">
          <label class="field">Canal de la campaña<select name="channel">${Object.entries(CAMPAIGN_CHANNELS).map(([key, label]) => `<option value="${key}" ${filters.channel === key ? "selected" : ""}>${label}</option>`).join("")}</select></label>
          <label class="field">Tablero<select name="boardId"><option value="">Todos</option>${crm.data.boards.map((board) => `<option value="${esc(board.id)}" ${boardId === board.id ? "selected" : ""}>${esc(board.name)}</option>`).join("")}</select></label>
          <label class="field">Etiquetas (todas)<input name="tags" value="${esc(filters.tags)}" placeholder="mayorista, urgente" /></label>
          <label class="field">Producto de interés<input name="product" value="${esc(filters.product)}" placeholder="Niro Bot" /></label>
          <label class="field">Campaña o publicación de origen<select name="source"><option value="">Cualquiera</option>${[...sources].map(([key, label]) => `<option value="${esc(key)}" ${filters.source === key ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></label>
          <label class="field">Último contacto desde<input name="lastContactFrom" type="date" value="${esc(filters.lastContactFrom)}" /></label>
          <label class="field">Último contacto hasta<input name="lastContactTo" type="date" value="${esc(filters.lastContactTo)}" /></label>
          <label class="check-chip" style="align-self:end"><input type="checkbox" name="requireConsent" ${filters.requireConsent ? "checked" : ""} /> Solo con autorización registrada</label>
          ${stages.length ? `<fieldset class="crm-stage-pick" style="grid-column:1/-1"><legend>Columnas</legend>${stages.map((stage) => `<label class="check-chip"><input type="checkbox" name="stageIds" value="${esc(stage.id)}" ${filters.stageIds.includes(stage.id) ? "checked" : ""} /> ${esc(stage.name)}</label>`).join("")}</fieldset>` : ""}
          <div class="actions" style="grid-column:1/-1"><button type="submit" class="btn primary sm">${icon("users", "sm")} Ver destinatarios</button></div>
        </form>
        ${preview ? `<div class="crm-preview">
          <p class="crm-preview-head">Se encontraron <b>${preview.total}</b> contacto(s); <b>${preview.available}</b> tienen un canal disponible para esta campaña por ${esc(CAMPAIGN_CHANNELS[filters.channel])}.</p>
          ${Object.keys(preview.excluded).length ? `<ul class="crm-excluded">${Object.entries(preview.excluded).map(([reason, count]) => `<li><b>${count}</b> ${esc(reason)}</li>`).join("")}</ul>` : ""}
          ${filters.channel === "messenger" ? '<p class="sub">Messenger: Meta permite escribir libremente dentro de las 24 h del último mensaje de la persona; fuera de esa ventana solo con modalidades específicas.</p>' : ""}
          <div class="table-wrap"><table class="data"><thead><tr><th>Persona</th><th>Contacto</th><th>Etapa</th><th>Último contacto</th><th>Estado</th></tr></thead><tbody>${preview.rows.slice(0, 60).map((row) => `<tr><td><b>${esc(row.name)}</b></td><td>${esc([row.phone, row.email].filter(Boolean).join(" · ") || "—")}</td><td>${esc(row.stage)}</td><td class="time">${row.lastContactAt ? timeAgo(row.lastContactAt) : "—"}</td><td>${row.available ? '<span class="tag green">Disponible</span>' : `<span class="tag" title="${esc(row.reason)}">${esc(row.reason)}</span>`}</td></tr>`).join("")}</tbody></table></div>
          ${preview.rows.length > 60 ? `<p class="sub">Se muestran 60 de ${preview.rows.length}.</p>` : ""}
          <form id="crm-campaign-save" class="crm-inline-form" style="margin-top:12px"><input name="name" required placeholder="Nombre de la campaña" value="${esc(crm.campaign.name)}" /><input name="message" placeholder="Mensaje (opcional, para tu referencia)" value="${esc(crm.campaign.message)}" /><button type="submit" class="btn soft sm" ${preview.total ? "" : "disabled"}>${icon("check", "sm")} Guardar selección</button></form>
        </div>` : ""}
        </div></section>
      <section class="card"><div class="card-head"><div><h3>Campañas guardadas</h3><span class="sub">Descargá los destinatarios disponibles para enviarlos desde Niro (SMS o WhatsApp). Cada persona queda con la campaña en su historial.</span></div></div>
        <div class="card-body"><div class="rows">${crm.campaigns.length ? crm.campaigns.map((campaign) => `<div class="row"><span class="kpi-icon bg-violet">${icon("rocket")}</span><span class="grow"><span class="title">${esc(campaign.name)}</span><span class="sub">${esc(CAMPAIGN_CHANNELS[campaign.channel] || campaign.channel)} · ${campaign.available} disponibles de ${campaign.total} · ${when(campaign.createdAt)} · ${esc(campaign.createdBy || "")}</span></span><a class="btn ghost xs" href="${window.NIRO_BASE || ""}/api/crm/campaigns/${encodeURIComponent(campaign.id)}/recipients?format=csv" download>${icon("download", "xs")} CSV</a></div>`).join("") : '<p class="sub">Todavía no guardaste campañas.</p>'}</div></div></section>`;
  }

  /* ---------------------------------------------------------- Reportes */
  function reportsTab() {
    const crm = state.crm;
    const report = crm.report;
    const filter = crm.reportFilter;
    const presets = [["7", "7 días"], ["30", "30 días"], ["90", "90 días"], ["all", "Todo"], ["custom", "Personalizado"]];
    const controls = `<section class="card card-pad filter-bar crm-report-filters">
        <div class="pills">${presets.map(([key, label]) => `<button class="pill ${filter.preset === key ? "active" : ""}" data-action="crm-report-preset" data-preset="${key}">${label}</button>`).join("")}</div>
        ${filter.preset === "custom" ? `<label class="field">Desde<input type="date" data-crm-report="from" value="${esc(filter.from)}" /></label><label class="field">Hasta<input type="date" data-crm-report="to" value="${esc(filter.to)}" /></label>` : ""}
        <label class="field">Tablero<select data-crm-report="boardId">${crm.data.boards.map((board) => `<option value="${esc(board.id)}" ${(filter.boardId || crm.boardId) === board.id ? "selected" : ""}>${esc(board.name)}</option>`).join("")}</select></label>
      </section>`;
    if (!report) return `${controls}<section class="card">${emptyState("activity", "Cargando reporte…", "")}</section>`;
    const totals = report.totals;
    const pct = (value) => (totals.interested ? `${Math.round((value / totals.interested) * 100)}% de interesados` : "");
    const tiles = [["Interesados", totals.interested, "Tarjetas creadas en el período"], ["Contactados", totals.contacted, pct(totals.contacted)], ["Cotizaciones", totals.quotes, pct(totals.quotes)], ["Ventas", totals.won, pct(totals.won)], ["Valor ganado", money(totals.wonValue) || "Gs. 0", "Suma de tarjetas ganadas"], ["Perdidas", totals.lost, pct(totals.lost)]];
    const max = Math.max(1, ...report.funnel.map((row) => row.count));
    const table = (rows, extra = false) => rows.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Origen</th><th>Interesados</th><th>Contactados</th><th>Cotizaciones</th><th>Ventas</th><th>Valor ganado</th>${extra ? "<th>Reacciones</th><th>Compartidos</th>" : ""}</tr></thead><tbody>${rows.map((row) => `<tr><td class="text"><span class="clamp">${esc(row.label)}</span></td><td class="mono">${row.interested}</td><td class="mono">${row.contacted}</td><td class="mono">${row.quotes}</td><td class="mono">${row.won}</td><td class="mono">${esc(money(row.wonValue) || "—")}</td>${extra ? `<td class="mono">${row.reactions ?? "—"}</td><td class="mono">${row.shares ?? "—"}</td>` : ""}</tr>`).join("")}</tbody></table></div>` : '<p class="sub">Sin datos en el período.</p>';
    return `${controls}
      <section class="kpis crm-kpis">${tiles.map(([label, value, note]) => `<div class="card kpi"><div><strong>${esc(value)}</strong><span>${esc(label)}</span>${note ? `<small class="sub">${esc(note)}</small>` : ""}</div></div>`).join("")}</section>
      <section class="card"><div class="card-head"><div><h3>Tarjetas por columna hoy</h3><span class="sub">Cantidad actual en cada etapa del tablero ${esc(boardName(filter.boardId || crm.boardId))}</span></div></div>
        <div class="card-body"><div class="crm-bars" role="list">${report.funnel.map((row) => `<div class="crm-bar-row" role="listitem"><span class="crm-bar-label">${esc(row.name)}</span><div class="crm-bar-track"><span class="crm-bar" tabindex="0" data-crm-tip="${esc(`${row.name}: ${row.count} tarjeta(s)${row.value ? ` · ${money(row.value)}` : ""}`)}" style="width:${Math.max(row.count ? 2 : 0, (row.count / max) * 100)}%"></span><span class="crm-bar-value">${row.count}</span></div></div>`).join("")}</div></div></section>
      <section class="card"><div class="card-head"><div><h3>Resultados por publicación, formulario o campaña</h3><span class="sub">Atribución: red → cuenta → campaña → publicación o anuncio → interacción → contacto → oportunidad → venta</span></div></div><div class="card-body">${table(report.bySource, true)}</div></section>
      <section class="grid-2">
        <div class="card"><div class="card-head"><h3>Por canal</h3></div><div class="card-body">${table(report.byChannel)}</div></div>
        <div class="card"><div class="card-head"><h3>Por responsable</h3></div><div class="card-body">${table(report.byAgent)}</div></div>
      </section>
      <section class="grid-2">
        <div class="card"><div class="card-head"><h3>Motivos de pérdida</h3></div><div class="card-body"><div class="rows">${report.lostReasons.map((row) => `<div class="row"><span class="grow">${esc(row.reason)}</span><span class="mono">${row.count}</span></div>`).join("") || '<p class="sub">Sin oportunidades perdidas en el período.</p>'}</div></div></div>
        <div class="card"><div class="card-head"><div><h3>Publicaciones con reacciones y sin interesados</h3><span class="sub">Interés que todavía no se convirtió en conversación.</span></div></div><div class="card-body"><div class="rows">${report.publicationsWithoutLeads.map((row) => `<div class="row"><span class="grow"><span class="title">${esc(row.text)}</span><span class="sub">${esc(row.target)}</span></span><span class="mono">${row.reactions} · ${row.shares}</span></div>`).join("") || '<p class="sub">Nada para mostrar.</p>'}</div></div></div>
      </section>`;
  }

  // Tooltip del gráfico: se completa con textContent (los nombres vienen de los usuarios).
  const tip = Object.assign(document.createElement("div"), { className: "crm-tip hidden", role: "tooltip" });
  document.body.appendChild(tip);
  const showTip = (target) => {
    tip.textContent = target.dataset.crmTip;
    tip.classList.remove("hidden");
    const rect = target.getBoundingClientRect();
    tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, rect.left + rect.width / 2 - tip.offsetWidth / 2))}px`;
    tip.style.top = `${rect.top - tip.offsetHeight - 8 + window.scrollY}px`;
  };
  document.addEventListener("pointerover", (event) => { const target = event.target.closest?.("[data-crm-tip]"); if (target) showTip(target); });
  document.addEventListener("pointerout", (event) => { if (event.target.closest?.("[data-crm-tip]")) tip.classList.add("hidden"); });
  document.addEventListener("focusin", (event) => { const target = event.target.closest?.("[data-crm-tip]"); if (target) showTip(target); else tip.classList.add("hidden"); });

  /* ---------------------------------------------------------- Configuración */
  function settingsTab() {
    const crm = state.crm;
    const data = crm.data;
    const board = data.board;
    const settings = data.settings;
    const pipelines = board?.pipelines || [];
    const stages = board ? stagesOf(board.id, crm.pipelineId) : [];
    const counts = new Map();
    for (const card of data.cards) counts.set(card.stageId, (counts.get(card.stageId) || 0) + 1);
    const webhooks = crm.webhooks || {};
    const base = location.origin;
    return `${board ? `<section class="card"><div class="card-head"><div><h3>Tablero “${esc(board.name)}”</h3><span class="sub">${board.id === settings.defaultBoardId ? "Tablero por defecto: recibe lo que no tiene otro destino." : "Las consultas llegan acá cuando la publicación lo indica o el texto trae una palabra clave."}</span></div>
          <div class="actions">${board.id !== settings.defaultBoardId ? `<button class="btn ghost sm" data-action="crm-default-board" data-id="${esc(board.id)}">Usar por defecto</button>` : ""}<button class="btn ghost sm" data-action="crm-archive-board" data-id="${esc(board.id)}">${board.archived ? "Reactivar" : "Archivar"}</button><button class="btn danger sm" data-action="crm-delete-board" data-id="${esc(board.id)}">${icon("trash", "sm")}</button></div></div>
        <div class="card-body"><form id="crm-board-form" class="prompt-grid" data-id="${esc(board.id)}">
          <label class="field">Nombre<input name="name" required value="${esc(board.name)}" /></label>
          <label class="field">Color<input name="color" type="color" value="${esc(board.color || "#6857e7")}" /></label>
          <label class="field">Descripción<input name="description" value="${esc(board.description || "")}" /></label>
          <label class="field">Palabras clave que envían consultas a este tablero<textarea name="routingKeywords" placeholder="sms masivo, mensajes de texto">${esc((board.routingKeywords || []).join(", "))}</textarea></label>
          <fieldset class="crm-pipes" style="grid-column:1/-1"><legend>Embudos del tablero</legend>${pipelines.map((pipeline) => `<input name="pipeline" data-id="${esc(pipeline.id)}" value="${esc(pipeline.name)}" aria-label="Nombre del embudo" />`).join("")}<input name="pipeline-new" placeholder="+ Nuevo embudo (opcional)" aria-label="Nuevo embudo" /><small class="sub">Borrá el nombre de un embudo sin tarjetas para quitarlo.</small></fieldset>
          <div class="actions" style="grid-column:1/-1"><button type="submit" class="btn primary sm">${icon("check", "sm")} Guardar tablero</button></div>
        </form></div></section>
      <section class="card"><div class="card-head"><div><h3>Columnas${pipelines.length > 1 ? ` · ${esc(pipelines.find((pipeline) => pipeline.id === crm.pipelineId)?.name || "")}` : ""}</h3><span class="sub">El tipo define los reportes: contactado, cotización, ganado y perdido.</span></div>${pipelines.length > 1 ? `<div class="segmented crm-pipelines">${pipelines.map((pipeline) => `<button class="${pipeline.id === crm.pipelineId ? "active" : ""}" data-action="crm-pipeline" data-id="${esc(pipeline.id)}">${esc(pipeline.name)}</button>`).join("")}</div>` : ""}</div>
        <div class="card-body"><div class="rows">${stages.map((stage, index) => `<form class="row crm-stage-row" data-crm-stage-form="${esc(stage.id)}">
            <input type="color" name="color" value="${esc(stage.color || "#858797")}" aria-label="Color" />
            <input name="name" value="${esc(stage.name)}" required aria-label="Nombre de la columna" />
            <select name="kind" aria-label="Tipo">${Object.entries(data.stageKinds).map(([key, label]) => `<option value="${key}" ${stage.kind === key ? "selected" : ""}>${label}</option>`).join("")}</select>
            <span class="tag">${counts.get(stage.id) || 0}</span>
            <button type="submit" class="btn soft xs">Guardar</button>
            <button type="button" class="btn ghost xs" data-action="crm-stage-up" data-id="${esc(stage.id)}" ${index === 0 ? "disabled" : ""} aria-label="Subir">↑</button>
            <button type="button" class="btn ghost xs" data-action="crm-stage-down" data-id="${esc(stage.id)}" ${index === stages.length - 1 ? "disabled" : ""} aria-label="Bajar">↓</button>
            ${counts.get(stage.id) ? `<select name="moveTo" aria-label="Pasar tarjetas a">${stages.filter((other) => other.id !== stage.id).map((other) => `<option value="${esc(other.id)}">→ ${esc(other.name)}</option>`).join("")}</select>` : ""}
            <button type="button" class="round-btn danger-btn" data-action="crm-stage-delete" data-id="${esc(stage.id)}" aria-label="Eliminar columna">${icon("trash", "sm")}</button>
          </form>`).join("")}</div>
          <form id="crm-stage-new" class="crm-inline-form" style="margin-top:10px"><input name="name" required placeholder="Nueva columna" /><select name="kind">${Object.entries(data.stageKinds).map(([key, label]) => `<option value="${key}" ${key === "open" ? "selected" : ""}>${label}</option>`).join("")}</select><button type="submit" class="btn soft sm">${icon("plus", "sm")} Agregar columna</button></form>
        </div></section>` : ""}
      <section class="card"><div class="card-head"><h3>Nuevo tablero</h3></div><div class="card-body"><form id="crm-board-new" class="crm-inline-form"><input name="name" required placeholder="Ej: Ventas SMS, Soporte, Campaña de septiembre" /><select name="template"><option value="sales">Columnas de ventas (6)</option><option value="empty">Solo “Nuevo interés”</option></select><input name="routingKeywords" placeholder="Palabras clave (opcional)" /><button type="submit" class="btn primary sm">${icon("plus", "sm")} Crear tablero</button></form></div></section>
      <section class="card"><div class="card-head"><div><h3>Captura automática</h3><span class="sub">Qué interacciones crean o actualizan tarjetas.</span></div></div><div class="card-body">
        ${[["messenger", "Mensajes de Messenger", "Crea o actualiza la tarjeta y vincula la conversación."], ["comments", "Comentarios con consultas", "«precio», «más información», preguntas… También los que la IA clasifica como interés de compra."], ["aiLeads", "Datos aportados a la IA", "Teléfono o correo que la persona escribe quedan en su contacto."], ["reactions", "Me gusta y compartidos", "Solo suman métricas de la publicación: no crean tarjetas."]].map(([key, title, text]) => `<div class="automation"><div class="grow"><strong>${title}</strong><small>${text}</small></div><button class="switch ${settings.capture[key] ? "on" : ""}" data-action="crm-capture-setting" data-key="${key}" aria-pressed="${Boolean(settings.capture[key])}" aria-label="${esc(title)}"></button></div>`).join("")}
      </div></section>
      <section class="card"><div class="card-head"><div><h3>Agentes y departamentos</h3><span class="sub">Para asignar tarjetas y seguimientos. Cada persona elige “Trabajás como” arriba: así queda quién movió cada tarjeta.</span></div></div><div class="card-body">
        <div class="rows">${settings.agents.map((agent, index) => `<div class="row"><span class="crm-agent">${esc(initialsOf(agent.name))}</span><span class="grow"><span class="title">${esc(agent.name)}</span><span class="sub">${esc(agent.department || "Sin departamento")}</span></span><button class="round-btn danger-btn" data-action="crm-agent-remove" data-index="${index}" aria-label="Quitar">${icon("trash", "sm")}</button></div>`).join("") || '<p class="sub">Sin agentes cargados: se usa tu nombre.</p>'}</div>
        <form id="crm-agent-new" class="crm-inline-form" style="margin-top:10px"><input name="name" required placeholder="Nombre del agente" /><input name="department" list="crm-departments-all" placeholder="Departamento" /><button type="submit" class="btn soft sm">${icon("plus", "sm")} Agregar</button></form>
        <datalist id="crm-departments-all">${settings.departments.map((name) => `<option value="${esc(name)}"></option>`).join("")}</datalist>
        <form id="crm-departments" class="crm-inline-form" style="margin-top:10px"><input name="departments" value="${esc(settings.departments.join(", "))}" aria-label="Departamentos" /><button type="submit" class="btn ghost sm">Guardar departamentos</button></form>
        <p class="sub" style="margin-top:8px">Los permisos por empresa, departamento y tablero necesitan cuentas de usuario propias: hoy el panel tiene una sola contraseña, así que todos los que entran ven todos los tableros.</p>
      </div></section>
      <section class="card"><div class="card-head"><div><h3>Formularios de anuncios (webhooks)</h3><span class="sub">Meta y Google Ads envían cada formulario completado al CRM. El panel tiene que estar publicado con HTTPS (proxy o túnel) y el dominio en NIRO_ALLOWED_HOSTS.</span></div></div><div class="card-body"><div class="rows">
        ${[["Meta Lead Ads", webhooks.meta, `${base}/api/crm/webhooks/meta`, `NIRO_META_VERIFY_TOKEN y NIRO_META_APP_SECRET${webhooks.metaToken ? "" : " · falta NIRO_META_PAGE_TOKEN para traer los datos"}`], ["Google Ads (formularios)", webhooks.google, `${base}/api/crm/webhooks/google`, "NIRO_GOOGLE_LEAD_KEY (la misma clave que ponés en Google Ads)"], ["Formulario web propio", webhooks.web, `${base}/api/crm/webhooks/web`, "NIRO_WEB_FORM_TOKEN (cabecera x-niro-token)"]].map(([title, ready, endpoint, env]) => `<div class="row"><span class="kpi-icon ${ready ? "bg-green" : "bg-orange"}">${icon(ready ? "check" : "alert")}</span><span class="grow"><span class="title">${title}</span><span class="sub mono">${esc(endpoint)}</span><span class="sub">${ready ? "Configurado" : "Sin configurar"} · ${esc(env)}</span></span></div>`).join("")}
      </div></div></section>`;
  }

  /* ---------------------------------------------------------- Integraciones con el resto del panel */
  // Editor de Autopost: "Enviar interesados al tablero".
  state.composer.crm = storage.get("niro-composer-crm", { boardId: "", stageId: "", agent: "" });
  hooks.composerSections.push(() => {
    const routing = state.composer.crm;
    const data = state.crm.data;
    if (!data) { if (!loading) loadCrm({ render: false }).then(() => { if (state.route === "publicar" && !isTyping()) renderView(); }).catch(() => {}); return ""; }
    const boards = data.boards.filter((board) => !board.archived);
    const stages = routing.boardId ? stagesOf(routing.boardId).filter((stage) => !["won", "lost"].includes(stage.kind)) : [];
    return `<details class="composer-ai composer-crm" ${routing.boardId ? "open" : ""}>
      <summary>${icon("users", "sm")} <b>Enviar interesados al CRM</b><span class="tag ${routing.boardId ? "violet" : ""}">${routing.boardId ? esc(boardName(routing.boardId)) : "Sin tablero"}</span></summary>
      <div class="prompt-grid" style="margin-top:10px">
        <label class="field">Enviar interesados al tablero<select id="composer-crm-board"><option value="">No enviar al CRM</option>${boards.map((board) => `<option value="${esc(board.id)}" ${routing.boardId === board.id ? "selected" : ""}>${esc(board.name)}</option>`).join("")}</select></label>
        <label class="field">Columna inicial<select id="composer-crm-stage" ${routing.boardId ? "" : "disabled"}>${stages.map((stage) => `<option value="${esc(stage.id)}" ${routing.stageId === stage.id ? "selected" : ""}>${esc(stage.name)}</option>`).join("")}</select></label>
        <label class="field">Agente o departamento<input id="composer-crm-agent" list="composer-crm-agents" value="${esc(routing.agent || "")}" placeholder="Ventas" /><datalist id="composer-crm-agents">${[...agentNames(), ...(data.settings.departments || [])].map((name) => `<option value="${esc(name)}"></option>`).join("")}</datalist></label>
      </div>
      <p class="sub">Los comentarios con consultas que lleguen por esta publicación entran a ese tablero con la publicación como origen (red → cuenta → campaña → publicación → interacción → contacto → oportunidad).</p>
    </details>`;
  });
  hooks.composerPayload.push(() => {
    const routing = state.composer.crm;
    return routing.boardId ? { crm: { boardId: routing.boardId, stageId: routing.stageId || null, agent: routing.agent || null } } : {};
  });
  document.addEventListener("change", (event) => {
    const target = event.target;
    const routing = state.composer.crm;
    if (target.id === "composer-crm-board") {
      routing.boardId = target.value;
      routing.stageId = routing.boardId ? stagesOf(routing.boardId).find((stage) => stage.kind === "new")?.id || "" : "";
      storage.set("niro-composer-crm", routing);
      renderView();
    } else if (target.id === "composer-crm-stage") { routing.stageId = target.value; storage.set("niro-composer-crm", routing); }
  });
  document.addEventListener("input", (event) => {
    if (event.target.id === "composer-crm-agent") { state.composer.crm.agent = event.target.value; storage.set("niro-composer-crm", state.composer.crm); }
  });

  // Messenger y Notificaciones: "Enviar al CRM" / "Ver en CRM".
  const linkButton = (opportunityId, captureAttrs) => opportunityId
    ? `<button class="btn soft sm" data-action="crm-open-link" data-id="${esc(opportunityId)}">${icon("users", "sm")} Ver en CRM</button>`
    : `<button class="btn ghost sm" data-action="crm-capture" ${captureAttrs}>${icon("users", "sm")} Enviar al CRM</button>`;
  const ensureLinks = () => { if (!state.crm.data && !loading) loadCrm({ render: false }).then(() => { if (["messenger", "notificaciones"].includes(state.route) && !isTyping()) renderView(); }).catch(() => {}); };
  hooks.conversationActions.push((chat) => { ensureLinks(); return linkButton(state.crm.data?.chatLinks?.[chat.id], `data-chat="${esc(chat.id)}"`); });
  hooks.eventActions.push((event) => {
    if (event.source !== "messenger" && !["comment", "mention"].includes(event.kind)) return "";
    ensureLinks();
    const chat = event.source === "messenger" ? (state.chats || []).find((item) => item.url === event.url || event.externalId?.startsWith(`${item.id}:`)) : null;
    return linkButton(state.crm.data?.eventLinks?.[event.id] || (chat && state.crm.data?.chatLinks?.[chat.id]), `data-event="${esc(event.id)}"`);
  });
  hooks.chrome.push((status) => {
    const node = $("#side-crm-count");
    if (!node) return;
    const overdue = status.crm?.tasksOverdue || 0;
    node.textContent = overdue > 99 ? "99+" : overdue;
    node.classList.toggle("hidden", !overdue);
  });

  /* ---------------------------------------------------------- Acciones */
  const idOf = (el) => el.dataset.id;
  Object.assign(actions, {
    "crm-tab": (el) => { state.crm.tab = el.dataset.tab; state.crm.newCard = null; renderView(); run(null, null, async () => { await loadTab(); renderView(); }); },
    "crm-pipeline": (el) => { state.crm.pipelineId = el.dataset.id; renderView(); },
    "crm-new": (el) => { state.crm.newCard = { stageId: el.dataset.stage || null }; state.crm.tab = "tablero"; renderView(); $("#crm-new-form [name='name']")?.focus(); window.scrollTo({ top: 0, behavior: "smooth" }); },
    "crm-new-cancel": () => { state.crm.newCard = null; renderView(); },
    "crm-col-more": (el) => { state.crm.columnLimit[el.dataset.stage] = (state.crm.columnLimit[el.dataset.stage] || 50) + 50; renderView(); },
    "crm-open": (el) => openCard(idOf(el)),
    "crm-open-link": (el) => { navigate("#/crm"); openCard(idOf(el)); },
    "crm-close": () => closeDrawer(),
    "crm-show-duplicates": () => { Object.assign(state.crm, { tab: "contactos", onlyDuplicates: true }); run(null, null, async () => { await loadTab(); renderView(); }); },
    "crm-history-reason": (el) => addHistoryReason(idOf(el)),
    "crm-mark": (el) => {
      const card = state.crm.detail?.opportunity;
      const stage = card && stagesOf(card.boardId, card.pipelineId).find((item) => item.kind === el.dataset.kind);
      if (!stage) { toast(`Este embudo no tiene una columna de tipo “${el.dataset.kind === "won" ? "Ganado" : "Perdido"}”.`, { error: true }); return; }
      moveCard(card.id, stage.id, null, $("#crm-move-reason")?.value || null);
    },
    "crm-reply": (el) => {
      const text = $("#crm-reply")?.value.trim();
      if (!text) { toast("Escribí el mensaje.", { error: true }); return; }
      run(el, "Abriendo…", async () => {
        await request("/api/reply/prepare", { method: "POST", body: JSON.stringify({ eventId: el.dataset.event, text }) });
        openModal({ kind: "reply", text, eventId: el.dataset.event, isMessenger: Boolean(el.dataset.messenger), targets: [{ name: state.crm.detail?.contact?.name || "" }], actor: actor() });
      });
    },
    "crm-open-chat": (el) => { state.selectedChatId = el.dataset.chat; closeDrawer(); navigate("#/messenger"); },
    "crm-attach": () => fileInput.click(),
    "crm-task-done": async (el) => {
      const task = [...state.crm.tasks, ...(state.crm.detail?.tasks || [])].find((item) => item.id === idOf(el));
      const result = await dialogs.prompt({ title: "Seguimiento hecho", message: task ? `${task.title}${task.contactName ? ` · ${task.contactName}` : ""}` : "", label: "¿Qué resultado tuvo? (queda en el historial)", placeholder: "Ej: pidió cotización formal para el lunes", multiline: true, maxLength: 1000, confirmLabel: "Marcar hecha", iconName: "check" });
      if (result === null) return;
      run(el, null, async () => { await patch(`/api/crm/tasks/${encodeURIComponent(idOf(el))}`, { status: "done", result }); toast("Seguimiento hecho."); await afterTaskChange(); });
    },
    "crm-task-cancel": (el) => run(el, null, async () => { await patch(`/api/crm/tasks/${encodeURIComponent(idOf(el))}`, { status: "cancelled", result: "Cancelado" }); await afterTaskChange(); }),
    "crm-task-snooze": (el) => run(el, null, async () => {
      const task = [...state.crm.tasks, ...(state.crm.detail?.tasks || [])].find((item) => item.id === idOf(el));
      const base = Math.max(Date.now(), Date.parse(task?.dueAt || Date.now()));
      await patch(`/api/crm/tasks/${encodeURIComponent(idOf(el))}`, { dueAt: new Date(base + 86_400_000).toISOString() });
      toast("Seguimiento pospuesto un día.");
      await afterTaskChange();
    }),
    "crm-task-scope": (el) => { state.crm.taskScope = el.dataset.scope; run(null, null, async () => { await loadTab(); renderView(); }); },
    "crm-merge": async (el) => {
      const detail = state.crm.detail;
      const names = [el.dataset.target, el.dataset.source].map((id) => state.crm.contacts.find((item) => item.id === id)?.name || (detail?.contact?.id === id ? detail.contact.name : detail?.duplicates.find((entry) => entry.contact.id === id)?.contact.name) || "el contacto");
      if (!(await dialogs.confirm({ title: `¿Unir “${names[1]}” dentro de “${names[0]}”?`, message: "Pasan sus canales, tarjetas, mensajes y tareas a un solo contacto.\n\nNo se puede deshacer.", confirmLabel: "Unir contactos", tone: "danger", iconName: "users" }))) return;
      run(el, null, async () => { await post("/api/crm/contacts/merge", { targetId: el.dataset.target, sourceId: el.dataset.source }); toast("Contactos unidos."); await loadCrm(); await reloadDetail(); });
    },
    "crm-dismiss-dup": (el) => run(el, null, async () => { await post("/api/crm/contacts/dismiss-duplicate", { contactId: el.dataset.contact, otherId: el.dataset.other }); await loadCrm(); await reloadDetail(); }),
    "crm-delete": async (el) => {
      if (!(await dialogs.confirm({ title: "¿Eliminar esta tarjeta?", message: "El contacto y su historial se conservan.", confirmLabel: "Eliminar tarjeta", tone: "danger" }))) return;
      run(el, null, async () => { await request(`/api/crm/opportunities/${encodeURIComponent(idOf(el))}`, { method: "DELETE", body: "{}" }); closeDrawer(); toast("Tarjeta eliminada."); await loadCrm(); });
    },
    "crm-delete-contact": async (el) => {
      const name = state.crm.contacts.find((item) => item.id === idOf(el))?.name || state.crm.detail?.contact?.name || "este contacto";
      if (!(await dialogs.confirm({ title: `¿Borrar todos los datos de “${name}”?`, message: "Se eliminan la persona, sus canales, tarjetas, mensajes guardados en el CRM, tareas e historial.\n\nNo se puede deshacer. No borra nada en Facebook.", confirmLabel: "Borrar datos", tone: "danger" }))) return;
      run(el, null, async () => {
        const result = await request(`/api/crm/contacts/${encodeURIComponent(idOf(el))}`, { method: "DELETE", body: "{}" });
        if (state.crm.detail?.contact?.id === idOf(el)) closeDrawer();
        toast(`Datos borrados${result.removedCards ? ` (${result.removedCards} tarjeta(s))` : ""}.`);
        await loadCrm();
      });
    },
    "crm-capture": (el) => run(el, "Enviando…", async () => {
      const result = el.dataset.chat ? await post("/api/crm/capture/chat", { chatId: el.dataset.chat }) : await post("/api/crm/capture/event", { eventId: el.dataset.event });
      toast(result.created ? "Tarjeta creada en el CRM." : "Ya tenía una tarjeta: quedó vinculada.", { title: "CRM", action: () => { navigate("#/crm"); openCard(result.opportunity.id); } });
      await loadCrm({ render: false });
      renderView();
    }),
    "crm-report-preset": (el) => { state.crm.reportFilter.preset = el.dataset.preset; run(null, null, async () => { await loadTab(); renderView(); }); },
    "crm-default-board": (el) => run(el, null, async () => { await patch("/api/crm/settings", { defaultBoardId: idOf(el) }); toast("Tablero por defecto actualizado."); await loadCrm(); }),
    "crm-archive-board": (el) => run(el, null, async () => {
      const board = state.crm.data.boards.find((item) => item.id === idOf(el));
      await post("/api/crm/boards", { ...board, archived: !board.archived });
      toast(board.archived ? "Tablero reactivado." : "Tablero archivado: no recibe consultas nuevas.");
      await loadCrm();
    }),
    "crm-delete-board": async (el) => {
      if (!(await dialogs.confirm({ title: "¿Eliminar este tablero?", message: "Solo se puede si no tiene tarjetas. Para conservar sus datos, archivalo.", confirmLabel: "Eliminar tablero", tone: "danger" }))) return;
      run(el, null, async () => { await request(`/api/crm/boards/${encodeURIComponent(idOf(el))}`, { method: "DELETE", body: "{}" }); state.crm.boardId = null; storage.set("niro-crm-board", null); toast("Tablero eliminado."); await loadCrm(); });
    },
    "crm-stage-up": (el) => reorderStage(idOf(el), -1),
    "crm-stage-down": (el) => reorderStage(idOf(el), 1),
    "crm-stage-delete": async (el) => {
      const form = el.closest("[data-crm-stage-form]");
      const moveTo = form?.querySelector("[name='moveTo']")?.value || null;
      const name = form?.querySelector("[name='name']")?.value || "la columna";
      const destination = moveTo ? state.crm.data.stages.find((stage) => stage.id === moveTo)?.name : null;
      if (!(await dialogs.confirm({ title: `¿Eliminar la columna “${name}”?`, message: destination ? `Sus tarjetas pasan a “${destination}”.` : "La columna no tiene tarjetas.", confirmLabel: "Eliminar columna", tone: "danger" }))) return;
      run(el, null, async () => { await request(`/api/crm/stages/${encodeURIComponent(idOf(el))}`, { method: "DELETE", body: JSON.stringify({ moveTo, actor: actor() }) }); toast("Columna eliminada."); await loadCrm(); });
    },
    "crm-agent-remove": (el) => run(el, null, async () => {
      const agents = state.crm.data.settings.agents.filter((_, index) => index !== Number(el.dataset.index));
      await patch("/api/crm/settings", { agents });
      await loadCrm();
    }),
  });
  // Interruptores de captura automática ("crm-capture" es el botón Enviar al CRM).
  actions["crm-capture-setting"] = (el) => run(el, null, async () => {
    const settings = state.crm.data.settings;
    await patch("/api/crm/settings", { capture: { [el.dataset.key]: !settings.capture[el.dataset.key] } });
    await loadCrm();
  });

  async function afterTaskChange() {
    await loadCrm({ render: false });
    if (state.crm.openId) await reloadDetail();
    if (state.route === "crm") { await loadTab(); renderView(); }
  }

  async function reorderStage(id, delta) {
    const stage = state.crm.data.stages.find((item) => item.id === id);
    if (!stage) return;
    const list = stagesOf(stage.boardId, stage.pipelineId);
    const index = list.findIndex((item) => item.id === id);
    const swap = list[index + delta];
    if (!swap) return;
    [list[index], list[index + delta]] = [swap, stage];
    await run(null, null, async () => { await post("/api/crm/stages/reorder", { ids: list.map((item) => item.id) }); await loadCrm(); });
  }

  /* ---------------------------------------------------------- Formularios */
  document.addEventListener("submit", (event) => {
    const form = event.target;
    const data = new FormData(form);
    const submit = form.querySelector("[type='submit']");
    const list = (value) => String(value || "").split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
    const handlers = {
      "crm-new-form": async () => {
        const result = await post("/api/crm/opportunities", { ...Object.fromEntries(data), boardId: state.crm.boardId });
        state.crm.newCard = null;
        toast("Tarjeta creada.", { action: () => openCard(result.opportunity.id) });
        await loadCrm();
      },
      "crm-contact-form": async () => {
        const consent = Object.fromEntries(Object.keys(CAMPAIGN_CHANNELS).map((channel) => [channel, data.get(`consent-${channel}`)]));
        await patch(`/api/crm/contacts/${encodeURIComponent(form.dataset.id)}`, { name: data.get("name"), phone: data.get("phone"), email: data.get("email"), company: data.get("company"), tags: list(data.get("tags")), consent });
        toast("Contacto guardado.");
        await loadCrm({ render: false }); await reloadDetail(); if (state.route === "crm") renderView();
      },
      "crm-opp-form": async () => {
        await patch(`/api/crm/opportunities/${encodeURIComponent(form.dataset.id)}`, { title: data.get("title"), product: data.get("product"), value: data.get("value"), priority: data.get("priority"), agent: data.get("agent"), department: data.get("department"), tags: list(data.get("tags")) });
        toast("Oportunidad guardada.");
        await loadCrm(); await reloadDetail();
      },
      "crm-task-form": async () => {
        const due = Date.parse(data.get("dueAt"));
        await post("/api/crm/tasks", { opportunityId: form.dataset.id, title: data.get("title"), dueAt: Number.isNaN(due) ? "" : new Date(due).toISOString(), agent: data.get("agent") });
        form.reset();
        toast("Seguimiento programado: Niro te avisa cuando llegue la hora.");
        const field = drawer.querySelector("[data-keep-value='task-title']"); if (field) field.value = "";
        await afterTaskChange();
      },
      "crm-note-form": async () => {
        await post(`/api/crm/opportunities/${encodeURIComponent(form.dataset.id)}/notes`, { text: data.get("text"), kind: data.get("kind"), mediaIds: state.crm.noteMedia.map((item) => item.id) });
        state.crm.noteMedia = [];
        const field = drawer.querySelector("[data-keep-value='note']"); if (field) field.value = "";
        toast("Guardado en la tarjeta.");
        await reloadDetail();
      },
      "crm-campaign-form": async () => {
        Object.assign(state.crm.campaign.filters, { channel: data.get("channel"), boardId: data.get("boardId"), tags: data.get("tags"), product: data.get("product"), source: data.get("source"), lastContactFrom: data.get("lastContactFrom"), lastContactTo: data.get("lastContactTo"), requireConsent: data.get("requireConsent") === "on", stageIds: data.getAll("stageIds") });
        const filters = state.crm.campaign.filters;
        state.crm.campaign.preview = await post("/api/crm/campaigns/preview", { ...filters, tags: list(filters.tags) });
        renderView();
      },
      "crm-campaign-save": async () => {
        const filters = state.crm.campaign.filters;
        const result = await post("/api/crm/campaigns", { name: data.get("name"), message: data.get("message"), filters: { ...filters, tags: list(filters.tags) } });
        Object.assign(state.crm.campaign, { preview: null, name: "", message: "" });
        toast(`Campaña “${result.campaign.name}” guardada: ${result.campaign.available} destinatario(s) disponibles.`);
        await loadTab(); renderView();
      },
      "crm-board-form": async () => {
        const board = state.crm.data.boards.find((item) => item.id === form.dataset.id);
        const pipelines = [...form.querySelectorAll("[name='pipeline']")].map((input) => ({ id: input.dataset.id, name: input.value.trim() })).filter((pipeline) => pipeline.name);
        if (data.get("pipeline-new")) pipelines.push({ name: String(data.get("pipeline-new")).trim() });
        await post("/api/crm/boards", { ...board, name: data.get("name"), color: data.get("color"), description: data.get("description"), routingKeywords: list(data.get("routingKeywords")), pipelines });
        toast("Tablero guardado.");
        await loadCrm();
      },
      "crm-board-new": async () => {
        const result = await post("/api/crm/boards", { name: data.get("name"), template: data.get("template"), routingKeywords: list(data.get("routingKeywords")) });
        state.crm.boardId = result.board.id;
        storage.set("niro-crm-board", result.board.id);
        toast(`Tablero “${result.board.name}” creado.`);
        await loadCrm();
      },
      "crm-stage-new": async () => {
        await post("/api/crm/stages", { boardId: state.crm.boardId, pipelineId: state.crm.pipelineId, name: data.get("name"), kind: data.get("kind") });
        toast("Columna agregada.");
        await loadCrm();
      },
      "crm-agent-new": async () => {
        const settings = state.crm.data.settings;
        const departments = data.get("department") && !settings.departments.includes(data.get("department")) ? [...settings.departments, data.get("department")] : settings.departments;
        await patch("/api/crm/settings", { agents: [...settings.agents, { name: data.get("name"), department: data.get("department") }], departments });
        toast("Agente agregado.");
        await loadCrm();
      },
      "crm-departments": async () => { await patch("/api/crm/settings", { departments: list(data.get("departments")) }); toast("Departamentos guardados."); await loadCrm(); },
    };
    const stageId = form.dataset.crmStageForm;
    const handler = stageId
      ? async () => { await post("/api/crm/stages", { id: stageId, name: data.get("name"), kind: data.get("kind"), color: data.get("color") }); toast("Columna guardada."); await loadCrm(); }
      : handlers[form.id];
    if (!handler) return;
    event.preventDefault();
    run(submit, "Guardando…", handler);
  });

  /* ---------------------------------------------------------- Campos y filtros */
  let contactsTimer = null;
  document.addEventListener("input", (event) => {
    const target = event.target;
    if (target.id === "crm-q") { state.crm.search = target.value; rerenderKeepingFocus("crm-q"); }
    else if (target.id === "crm-contacts-q") {
      state.crm.contactsQuery = target.value;
      clearTimeout(contactsTimer);
      contactsTimer = setTimeout(() => run(null, null, async () => { await loadTab(); rerenderKeepingFocus("crm-contacts-q"); }), 300);
    }
  });
  document.addEventListener("change", (event) => {
    const target = event.target;
    const crm = state.crm;
    if (target.id === "crm-board-select") {
      crm.boardId = target.value;
      crm.pipelineId = null;
      crm.columnLimit = {};
      storage.set("niro-crm-board", crm.boardId);
      run(null, null, () => loadCrm());
    } else if (target.id === "crm-actor") {
      crm.actor = target.value.trim();
      storage.set("niro-crm-actor", crm.actor);
      toast(`Trabajás como ${actor()}: tus movimientos quedan a tu nombre.`);
    } else if (target.dataset.crmFilter) { crm.filter[target.dataset.crmFilter] = target.value; renderView(); }
    else if (target.id === "crm-only-dups") { crm.onlyDuplicates = target.checked; run(null, null, async () => { await loadTab(); renderView(); }); }
    else if (target.dataset.crmReport) {
      crm.reportFilter[target.dataset.crmReport] = target.value;
      run(null, null, async () => { await loadTab(); renderView(); });
    } else if (target.id === "crm-move-select") {
      const card = crm.detail?.opportunity;
      if (card && target.value !== card.stageId) moveCard(card.id, target.value, null, $("#crm-move-reason")?.value || null);
    } else if (target.closest?.("#crm-campaign-form") && target.name === "boardId") {
      crm.campaign.filters.boardId = target.value;
      crm.campaign.filters.stageIds = [];
      renderView();
    }
  });

  /* ---------------------------------------------------------- Tiempo real */
  let reloadTimer = null;
  streamHooks.push((stream) => stream.addEventListener("crm", (message) => {
    let data = {};
    try { data = JSON.parse(message.data); } catch { /* mensaje inválido */ }
    if (data.kind === "task-due" && data.task) {
      const task = data.task;
      toast(`${task.title}${task.contactName ? ` · ${task.contactName}` : ""}`, { title: "Seguimiento pendiente", avatarHtml: `<span class="avatar sm solid-orange">${icon("clock", "sm")}</span>`, timeout: 15_000, action: () => { navigate("#/crm"); openCard(task.opportunityId); } });
      if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
        const notification = new Notification("Niro · Seguimiento pendiente", { body: `${task.title}${task.contactName ? ` — ${task.contactName}` : ""}`, tag: `crm-task-${task.id}` });
        notification.onclick = () => { window.focus(); navigate("#/crm"); openCard(task.opportunityId); };
      }
    }
    if (data.kind === "created" && data.id) {
      toast(`${data.contactName || "Nueva persona"}${data.channel ? ` · ${channelLabel(data.channel)}` : ""}`, { title: "Nuevo interesado en el CRM", avatarHtml: `<span class="avatar sm solid-violet">${icon("users", "sm")}</span>`, action: () => { navigate("#/crm"); openCard(data.id); } });
    }
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      if (!state.crm.data && state.route !== "crm") return;
      await loadCrm({ render: state.route === "crm" && !state.crm.dragging }).catch(() => {});
      if (state.crm.openId && (!data.id || data.id === state.crm.openId || data.kind === "tasks" || data.kind === "contacts")) await reloadDetail();
    }, 500);
  }));

  window.addEventListener("hashchange", () => { if (!location.hash.startsWith("#/crm")) closeDrawer(); });
  ROUTES.crm = { render: renderCrm, right: false };
  return { loadCrm, openCard };
}
