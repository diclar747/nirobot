// Explorar grupos: segmentos con palabras clave, catálogo de grupos encontrados,
// agenda de solicitudes de ingreso y seguimiento de membresías.
// Se instala sobre el panel (app.js) y usa sus utilidades: mismo router, mismas
// acciones delegadas por data-action y el mismo canal de tiempo real.
export function installExplorer(ctx) {
  const { $, state, actions, ROUTES, request, run, toast, icon, esc, avatar, timeAgo, when, emptyState, renderView, isTyping, rerenderKeepingFocus, selectOptions, cleanGroupName, streamHooks, dialogs } = ctx;

  const localDate = (date = new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  const STATUS_TONE = { review: "", selected: "violet", scheduled: "blue", requested: "orange", member: "green", rejected: "red", discarded: "", attention: "red" };
  const TASK_META = { scheduled: ["Programada", "blue"], done: ["Hecha", "green"], attention: ["Requiere tu intervención", "red"], failed: ["Falló", "red"], cancelled: ["Cancelada", ""] };
  const RESULT_LABELS = { requested: "Solicitud enviada", member: "Ingreso inmediato", attention: "Requiere tu intervención" };
  const PRIVACY = { public: "Público", private: "Privado" };
  const JOB_LABELS = { search: "Buscando grupos en Facebook", check: "Revisando solicitudes y membresías", about: "Leyendo fichas de grupos" };
  const SORTS = { members: "Más miembros", recent: "Más recientes", name: "Nombre" };

  state.explorer = {
    loaded: false,
    statuses: {},
    segments: [],
    groups: [],
    tasks: [],
    settings: { paused: false },
    job: null,
    tab: "catalogo",
    filter: { q: "", status: "", segment: "", privacy: "", sort: "members" },
    taskFilter: "",
    selected: new Set(),
    editing: null,
    limit: 120,
    plan: { startDate: localDate(), perDay: 5, fromHour: 9, toHour: 18 },
  };

  async function loadExplorer({ render = true } = {}) {
    const data = await request("/api/explorer/state");
    const ex = state.explorer;
    Object.assign(ex, { loaded: true, statuses: data.statuses || {}, segments: data.segments || [], groups: data.groups || [], tasks: data.tasks || [], settings: data.settings || { paused: false }, job: data.job || null });
    const valid = new Set(ex.groups.map((group) => group.id));
    for (const id of ex.selected) if (!valid.has(id)) ex.selected.delete(id);
    if (render && state.route === "explorar" && !isTyping()) renderView();
  }

  /* ---------------------------------------------------------- Utilidades */
  const statusLabel = (status) => state.explorer.statuses[status] || status;
  const statusTag = (status) => `<span class="tag ${STATUS_TONE[status] || ""}">${esc(statusLabel(status))}</span>`;
  const connected = () => Boolean(state.status?.browserOpen);

  // "12 mil" → 12000, "1,2 mil" → 1200, "3.4K" → 3400, "2 millones" → 2000000.
  function membersValue(text) {
    const match = String(text || "").toLowerCase().match(/([\d.,]+)\s*(mil|k|m|millones)?/);
    if (!match) return 0;
    const multiplier = { mil: 1e3, k: 1e3, m: 1e6, millones: 1e6 }[match[2]] || 1;
    const raw = multiplier > 1 ? match[1].replace(",", ".") : match[1].replace(/[.,]/g, "");
    return (Number.parseFloat(raw) || 0) * multiplier;
  }

  function filteredGroups() {
    const { q, status, segment, privacy, sort } = state.explorer.filter;
    const query = q.trim().toLowerCase();
    const list = state.explorer.groups.filter((group) => {
      if (status ? group.status !== status : group.status === "discarded") return false;
      if (segment && !(group.segmentIds || []).includes(segment)) return false;
      if (privacy && group.privacy !== privacy) return false;
      if (query && !`${group.name} ${(group.keywords || []).join(" ")} ${group.description || ""} ${group.summary || ""}`.toLowerCase().includes(query)) return false;
      return true;
    });
    const sorters = {
      members: (a, b) => membersValue(b.members) - membersValue(a.members),
      recent: (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
      name: (a, b) => cleanGroupName(a.name).localeCompare(cleanGroupName(b.name)),
    };
    return list.sort(sorters[sort] || sorters.members);
  }

  // Mismo reparto que el servidor: perDay por día, repartidas entre las horas elegidas.
  function planTimes(count) {
    const plan = state.explorer.plan;
    const perDay = Math.max(1, Math.min(20, Number(plan.perDay) || 5));
    const fromHour = Number(plan.fromHour) || 9;
    const span = Math.max(1, (Number(plan.toHour) || 18) - fromHour);
    const start = plan.startDate ? new Date(`${plan.startDate}T00:00:00`) : new Date();
    return Array.from({ length: count }, (_, index) => {
      const runAt = new Date(start);
      runAt.setDate(start.getDate() + Math.floor(index / perDay));
      runAt.setHours(fromHour, 0, 0, 0);
      runAt.setMinutes(Math.round(((index % perDay) * span * 60) / perDay));
      if (runAt.getTime() < Date.now()) runAt.setTime(Date.now() + (index + 1) * 90_000);
      return runAt;
    });
  }

  function eligibleSelection() {
    return state.explorer.groups.filter((group) => state.explorer.selected.has(group.id) && !["member", "requested"].includes(group.status));
  }

  /* ---------------------------------------------------------- Vista principal */
  function renderExplorer() {
    const ex = state.explorer;
    if (!ex.loaded) {
      $("#view").innerHTML = `<div class="card empty"><span class="empty-icon">${icon("search")}</span><strong>Cargando el explorador de grupos…</strong></div>`;
      loadExplorer().catch((error) => toast(error.message, { error: true }));
      return;
    }
    const counts = {};
    for (const group of ex.groups) counts[group.status] = (counts[group.status] || 0) + 1;
    const scheduledTasks = ex.tasks.filter((task) => task.status === "scheduled").length;
    const tabs = [["segmentos", "search", "Segmentos"], ["catalogo", "users", "Catálogo"], ["agenda", "calendar", "Agenda de solicitudes"], ["membresias", "checks", "Membresías"]];
    const kpis = [
      ["review", "search", "bg-blue", counts.review || 0, "Por revisar"],
      ["selected", "check", "bg-violet", counts.selected || 0, "Seleccionados"],
      ["scheduled", "calendar", "bg-orange", scheduledTasks, "Solicitudes programadas"],
      ["requested", "clock", "bg-orange", counts.requested || 0, "Esperando aprobación"],
      ["member", "users", "bg-green", counts.member || 0, "Miembro"],
      ["attention", "alert", "bg-red", counts.attention || 0, "Requiere tu intervención"],
    ];
    const body = { segmentos: segmentsTab, catalogo: catalogTab, agenda: agendaTab, membresias: membershipsTab }[ex.tab]();
    $("#view").innerHTML = `
      <div class="page-title"><div><span class="eyebrow">Comunidades</span><h1>Explorar grupos</h1><p>Buscá grupos por segmento, revisá su ficha, programá las solicitudes de ingreso y seguí su aprobación. Las preguntas de ingreso y las reglas nunca se responden solas: esos casos quedan como “Requiere tu intervención”.</p></div>
        <div class="actions"><a class="btn ghost" href="#/grupos">${icon("users", "sm")} Mis grupos</a></div></div>
      ${connected() ? "" : `<section class="card card-pad ex-banner">${icon("alert", "sm")}<span class="grow">Facebook no está conectado: podés organizar el catálogo, pero buscar, leer fichas y enviar solicitudes necesita la sesión abierta.</span><button class="btn primary sm" data-action="open-browser">${icon("login", "sm")} Conectar Facebook</button></section>`}
      ${jobBar()}
      <section class="kpis">${kpis.map(([key, iconName, toneClass, value, label]) => `<button class="card kpi ${ex.tab === (key === "scheduled" ? "agenda" : "catalogo") && (key === "scheduled" || ex.filter.status === key) ? "active" : ""}" data-action="ex-kpi" data-status="${key}"><span class="kpi-icon ${toneClass}">${icon(iconName)}</span><div><strong>${value}</strong><span>${esc(label)}</span></div></button>`).join("")}</section>
      <div class="segmented">${tabs.map(([key, iconName, label]) => `<button class="${ex.tab === key ? "active" : ""}" data-action="ex-tab" data-tab="${key}">${icon(iconName, "sm")} ${label}</button>`).join("")}</div>
      ${body}`;
  }

  function jobBar() {
    const job = state.explorer.job;
    if (!job) return "";
    if (job.running) {
      return `<div class="sync-progress running"><div class="sync-progress-head"><span class="pulse"></span><strong>${esc(JOB_LABELS[job.kind] || "Trabajando")}</strong><span class="grow">${esc(job.detail || "")}</span><button class="btn danger sm" data-action="ex-cancel">${icon("pause", "sm")} Detener</button></div></div>`;
    }
    if (!job.finishedAt || Date.now() - Date.parse(job.finishedAt) > 15 * 60_000) return "";
    const result = job.result || {};
    const summary = job.error ? job.error
      : job.kind === "search" ? `${result.added || 0} grupo(s) nuevo(s) entre ${result.seen || 0} resultado(s).`
        : job.kind === "check" ? `${result.checked || 0} revisado(s) · ${result.approved || 0} aprobado(s).`
          : `${result.read || 0} ficha(s) leída(s).`;
    return `<div class="sync-progress"><div class="sync-progress-head"><span class="pulse ${job.error ? "warn" : ""}"></span><strong>${esc(JOB_LABELS[job.kind] || "Trabajo")} · ${job.error ? "con error" : "terminado"}</strong><span class="grow">${esc(summary)}</span><span class="time">${timeAgo(job.finishedAt)}</span></div></div>`;
  }

  /* ---------------------------------------------------------- Segmentos */
  function segmentsTab() {
    const ex = state.explorer;
    const editing = ex.segments.find((segment) => segment.id === ex.editing) || null;
    const groupCount = (id) => ex.groups.filter((group) => (group.segmentIds || []).includes(id)).length;
    return `<section class="card">
        <div class="card-head"><div><h3>${editing ? `Editar “${esc(editing.name)}”` : "Nuevo segmento"}</h3><span class="sub">Un segmento agrupa palabras clave de un mismo público: por ejemplo “Ventas Encarnación” con “ventas encarnación, compra venta itapúa, clasificados encarnación”.</span></div></div>
        <div class="card-body"><form id="ex-segment-form" class="prompt-grid" data-id="${esc(editing?.id || "")}">
          <label class="field">Nombre<input name="name" required maxlength="80" value="${esc(editing?.name || "")}" placeholder="Ej: Ventas Encarnación" /></label>
          <label class="field">Palabras clave (separadas por coma o una por línea)<textarea name="keywords" required placeholder="ventas encarnación, compra venta itapúa">${esc((editing?.keywords || []).join(", "))}</textarea></label>
          <div class="actions" style="grid-column:1/-1"><button type="submit" class="btn primary sm">${icon("check", "sm")} ${editing ? "Guardar cambios" : "Crear segmento"}</button>${editing ? `<button type="button" class="btn ghost sm" data-action="ex-segment-cancel">Cancelar</button>` : ""}</div>
        </form></div>
      </section>
      <section class="card">
        <div class="card-head"><div><h3>Segmentos</h3><span class="sub">Cada búsqueda recorre las palabras clave en Facebook y agrega los grupos nuevos como “Por revisar”.</span></div>${ex.segments.length > 1 ? `<button class="btn soft sm" data-action="ex-search-all" ${ex.job?.running ? "disabled" : ""}>${icon("search", "sm")} Buscar en todos</button>` : ""}</div>
        <div class="card-body"><div class="rows">${ex.segments.length ? ex.segments.map((segment) => `<div class="row">
            <span class="kpi-icon bg-violet">${icon("search")}</span>
            <span class="grow"><span class="title">${esc(segment.name)}</span>
              <span class="ex-keywords">${segment.keywords.map((keyword) => `<span class="tag">${esc(keyword)}</span>`).join("")}</span>
              <span class="sub">${groupCount(segment.id)} grupo(s) · ${segment.lastSearchAt ? `última búsqueda ${timeAgo(segment.lastSearchAt)}` : "sin buscar todavía"}</span></span>
            <span class="actions"><button class="btn primary xs" data-action="ex-search" data-id="${esc(segment.id)}" ${ex.job?.running ? "disabled" : ""}>${icon("search", "xs")} Buscar</button><button class="btn ghost xs" data-action="ex-segment-groups" data-id="${esc(segment.id)}">Ver grupos</button><button class="btn ghost xs" data-action="ex-segment-edit" data-id="${esc(segment.id)}">${icon("edit", "xs")}</button><button class="round-btn danger-btn" data-action="ex-segment-delete" data-id="${esc(segment.id)}" title="Eliminar segmento" aria-label="Eliminar segmento">${icon("trash", "sm")}</button></span>
          </div>`).join("") : emptyState("search", "Sin segmentos", "Creá el primero con sus palabras clave y presioná “Buscar”.")}</div></div>
      </section>`;
  }

  /* ---------------------------------------------------------- Catálogo */
  function catalogTab() {
    const ex = state.explorer;
    const f = ex.filter;
    const list = filteredGroups();
    const counts = {};
    for (const group of ex.groups) counts[group.status] = (counts[group.status] || 0) + 1;
    const pills = [["", "Todos", ex.groups.length - (counts.discarded || 0)], ...["review", "selected", "scheduled", "requested", "member", "attention", "rejected", "discarded"].map((key) => [key, statusLabel(key), counts[key] || 0])];
    const selectedVisible = list.filter((group) => ex.selected.has(group.id)).length;
    const allChecked = list.length > 0 && list.every((group) => ex.selected.has(group.id));
    const selection = ex.selected.size;
    return `<div class="pills">${pills.filter(([key, , count]) => !key || count || f.status === key).map(([key, label, count]) => `<button class="pill ${f.status === key ? "active" : ""}" data-action="ex-filter-status" data-status="${key}">${esc(label)}<span class="n">${count}</span></button>`).join("")}</div>
      <section class="card card-pad filter-bar">
        <input type="search" id="ex-q" placeholder="Buscar por nombre, palabra clave o descripción…" value="${esc(f.q)}" />
        <label class="field">Segmento<select data-ex-filter="segment">${selectOptions(ex.segments.map((segment) => [segment.id, segment.name]), f.segment, "Todos")}</select></label>
        <label class="field">Privacidad<select data-ex-filter="privacy">${selectOptions(Object.entries(PRIVACY), f.privacy, "Todas")}</select></label>
        <label class="field">Orden<select data-ex-filter="sort">${Object.entries(SORTS).map(([key, label]) => `<option value="${key}" ${f.sort === key ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      </section>
      <section class="card">
        <div class="card-body">
          <div class="bulk-bar">
            <label class="check-chip"><input type="checkbox" data-ex-select-all ${allChecked ? "checked" : ""} ${list.length ? "" : "disabled"} /> Seleccionar visibles (${list.length})</label>
            <span class="tag ${selection ? "violet" : ""}">${selection} seleccionado(s)${selection !== selectedVisible ? ` · ${selectedVisible} en esta vista` : ""}</span>
            ${selection ? `<button class="link-btn" data-action="ex-clear-selection">Limpiar</button>` : ""}
            <span style="flex:1"></span>
            <button class="btn primary sm" data-action="ex-go-plan" ${selection ? "" : "disabled"}>${icon("calendar", "sm")} Programar solicitudes</button>
            <button class="btn soft sm" data-action="ex-set-status" data-status="selected" ${selection ? "" : "disabled"}>${icon("check", "sm")} Marcar para unirme</button>
            <button class="btn gray sm" data-action="ex-about" ${selection ? "" : "disabled"} title="Lee descripción, reglas y estado (máx. 50)">${icon("eye", "sm")} Leer ficha</button>
            <details class="ex-more"><summary class="btn ghost sm">Más</summary><div class="ex-more-menu">
              <button class="btn ghost sm" data-action="ex-set-status" data-status="review" ${selection ? "" : "disabled"}>Volver a “Por revisar”</button>
              <button class="btn ghost sm" data-action="ex-set-status" data-status="member" ${selection ? "" : "disabled"}>Ya soy miembro</button>
              <button class="btn ghost sm" data-action="ex-set-status" data-status="discarded" ${selection ? "" : "disabled"}>Descartar</button>
              <button class="btn danger sm" data-action="ex-delete" ${selection ? "" : "disabled"}>${icon("trash", "sm")} Quitar del catálogo</button>
            </div></details>
          </div>
          ${list.length ? `<div class="table-wrap"><table class="data"><thead><tr><th></th><th>Grupo</th><th>Privacidad</th><th>Miembros</th><th>Actividad</th><th>Estado</th><th>Descripción y reglas</th><th></th></tr></thead><tbody>
            ${list.slice(0, ex.limit).map(groupRow).join("")}
          </tbody></table></div>${list.length > ex.limit ? `<div class="pager"><button class="btn gray" data-action="ex-more">Ver más (${list.length - ex.limit} restantes)</button></div>` : ""}`
            : emptyState("users", ex.groups.length ? "Sin resultados con estos filtros" : "El catálogo está vacío", ex.groups.length ? "Cambiá los filtros o la búsqueda." : "Creá un segmento con palabras clave y buscá grupos en Facebook.", ex.groups.length ? "" : `<button class="btn primary" data-action="ex-tab" data-tab="segmentos">${icon("search", "sm")} Crear segmento</button>`)}
        </div>
      </section>`;
  }

  function groupRow(group) {
    const ex = state.explorer;
    const checked = ex.selected.has(group.id);
    const segments = (group.segmentIds || []).map((id) => ex.segments.find((segment) => segment.id === id)?.name).filter(Boolean);
    const description = group.description || group.summary || "";
    return `<tr class="${checked ? "row-selected" : ""}">
      <td><input type="checkbox" data-ex-select="${esc(group.id)}" ${checked ? "checked" : ""} aria-label="Seleccionar ${esc(group.name)}" /></td>
      <td><div class="ex-group">${avatar(cleanGroupName(group.name), { size: "sm", seed: group.id, square: true, image: group.image })}<span><b>${esc(cleanGroupName(group.name))}</b><small class="sub">${esc([segments.join(", "), (group.keywords || []).slice(0, 3).join(" · ")].filter(Boolean).join(" — "))}</small></span></div></td>
      <td>${esc(PRIVACY[group.privacy] || "—")}</td>
      <td class="mono">${esc(group.members || "—")}</td>
      <td>${esc(group.activity || "—")}</td>
      <td>${statusTag(group.status)}${group.lastNote ? `<small class="ex-note">${esc(group.lastNote)}</small>` : ""}</td>
      <td class="text">${description ? `<span class="clamp" title="${esc(description)}">${esc(description)}</span>` : '<span class="sub">Sin ficha: usá “Leer ficha”.</span>'}${group.rules ? `<details class="ex-rules"><summary>Reglas</summary><p>${esc(group.rules)}</p></details>` : ""}</td>
      <td><div class="actions" style="flex-wrap:nowrap"><a class="btn ghost xs" href="${esc(group.url)}" target="_blank" rel="noopener noreferrer" title="Abrir en este navegador">${icon("external", "xs")}</a><button class="btn ghost xs" data-action="ex-about-one" data-id="${esc(group.id)}" title="Leer ficha">${icon("eye", "xs")}</button></div></td>
    </tr>`;
  }

  /* ---------------------------------------------------------- Agenda */
  function agendaTab() {
    const ex = state.explorer;
    const plan = ex.plan;
    const eligible = eligibleSelection();
    const selectedStatus = ex.groups.filter((group) => group.status === "selected");
    const times = planTimes(eligible.length);
    const days = new Set(times.map((time) => time.toDateString())).size;
    const hours = Array.from({ length: 17 }, (_, index) => index + 6);
    const taskCounts = {};
    for (const task of ex.tasks) taskCounts[task.status] = (taskCounts[task.status] || 0) + 1;
    // Primero lo que falta (por hora), después lo terminado (lo más reciente arriba).
    const finishedAt = (task) => String(task.finishedAt || task.lastAttemptAt || task.runAt || "");
    const tasks = [
      ...ex.tasks.filter((task) => task.status === "scheduled").sort((a, b) => String(a.runAt).localeCompare(String(b.runAt))),
      ...ex.tasks.filter((task) => task.status !== "scheduled").sort((a, b) => finishedAt(b).localeCompare(finishedAt(a))),
    ].filter((task) => !ex.taskFilter || task.status === ex.taskFilter);
    return `<section class="card">
        <div class="card-head"><div><h3>Programar solicitudes de ingreso</h3><span class="sub">Niro pulsa “Unirte” a la hora programada con la cuenta conectada${state.status?.profile?.name ? ` (${esc(state.status.profile.name)})` : ""}. Si el grupo pide preguntas o aceptar reglas, no las responde: la tarea queda como “Requiere tu intervención”.</span></div></div>
        <div class="card-body">
          <div class="ex-plan">
            <div class="ex-plan-count"><strong>${eligible.length}</strong><span>grupo(s) listo(s) para programar</span>
              ${selectedStatus.length && selectedStatus.some((group) => !ex.selected.has(group.id)) ? `<button class="btn soft xs" data-action="ex-take-selected">Usar los ${selectedStatus.length} marcados para unirme</button>` : ""}
              ${eligible.length ? "" : `<small>Elegí grupos en el <button class="link-btn" data-action="ex-tab" data-tab="catalogo">Catálogo</button>.</small>`}</div>
            <label class="field">Desde el día<input type="date" data-ex-plan="startDate" value="${esc(plan.startDate)}" min="${localDate()}" /></label>
            <label class="field">Solicitudes por día<input type="number" min="1" max="20" data-ex-plan="perDay" value="${esc(plan.perDay)}" /></label>
            <label class="field">Desde las<select data-ex-plan="fromHour">${hours.map((hour) => `<option value="${hour}" ${Number(plan.fromHour) === hour ? "selected" : ""}>${hour}:00</option>`).join("")}</select></label>
            <label class="field">Hasta las<select data-ex-plan="toHour">${hours.map((hour) => `<option value="${hour}" ${Number(plan.toHour) === hour ? "selected" : ""}>${hour}:00</option>`).join("")}</select></label>
          </div>
          ${eligible.length ? `<p class="ex-plan-summary">${eligible.length} solicitud(es) en ${days} día(s): de ${when(times[0])} a ${when(times.at(-1))}.</p>
            <div class="ex-plan-list">${eligible.slice(0, 8).map((group, index) => `<span>${esc(cleanGroupName(group.name))}<small>${when(times[index])}</small></span>`).join("")}${eligible.length > 8 ? `<span class="sub">y ${eligible.length - 8} más…</span>` : ""}</div>` : ""}
          <p class="ex-hint">${icon("alert", "xs")} Facebook limita las solicitudes: un ritmo de 5 a 10 por día, en horario diurno, evita bloqueos temporales de la cuenta.</p>
          <div class="actions" style="margin-top:12px"><button class="btn primary" data-action="ex-schedule" ${eligible.length ? "" : "disabled"}>${icon("calendar", "sm")} Programar ${eligible.length || ""} solicitud(es)</button></div>
        </div>
      </section>
      <section class="card card-pad"><div class="automation" style="padding:0"><span class="kpi-icon ${ex.settings.paused ? "bg-orange" : "bg-green"}">${icon(ex.settings.paused ? "pause" : "zap")}</span><div class="grow"><strong>${ex.settings.paused ? "Agenda pausada" : "Agenda activa"}</strong><small>${ex.settings.paused ? "Las solicitudes programadas esperan hasta que la reanudes." : `Revisa cada 20 s y envía la próxima solicitud vencida cuando Facebook está conectado y libre.${connected() ? "" : " Ahora Facebook no está conectado."}`}</small></div><button class="switch ${ex.settings.paused ? "" : "on"}" data-action="ex-toggle-pause" aria-pressed="${!ex.settings.paused}" aria-label="Agenda activa"></button></div></section>
      <section class="card">
        <div class="card-head"><h3>Solicitudes</h3><div class="actions"><button class="btn ghost sm" data-action="ex-clear-tasks" ${ex.tasks.some((task) => task.status !== "scheduled") ? "" : "disabled"}>${icon("trash", "sm")} Limpiar finalizadas</button></div></div>
        <div class="card-body">
          <div class="pills" style="margin-bottom:10px">${[["", "Todas", ex.tasks.length], ...Object.entries(TASK_META).map(([key, [label]]) => [key, label, taskCounts[key] || 0])].filter(([key, , count]) => !key || count || ex.taskFilter === key).map(([key, label, count]) => `<button class="pill ${ex.taskFilter === key ? "active" : ""}" data-action="ex-task-filter" data-status="${key}">${esc(label)}<span class="n">${count}</span></button>`).join("")}</div>
          <div class="rows">${tasks.length ? tasks.map(taskRow).join("") : emptyState("calendar", "Sin solicitudes", "Las solicitudes que programes aparecen acá con su resultado.")}</div>
        </div>
      </section>`;
  }

  function taskRow(task) {
    const [label, tone] = TASK_META[task.status] || [task.status, ""];
    const group = state.explorer.groups.find((item) => item.id === task.groupId);
    return `<div class="row">${avatar(cleanGroupName(task.groupName || ""), { size: "sm", seed: task.groupId, square: true, image: group?.image })}
      <span class="grow"><span class="title">${esc(cleanGroupName(task.groupName || task.groupId))}</span>
        <span class="sub">${task.status === "scheduled" ? `Programada para ${when(task.runAt)}` : `${task.result ? `${esc(RESULT_LABELS[task.result] || task.result)} · ` : ""}${when(task.finishedAt || task.lastAttemptAt || task.runAt)}`}${task.attempts ? ` · ${task.attempts} intento(s)` : ""} · ${esc(task.account || "")}</span>
        ${task.note ? `<span class="sub ex-task-note">${esc(task.note)}</span>` : ""}</span>
      <span class="tag ${tone}">${esc(label)}</span>
      ${task.status === "scheduled" ? `<button class="btn ghost xs" data-action="ex-task-cancel" data-id="${esc(task.id)}">${icon("x", "xs")} Cancelar</button>` : ""}
      ${task.status === "attention" && group ? `<button class="btn soft xs" data-action="ex-open-visible" data-id="${esc(group.id)}">${icon("external", "xs")} Completar en Facebook</button>` : ""}
    </div>`;
  }

  /* ---------------------------------------------------------- Membresías */
  function membershipsTab() {
    const ex = state.explorer;
    const by = (status) => ex.groups.filter((group) => group.status === status);
    const lastCheck = ex.groups.map((group) => group.membershipCheckedAt).filter(Boolean).sort().at(-1);
    const inMyGroups = (group) => (state.groups || []).some((item) => item.id === group.id);
    const section = (status, title, text, rowActions) => {
      const items = by(status);
      return `<section class="card"><div class="card-head"><div><h3>${esc(title)} <span class="tag ${STATUS_TONE[status]}">${items.length}</span></h3><span class="sub">${esc(text)}</span></div></div>
        <div class="card-body"><div class="rows">${items.length ? items.map((group) => `<div class="row">${avatar(cleanGroupName(group.name), { size: "sm", seed: group.id, square: true, image: group.image })}
          <span class="grow"><span class="title">${esc(cleanGroupName(group.name))}</span>
            <span class="sub">${esc([group.requestedAt && `Solicitud ${when(group.requestedAt)}`, group.memberSince && `Miembro desde ${when(group.memberSince)}`, group.membershipCheckedAt && `revisado ${timeAgo(group.membershipCheckedAt)}`].filter(Boolean).join(" · ") || "Sin movimientos")}</span>
            ${group.lastNote ? `<span class="sub ex-task-note">${esc(group.lastNote)}</span>` : ""}</span>
          <span class="actions" style="flex-wrap:nowrap">${rowActions(group, inMyGroups(group))}</span></div>`).join("") : '<p class="sub">No hay grupos en este estado.</p>'}</div></div></section>`;
    };
    return `<section class="card card-pad ex-check">
        <span class="kpi-icon bg-orange">${icon("refresh")}</span>
        <div class="grow"><strong>Seguimiento de membresías</strong><small>Revisa en Facebook las solicitudes enviadas y las que requerían intervención: marca las aprobadas (y las suma a Grupos para publicar) y las rechazadas o vencidas.${lastCheck ? ` Última revisión ${timeAgo(lastCheck)}.` : ""}</small></div>
        <button class="btn primary sm" data-action="ex-check" ${ex.job?.running || !(by("requested").length + by("attention").length) ? "disabled" : ""}>${icon("refresh", "sm")} Revisar ahora</button>
      </section>
      ${section("attention", "Requiere tu intervención", "El grupo pide responder preguntas, aceptar reglas o no mostró el botón para unirse. Completalo vos en Facebook: Niro no responde por vos.", (group) => `<button class="btn soft xs" data-action="ex-open-visible" data-id="${esc(group.id)}">${icon("external", "xs")} Completar en Facebook</button><button class="btn ghost xs" data-action="ex-set-one" data-id="${esc(group.id)}" data-status="requested">Ya lo envié</button><button class="btn ghost xs" data-action="ex-set-one" data-id="${esc(group.id)}" data-status="discarded">Descartar</button>`)}
      ${section("requested", "Esperando aprobación", "Solicitudes enviadas que un administrador todavía no aprobó.", (group) => `<a class="btn ghost xs" href="${esc(group.url)}" target="_blank" rel="noopener noreferrer">${icon("external", "xs")}</a><button class="btn ghost xs" data-action="ex-set-one" data-id="${esc(group.id)}" data-status="member">Aprobada</button><button class="btn ghost xs" data-action="ex-set-one" data-id="${esc(group.id)}" data-status="rejected">Rechazada</button>`)}
      ${section("member", "Miembro", "Grupos donde ya participás.", (group, mine) => mine ? `<span class="tag green">En Grupos</span><button class="btn soft xs" data-action="compose-to" data-type="group" data-id="${esc(group.id)}">${icon("edit", "xs")} Publicar</button>` : `<span class="tag">Actualizá Grupos</span>`)}
      ${section("rejected", "Rechazadas o vencidas", "Podés volver a intentarlo más adelante.", (group) => `<button class="btn ghost xs" data-action="ex-set-one" data-id="${esc(group.id)}" data-status="selected">Reintentar</button>`)}`;
  }

  /* ---------------------------------------------------------- Acciones */
  const post = (path, body = {}) => request(path, { method: "POST", body: JSON.stringify(body) });

  async function setStatus(ids, status, button = null) {
    if (!ids.length) return;
    await run(button, null, async () => {
      const result = await post("/api/explorer/groups/status", { groupIds: ids, status });
      toast(`${result.changed} grupo(s) → ${statusLabel(status)}.`);
      await loadExplorer();
    });
  }

  async function startJob(button, path, body, message) {
    await run(button, "Iniciando…", async () => {
      const result = await post(path, body);
      state.explorer.job = result.job;
      toast(message);
      renderView();
    });
  }

  Object.assign(actions, {
    "ex-tab": (el) => { state.explorer.tab = el.dataset.tab; renderView(); },
    "ex-kpi": (el) => {
      const ex = state.explorer;
      if (el.dataset.status === "scheduled") { ex.tab = "agenda"; ex.taskFilter = "scheduled"; }
      else if (["attention", "requested"].includes(el.dataset.status) && ex.tab === "membresias") { /* ya está a la vista */ }
      else { ex.tab = "catalogo"; ex.filter.status = el.dataset.status; }
      renderView();
    },
    "ex-filter-status": (el) => { state.explorer.filter.status = el.dataset.status; state.explorer.limit = 120; renderView(); },
    "ex-task-filter": (el) => { state.explorer.taskFilter = el.dataset.status; renderView(); },
    "ex-more": () => { state.explorer.limit += 120; renderView(); },
    "ex-clear-selection": () => { state.explorer.selected.clear(); renderView(); },
    "ex-segment-edit": (el) => { state.explorer.editing = el.dataset.id; renderView(); $("#ex-segment-form [name='name']")?.focus(); },
    "ex-segment-cancel": () => { state.explorer.editing = null; renderView(); },
    "ex-segment-groups": (el) => { Object.assign(state.explorer.filter, { segment: el.dataset.id, status: "" }); state.explorer.tab = "catalogo"; renderView(); },
    "ex-segment-delete": async (el) => {
      const segment = state.explorer.segments.find((item) => item.id === el.dataset.id);
      if (!segment || !(await dialogs.confirm({ title: `¿Eliminar el segmento “${segment.name}”?`, message: "Los grupos que encontró quedan en el catálogo.", confirmLabel: "Eliminar segmento", tone: "danger" }))) return;
      run(el, null, async () => {
        await request(`/api/explorer/segments/${encodeURIComponent(segment.id)}`, { method: "DELETE" });
        if (state.explorer.filter.segment === segment.id) state.explorer.filter.segment = "";
        toast("Segmento eliminado.");
        await loadExplorer();
      });
    },
    "ex-search": (el) => startJob(el, "/api/explorer/search", { segmentIds: [el.dataset.id] }, "Buscando grupos en Facebook. Podés seguir usando el panel."),
    "ex-search-all": (el) => startJob(el, "/api/explorer/search", { segmentIds: state.explorer.segments.map((segment) => segment.id) }, "Buscando con todos los segmentos. Tarda unos minutos."),
    "ex-check": (el) => startJob(el, "/api/explorer/check", {}, "Revisando las solicitudes en Facebook."),
    "ex-about": (el) => {
      const ids = [...state.explorer.selected].slice(0, 50);
      if (state.explorer.selected.size > 50) toast("Se leen las primeras 50 fichas de la selección.");
      startJob(el, "/api/explorer/about", { groupIds: ids }, `Leyendo ${ids.length} ficha(s).`);
    },
    "ex-about-one": (el) => startJob(el, "/api/explorer/about", { groupIds: [el.dataset.id] }, "Leyendo la ficha del grupo."),
    "ex-cancel": (el) => run(el, "Deteniendo…", async () => { await post("/api/explorer/cancel"); toast("Deteniendo: lo ya encontrado queda guardado."); }),
    "ex-set-status": (el) => setStatus([...state.explorer.selected], el.dataset.status, el),
    "ex-set-one": (el) => setStatus([el.dataset.id], el.dataset.status, el),
    "ex-delete": async (el) => {
      const ids = [...state.explorer.selected];
      if (!ids.length || !(await dialogs.confirm({ title: `¿Quitar ${ids.length} grupo(s) del catálogo?`, message: "Solo se quitan de Niro: no se sale de ningún grupo en Facebook y se cancelan sus solicitudes programadas.", confirmLabel: "Quitar del catálogo", tone: "danger" }))) return;
      run(el, null, async () => {
        const result = await post("/api/explorer/groups/delete", { groupIds: ids });
        state.explorer.selected.clear();
        toast(`${result.removed} grupo(s) quitados del catálogo.`);
        await loadExplorer();
      });
    },
    "ex-go-plan": () => { state.explorer.tab = "agenda"; renderView(); },
    "ex-take-selected": () => { for (const group of state.explorer.groups) if (group.status === "selected") state.explorer.selected.add(group.id); renderView(); },
    "ex-schedule": (el) => {
      const eligible = eligibleSelection();
      if (!eligible.length) return;
      const plan = state.explorer.plan;
      run(el, "Programando…", async () => {
        const result = await post("/api/explorer/schedule", { groupIds: eligible.map((group) => group.id), startDate: plan.startDate, perDay: Number(plan.perDay), fromHour: Number(plan.fromHour), toHour: Number(plan.toHour) });
        state.explorer.selected.clear();
        state.explorer.taskFilter = "scheduled";
        toast(`${result.tasks.length} solicitud(es) programada(s).${state.explorer.settings.paused ? " La agenda está pausada: reanudala para que corran." : ""}`, { title: "Agenda de solicitudes" });
        await loadExplorer();
      });
    },
    "ex-task-cancel": (el) => run(el, null, async () => { await post("/api/explorer/tasks/cancel", { taskIds: [el.dataset.id] }); toast("Solicitud cancelada."); await loadExplorer(); }),
    "ex-clear-tasks": (el) => run(el, null, async () => { const result = await post("/api/explorer/tasks/clear"); toast(`${result.removed} tarea(s) finalizada(s) quitadas.`); await loadExplorer(); }),
    "ex-toggle-pause": (el) => run(el, null, async () => {
      const paused = !state.explorer.settings.paused;
      await post("/api/explorer/settings", { paused });
      toast(paused ? "Agenda pausada." : "Agenda activa: las solicitudes vencidas se envían en los próximos minutos.");
      await loadExplorer();
    }),
    "ex-open-visible": (el) => run(el, "Abriendo…", async () => {
      const result = await post("/api/explorer/open", { groupId: el.dataset.id });
      toast(result.message, { timeout: 12000 });
    }),
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (form.id !== "ex-segment-form") return;
    event.preventDefault();
    const data = new FormData(form);
    const keywords = String(data.get("keywords") || "").split(/[,\n]/).map((keyword) => keyword.trim()).filter(Boolean);
    run(form.querySelector("[type='submit']"), "Guardando…", async () => {
      const result = await post("/api/explorer/segments", { id: form.dataset.id || undefined, name: data.get("name"), keywords });
      state.explorer.editing = null;
      toast(`Segmento “${result.segment.name}” guardado con ${result.segment.keywords.length} palabra(s) clave.`);
      await loadExplorer();
    });
  });

  document.addEventListener("input", (event) => {
    if (event.target.id === "ex-q") { state.explorer.filter.q = event.target.value; state.explorer.limit = 120; rerenderKeepingFocus("ex-q"); }
  });

  document.addEventListener("change", (event) => {
    const target = event.target;
    const ex = state.explorer;
    if (target.dataset.exFilter) { ex.filter[target.dataset.exFilter] = target.value; ex.limit = 120; renderView(); }
    else if (target.dataset.exPlan) { ex.plan[target.dataset.exPlan] = target.value; renderView(); }
    else if (target.dataset.exSelect) { ex.selected[target.checked ? "add" : "delete"](target.dataset.exSelect); renderView(); }
    else if (target.matches("[data-ex-select-all]")) { for (const group of filteredGroups()) ex.selected[target.checked ? "add" : "delete"](group.id); renderView(); }
  });

  // Tiempo real: el servidor avisa progreso de búsquedas y resultados de la agenda.
  let reloadTimer = null;
  streamHooks.push((stream) => stream.addEventListener("groups-explorer", (message) => {
    let data = {};
    try { data = JSON.parse(message.data); } catch { /* mensaje inválido */ }
    const ex = state.explorer;
    if (data.kind === "progress" && ex.job) {
      ex.job.detail = data.detail;
      const detail = document.querySelector(".sync-progress.running .grow");
      if (detail && state.route === "explorar") detail.textContent = data.detail || "";
      return;
    }
    const wasRunning = Boolean(ex.job?.running);
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      if (!ex.loaded && state.route !== "explorar") return;
      await loadExplorer().catch(() => {});
      if (data.kind === "job" && wasRunning && !ex.job?.running) {
        toast(ex.job?.error || { search: "Búsqueda de grupos terminada.", check: "Revisión de membresías terminada.", about: "Fichas leídas." }[ex.job?.kind] || "Listo.", { title: "Explorar grupos", error: Boolean(ex.job?.error) });
      }
      if (data.kind === "task") {
        const task = ex.tasks.find((item) => item.id === data.id);
        if (task) toast(task.note || statusLabel(task.result || task.status), { title: cleanGroupName(task.groupName || "Solicitud de ingreso"), error: ["attention", "failed"].includes(task.status) });
      }
    }, 400);
  }));

  ROUTES.explorar = { render: renderExplorer, right: false };
  return { loadExplorer };
}
