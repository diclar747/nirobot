// Explorar grupos: segmentos con palabras clave, catálogo de grupos encontrados,
// agenda de solicitudes de ingreso y seguimiento de membresías.
// Meta retiró la API de grupos: todo pasa por la sesión del navegador. Las
// preguntas de ingreso y las aprobaciones de administradores nunca se
// responden solas: la tarea queda "requiere tu intervención".
import { randomUUID } from "node:crypto";

export const GROUP_STATUSES = {
  review: "Por revisar",
  selected: "Seleccionado",
  scheduled: "Solicitud programada",
  requested: "Solicitud enviada",
  member: "Miembro",
  rejected: "Rechazado",
  discarded: "Descartado",
  attention: "Requiere tu intervención",
};

export function createGroupsExplorer(deps) {
  const { getStore, persist, broadcast, facebook, now, cleanText, withBrowser } = deps;
  const db = () => getStore();
  let timer = null;
  let working = false;

  /* ---------------------------------------------------------- Segmentos */
  async function saveSegment(input) {
    const name = cleanText(input.name, 80);
    if (!name) throw new Error("Poné un nombre al segmento.");
    const keywords = [...new Set((Array.isArray(input.keywords) ? input.keywords : String(input.keywords || "").split(","))
      .map((keyword) => cleanText(keyword, 60)).filter(Boolean))].slice(0, 30);
    let segment = db().groupSegments.find((item) => item.id === input.id);
    if (segment) Object.assign(segment, { name, keywords, updatedAt: now() });
    else {
      segment = { id: randomUUID(), name, keywords, createdAt: now(), updatedAt: now() };
      db().groupSegments.push(segment);
    }
    await persist();
    return segment;
  }

  async function deleteSegment(id) {
    const index = db().groupSegments.findIndex((item) => item.id === id);
    if (index === -1) throw new Error("Segmento no encontrado.");
    db().groupSegments.splice(index, 1);
    for (const group of db().discoveredGroups) group.segmentIds = (group.segmentIds || []).filter((segmentId) => segmentId !== id);
    await persist();
  }

  /* ---------------------------------------------------------- Búsqueda en Facebook */
  function stripPhotoLabel(label) {
    return String(label || "").replace(/^(Foto del perfil de|Foto de perfil de|Foto de portada de|Profile picture of|Cover photo of)\s+/i, "").trim();
  }

  function groupKey(url) {
    try {
      const parts = new URL(url).pathname.split("/").filter(Boolean);
      return parts[0] === "groups" && parts[1] && !["search", "feed", "discover", "joins", "create"].includes(parts[1]) ? parts[1] : null;
    } catch { return null; }
  }

  // Lee los resultados de la búsqueda de grupos de Facebook para una palabra clave.
  async function searchKeyword(keyword, rounds = 6) {
    await facebook.openUrl(`https://www.facebook.com/search/groups/?q=${encodeURIComponent(keyword)}`);
    await facebook.waitForFacebookReady(facebook.homePage).catch(() => {});
    await facebook.homePage.waitForTimeout(2_000);
    const found = new Map();
    for (let round = 0; round < rounds; round += 1) {
      if (facebook.cancelRequested) break;
      const rows = await facebook.homePage.evaluate(() => {
        const main = document.querySelector("[role='main']") || document.body;
        return Array.from(main.querySelectorAll("a[href*='/groups/']")).map((anchor) => {
          let card = anchor;
          // Sube hasta la tarjeta del resultado (contiene el botón Unirte/Visitar).
          for (let depth = 0; depth < 8 && card.parentElement; depth += 1) {
            card = card.parentElement;
            if (card.querySelector("[role='button']") && (card.innerText || "").length > 40) break;
          }
          const image = card.querySelector("image, img");
          return {
            url: anchor.href,
            // El título del resultado es texto visible; el enlace de la foto solo
            // trae la etiqueta "Foto del perfil de …", que se usa como respaldo.
            name: (anchor.innerText || "").trim(),
            label: (anchor.getAttribute("aria-label") || "").trim(),
            text: (card.innerText || "").replace(/\s+/g, " ").trim().slice(0, 500),
            image: image ? image.getAttribute("xlink:href") || image.src : null,
          };
        });
      }).catch(() => []);
      for (const row of rows) {
        const key = groupKey(row.url);
        const name = cleanText(row.name || stripPhotoLabel(row.label), 160);
        if (!key || name.length < 2) continue;
        const current = found.get(key);
        if (!current) {
          found.set(key, { key, url: `https://www.facebook.com/groups/${key}`, name, fromText: Boolean(row.name), text: row.text, image: row.image });
          continue;
        }
        if (row.name && !current.fromText) Object.assign(current, { name, fromText: true });
        if (row.text.length > current.text.length) current.text = row.text;
        current.image = current.image || row.image;
      }
      await facebook.homePage.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5)).catch(() => {});
      await facebook.homePage.waitForTimeout(1_500);
    }
    return [...found.values()].map((row) => ({
      ...row,
      privacy: /\bpúblico\b|\bpublic\b/i.test(row.text) ? "public" : /\bprivado\b|\bprivate\b/i.test(row.text) ? "private" : null,
      members: row.text.match(/([\d.,]+\s*(?:mil|k|m|millones)?)\s*(?:miembros|members)/i)?.[1] || null,
      activity: row.text.match(/([\d+.,]+\s*(?:publicaciones?|posts?)\s*(?:al|por|a|per)\s*(?:día|dia|semana|mes|day|week|month))/i)?.[1] || null,
      alreadyMember: /\b(Visitar|Visit|Ver grupo)\b/.test(row.text) && !/\b(Unirte|Unirse|Join)\b/.test(row.text),
    }));
  }

  // Busca con todas las palabras clave del segmento y guarda los resultados como "Por revisar".
  async function searchSegment(segmentId, { onProgress = () => {} } = {}) {
    const segment = db().groupSegments.find((item) => item.id === segmentId);
    if (!segment) throw new Error("Segmento no encontrado.");
    if (!segment.keywords.length) throw new Error("El segmento no tiene palabras clave.");
    let added = 0;
    let seen = 0;
    for (let index = 0; index < segment.keywords.length; index += 1) {
      if (facebook.cancelRequested) break;
      const keyword = segment.keywords[index];
      onProgress(`${index + 1}/${segment.keywords.length} · “${keyword}”`);
      const results = await waitForBrowser(() => searchKeyword(keyword));
      for (const result of results) {
        seen += 1;
        const id = result.key;
        let group = db().discoveredGroups.find((item) => item.id === id);
        const inCatalog = db().groups.some((item) => item.id === id);
        if (!group) {
          group = {
            id,
            url: result.url,
            name: result.name,
            segmentIds: [],
            keywords: [],
            status: inCatalog || result.alreadyMember ? "member" : "review",
            createdAt: now(),
          };
          db().discoveredGroups.push(group);
          added += 1;
        }
        // Las URL del CDN de Facebook vencen: se guarda una copia local de la foto.
        const image = group.image?.startsWith("/api/images/") ? group.image : await facebook.cacheImage(result.image, `dgroup-${id}`).catch(() => null);
        Object.assign(group, {
          name: result.name || group.name,
          privacy: result.privacy || group.privacy || null,
          members: result.members || group.members || null,
          activity: result.activity || group.activity || null,
          summary: result.text,
          image: image || group.image || null,
          updatedAt: now(),
        });
        if (!group.segmentIds.includes(segmentId)) group.segmentIds.push(segmentId);
        if (!group.keywords.includes(keyword)) group.keywords.push(keyword);
      }
      segment.lastSearchAt = now();
      await persist();
    }
    return { added, seen };
  }

  async function waitForBrowser(task) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const result = await withBrowser(task);
      if (result !== null) return result;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    throw new Error("El navegador estuvo ocupado demasiado tiempo.");
  }

  /* ---------------------------------------------------------- Ficha del grupo */
  // Estado de la cuenta en el grupo según las etiquetas de los botones. No se
  // usa el texto libre: "12 mil miembros" no significa que la cuenta sea miembro.
  // Las señales de miembro van primero: al unirse, Facebook muestra "Grupos
  // relacionados" con su propio "Unirte al grupo", que no es de este grupo.
  function joinStateOnPage(page) {
    return page.evaluate(() => {
      const visible = (element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
      const labels = Array.from(document.querySelectorAll("[role='button'], button")).filter(visible).map((element) => (element.innerText || element.getAttribute("aria-label") || "").trim());
      if (labels.some((label) => /^(Miembro|Unido|Joined|Member|Invitar|Invite|\+ Invitar)$/i.test(label))) return "member";
      if (labels.some((label) => /^(Cancelar solicitud|Cancel request)$/i.test(label))) return "requested";
      if (labels.some((label) => /^(Unirte al grupo|Unirse al grupo|Join group|Unirte|Join)$/i.test(label))) return "not_member";
      return null;
    }).catch(() => null);
  }

  // Marca el botón "Unirte" del encabezado del grupo (el más arriba) y descarta
  // los de las tarjetas de recomendaciones, que traen "Eliminar recomendación".
  function markHeaderJoinButton(page) {
    return page.evaluate(() => {
      document.querySelectorAll("[data-niro-join]").forEach((element) => element.removeAttribute("data-niro-join"));
      const isJoin = (element) => /^(Unirte al grupo|Unirse al grupo|Join group|Unirte|Join)$/i.test((element.innerText || element.getAttribute("aria-label") || "").trim());
      // Se sube solo dentro de la tarjeta: en cuanto el contenedor tiene más de un
      // "Unirte" ya es la página (encabezado + recomendaciones) y se deja de subir.
      const isRecommendation = (element) => {
        let node = element.parentElement;
        for (let depth = 0; depth < 8 && node; depth += 1) {
          if (Array.from(node.querySelectorAll("[role='button'], button")).filter(isJoin).length > 1) return false;
          if (node.querySelector("[aria-label^='Eliminar recomendación' i], [aria-label^='Remove recommendation' i], [aria-label^='Ocultar sugerencia' i]")) return true;
          node = node.parentElement;
        }
        return false;
      };
      const candidates = Array.from(document.querySelectorAll("[role='button'], button"))
        .filter(isJoin)
        .filter((element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })
        .filter((element) => !isRecommendation(element))
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      if (!candidates.length) return false;
      candidates[0].setAttribute("data-niro-join", "1");
      return true;
    }).catch(() => false);
  }

  // Un grupo aprobado pasa a la lista de Grupos: queda disponible para publicar.
  function adoptGroup(group) {
    if (!group || db().groups.some((item) => item.id === group.id)) return false;
    db().groups.push({ id: group.id, name: group.name, url: group.url || `https://www.facebook.com/groups/${group.id}`, avatarUrl: group.image || null, syncedAt: now(), source: "explorer" });
    return true;
  }

  async function readAbout(group) {
    await facebook.openUrl(`https://www.facebook.com/groups/${group.id}/about`);
    await facebook.waitForFacebookReady(facebook.homePage).catch(() => {});
    await facebook.homePage.waitForTimeout(2_000);
    const info = await facebook.homePage.evaluate(() => {
      const main = document.querySelector("[role='main']") || document.body;
      const text = (main.innerText || "").replace(/\n{2,}/g, "\n");
      const pick = (pattern) => (text.match(pattern) || [])[1]?.trim() || null;
      return {
        privacyLine: pick(/\n(Público|Privado|Public|Private)\n/i),
        // "Información" a secas también es una pestaña del grupo: solo vale el encabezado completo.
        description: pick(/(?:Información sobre este grupo|Acerca de este grupo|About this group)\n([\s\S]{0,700}?)(?:\n(?:Privado|Público|Private|Public)\n|$)/i)?.replace(/\s*(Ver más|See more)$/i, "") || null,
        rules: pick(/(?:Reglas del grupo|Reglas de los administradores|Group rules|Rules from the group admins)[^\n]*\n([\s\S]{0,1200}?)(?:\n(?:Miembros|Members|Actividad|Activity)\n|$)/i),
        members: pick(/([\d.,]+\s*(?:mil|k|m)?)\s*(?:miembros|members)/i),
      };
    });
    const joinState = await joinStateOnPage(facebook.homePage);
    Object.assign(group, {
      privacy: /priv/i.test(info.privacyLine || "") ? "private" : /públ|publ/i.test(info.privacyLine || "") ? "public" : group.privacy,
      description: info.description ? cleanText(info.description, 700) : group.description || null,
      rules: info.rules ? info.rules.trim().slice(0, 1_200) : group.rules || null,
      members: info.members || group.members,
      joinState,
      aboutAt: now(),
    });
    if (joinState === "member") {
      group.status = "member";
      group.memberSince = group.memberSince || now();
      adoptGroup(group);
    } else if (joinState === "requested" && group.status !== "member") group.status = "requested";
    return group;
  }

  /* ---------------------------------------------------------- Unirse */
  // Pulsa "Unirte al grupo". Si aparecen preguntas de ingreso, no las responde:
  // cierra el diálogo y deja la tarea para que la persona la complete.
  async function join(group) {
    await facebook.openUrl(group.url);
    await facebook.waitForFacebookReady(facebook.homePage).catch(() => {});
    const page = facebook.homePage;
    await page.waitForTimeout(2_000);
    const state = () => joinStateOnPage(page);
    const before = await state();
    if (before === "member") return { status: "member", note: "Ya eras miembro." };
    if (before === "requested") return { status: "requested", note: "La solicitud ya estaba enviada." };
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    if (!(await markHeaderJoinButton(page))) return { status: "attention", note: "No encontré el botón para unirte (el grupo puede estar oculto o requerir invitación)." };
    await page.locator("[data-niro-join='1']").first().click();
    // Facebook tarda unos segundos en cambiar el botón o en abrir las preguntas de ingreso.
    const questions = page.locator("[role='dialog']").filter({ hasText: /preguntas|questions|responde|answer|reglas|normas|rules|acepta|agree|Enviar|Submit/i }).first();
    for (let second = 0; second < 12; second += 1) {
      await page.waitForTimeout(1_000);
      if (await questions.isVisible().catch(() => false)) {
        await page.keyboard.press("Escape").catch(() => {});
        return { status: "attention", note: "El grupo pide responder preguntas o aceptar reglas: completalo vos con “Completar en Facebook”." };
      }
      const after = await state();
      if (after === "member") return { status: "member", note: "Ingreso inmediato." };
      if (after === "requested") return { status: "requested", note: "Solicitud enviada: queda pendiente de aprobación." };
    }
    return { status: "attention", note: "Facebook no confirmó la solicitud; revisá el grupo." };
  }

  /* ---------------------------------------------------------- Agenda */
  // Distribuye las solicitudes en días: perDay por día, desde startDate, entre horas.
  async function scheduleJoins({ groupIds, startDate, perDay = 5, fromHour = 9, toHour = 18 }) {
    const groups = groupIds.map((id) => db().discoveredGroups.find((item) => item.id === id)).filter((group) => group && !["member", "requested"].includes(group.status));
    if (!groups.length) throw new Error("No hay grupos pendientes para programar.");
    const start = startDate ? new Date(`${startDate}T00:00:00`) : new Date();
    const perDayCount = Math.max(1, Math.min(20, Number(perDay) || 5));
    const span = Math.max(1, (Number(toHour) || 18) - (Number(fromHour) || 9));
    const created = [];
    groups.forEach((group, index) => {
      const day = Math.floor(index / perDayCount);
      const slot = index % perDayCount;
      const runAt = new Date(start);
      runAt.setDate(start.getDate() + day);
      runAt.setHours(Number(fromHour) || 9, 0, 0, 0);
      runAt.setMinutes(Math.round((slot * span * 60) / perDayCount));
      // Nunca en el pasado: lo vencido corre en los próximos minutos, escalonado.
      if (runAt.getTime() < Date.now()) runAt.setTime(Date.now() + (index + 1) * 90_000);
      db().groupJoinTasks = db().groupJoinTasks.filter((task) => !(task.groupId === group.id && task.status === "scheduled"));
      const task = { id: randomUUID(), groupId: group.id, groupName: group.name, account: db().profile?.name || "Perfil", runAt: runAt.toISOString(), status: "scheduled", attempts: 0, createdAt: now(), note: null };
      db().groupJoinTasks.push(task);
      group.status = "scheduled";
      created.push(task);
    });
    await persist();
    broadcast("groups-explorer", { kind: "tasks" });
    return created;
  }

  async function runTask(task) {
    const group = db().discoveredGroups.find((item) => item.id === task.groupId);
    if (!group) { Object.assign(task, { status: "cancelled", note: "El grupo ya no está en el catálogo." }); return; }
    task.attempts += 1;
    task.lastAttemptAt = now();
    const result = await withBrowser(() => join(group));
    if (result === null) { task.attempts -= 1; return "busy"; }
    Object.assign(task, { status: result.status === "attention" ? "attention" : "done", result: result.status, note: result.note, finishedAt: now() });
    group.status = result.status;
    if (result.status === "requested") group.requestedAt = now();
    if (result.status === "member") {
      group.memberSince = group.memberSince || now();
      adoptGroup(group);
    }
    group.lastNote = result.note;
  }

  async function tick() {
    if (working || !facebook.isOpen) return;
    const settings = db().meta.groupsExplorer || {};
    if (settings.paused) return;
    const due = db().groupJoinTasks.filter((task) => task.status === "scheduled" && Date.parse(task.runAt) <= Date.now()).sort((a, b) => a.runAt.localeCompare(b.runAt))[0];
    if (!due) return;
    working = true;
    try {
      const outcome = await runTask(due);
      if (outcome !== "busy") {
        await persist();
        broadcast("groups-explorer", { kind: "task", id: due.id, status: due.status });
      }
    } catch (error) {
      Object.assign(due, { status: "failed", note: error.message, finishedAt: now() });
      await persist();
      broadcast("groups-explorer", { kind: "task", id: due.id, status: "failed" });
    } finally {
      working = false;
    }
  }

  // Revisa si las solicitudes enviadas ya fueron aprobadas. También revisa las que
  // requerían intervención: la persona pudo haber completado las preguntas a mano.
  async function checkMemberships({ onProgress = () => {} } = {}) {
    const pending = db().discoveredGroups.filter((group) => ["requested", "attention"].includes(group.status));
    let approved = 0;
    let checked = 0;
    for (let index = 0; index < pending.length; index += 1) {
      if (facebook.cancelRequested) break;
      const previous = pending[index].status;
      onProgress(`${index + 1}/${pending.length} · ${pending[index].name}`);
      const group = await waitForBrowser(() => readAbout(pending[index]));
      checked += 1;
      if (group.status === "member" && previous !== "member") {
        approved += 1;
        group.lastNote = "Solicitud aprobada.";
      } else if (group.joinState === "not_member" && previous === "requested") {
        // El botón "Unirte" volvió a aparecer: la solicitud fue rechazada o venció.
        group.status = "rejected";
        group.lastNote = "La solicitud ya no figura en Facebook: fue rechazada o venció.";
      } else if (group.status === "requested" && previous === "attention") {
        group.lastNote = "Completaste el ingreso: la solicitud quedó pendiente de aprobación.";
      }
      // La tarea que quedó "requiere intervención" se cierra con el resultado verificado.
      if (["member", "requested"].includes(group.status)) {
        for (const task of db().groupJoinTasks) {
          if (task.groupId !== group.id || task.status !== "attention") continue;
          Object.assign(task, { status: "done", result: group.status, finishedAt: now(), note: group.status === "member" ? "Verificado en Facebook: ya sos miembro." : "Verificado en Facebook: la solicitud está pendiente de aprobación." });
        }
      }
      group.membershipCheckedAt = now();
      await persist();
    }
    return { checked, approved };
  }

  function start() {
    // Búsquedas anteriores pudieron guardar la etiqueta de la foto como nombre.
    let renamed = 0;
    for (const group of db().discoveredGroups) {
      const name = stripPhotoLabel(group.name);
      if (name && name !== group.name) { group.name = name; renamed += 1; }
    }
    if (renamed) persist().catch(() => {});
    if (!timer) timer = setInterval(() => tick().catch(() => {}), 20_000);
  }

  return { saveSegment, deleteSegment, searchSegment, searchKeyword, readAbout, join, scheduleJoins, runTask, checkMemberships, adoptGroup, start, tick, waitForBrowser };
}
