// Pruebas del CRM sobre un almacenamiento en memoria (sin PostgreSQL ni Facebook).
// Uso: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCrm, phoneKey } from "../crm.mjs";

function setup() {
  const store = {
    chats: [{ id: "111", name: "Ana López", url: "https://www.facebook.com/messages/t/111", lastMessage: "Hola, quiero más información de Niro Bot", avatarUrl: null }],
    messages: [],
    publications: [],
    profile: { name: "Dickel Claudio" },
    meta: {},
    crmBoards: [], crmStages: [], crmContacts: [], crmIdentities: [], crmOpportunities: [], crmActivities: [],
    crmTasks: [], crmStageHistory: [], campaignSources: [], crmCampaigns: [], campaignRecipients: [],
  };
  const events = [];
  let clock = Date.parse("2026-09-24T12:00:00Z");
  const crm = createCrm({
    getStore: () => store,
    persist: async () => {},
    broadcast: (type, payload) => events.push({ type, ...payload }),
    now: () => new Date(clock).toISOString(),
    cleanText: (value, max = 4_000) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max),
  });
  crm.ensureDefaults();
  return { store, crm, events, tick: (ms) => { clock += ms; } };
}

const messengerEvent = (key, text) => ({ id: `e-${key}`, key: `messenger:111:${key}`, source: "messenger", externalId: `111:${key}`, text, url: "https://www.facebook.com/messages/t/111" });

test("crea el tablero Ventas con sus seis columnas", () => {
  const { store, crm } = setup();
  assert.equal(store.crmBoards.length, 1);
  assert.deepEqual(store.crmStages.map((stage) => stage.kind), ["new", "contacted", "quote", "followup", "won", "lost"]);
  assert.equal(crm.settings().defaultBoardId, store.crmBoards[0].id);
});

test("un mensaje de Messenger crea contacto y tarjeta; si vuelve a escribir, actualiza la misma", async () => {
  const { store, crm } = setup();
  await crm.captureEvent(messengerEvent("a", "Ana López · Hola, quiero más información de Niro Bot"));
  assert.equal(store.crmContacts.length, 1);
  assert.equal(store.crmOpportunities.length, 1);
  const card = store.crmOpportunities[0];
  assert.equal(card.stageId, store.crmStages.find((stage) => stage.kind === "new").id);
  assert.equal(card.source.channel, "messenger");
  assert.equal(card.chatId, "111");
  // El mismo evento no se registra dos veces.
  await crm.captureEvent(messengerEvent("a", "Ana López · Hola, quiero más información de Niro Bot"));
  assert.equal(store.crmActivities.filter((activity) => activity.type === "message_in").length, 1);
  // Un mensaje nuevo de la misma persona actualiza la tarjeta existente.
  store.chats[0].lastMessage = "¿Cuánto cuesta el plan mensual?";
  await crm.captureEvent(messengerEvent("b", "Ana López · ¿Cuánto cuesta el plan mensual?"));
  assert.equal(store.crmOpportunities.length, 1);
  assert.equal(store.crmActivities.filter((activity) => activity.type === "message_in").length, 2);
  assert.equal(card.lastMessage.text, "¿Cuánto cuesta el plan mensual?");
  // La identidad de Messenger guarda el último mensaje entrante (ventana de 24 h).
  assert.ok(store.crmIdentities.find((identity) => identity.id === "messenger:111").lastInboundAt);
});

test("un mensaje propio (Tú: …) no crea tarjetas y queda como enviado si ya existe", async () => {
  const { store, crm } = setup();
  await crm.captureEvent(messengerEvent("own", "Tú: Hola Ana, te paso los precios"));
  assert.equal(store.crmOpportunities.length, 0);
  await crm.captureEvent(messengerEvent("a", "Ana López · Hola"));
  await crm.captureEvent(messengerEvent("own2", "Tú: Te paso los precios"));
  const out = store.crmActivities.filter((activity) => activity.type === "message_out");
  assert.equal(out.length, 1);
  assert.ok(store.crmOpportunities[0].milestones.contacted);
});

test("comentario con «precio» crea un interés por comentario; un «me gusta» solo suma métricas", async () => {
  const { store, crm } = setup();
  store.publications.push({ id: "p1", status: "published", text: "Lanzamos Niro Bot: respondé mensajes de clientes las 24 horas con inteligencia artificial", target: { type: "page", name: "Niro" }, ai: { crm: null } });
  await crm.captureEvent({ id: "n1", key: "facebook_notification:c1", source: "facebook_notification", kind: "comment", externalId: "c1", text: "Juan Pérez comentó tu publicación: “Precio por favor”", url: "https://www.facebook.com/x?comment_id=1" });
  assert.equal(store.crmOpportunities.length, 1);
  assert.equal(store.crmOpportunities[0].source.channel, "comment");
  // Comentario sin interés: no crea tarjeta.
  await crm.captureEvent({ id: "n2", key: "facebook_notification:c2", source: "facebook_notification", kind: "comment", externalId: "c2", text: "María comentó tu publicación: “Qué lindo día”", url: "https://www.facebook.com/x?comment_id=2" });
  assert.equal(store.crmOpportunities.length, 1);
  // Reacción: métrica de la publicación, sin tarjeta.
  await crm.captureEvent({ id: "n3", key: "facebook_notification:r1", source: "facebook_notification", kind: "reaction", externalId: "r1", text: "A Pedro y 4 personas más les gusta tu publicación: “Lanzamos Niro Bot: respondé mensajes de clientes las 24 horas”", url: "https://www.facebook.com/x" });
  assert.equal(store.crmOpportunities.length, 1);
  assert.equal(store.publications[0].metrics.reactions, 5);
});

test("la IA completa el comentario y la publicación de origen enruta al tablero elegido en Autopost", async () => {
  const { store, crm } = setup();
  const sms = await crm.saveBoard({ name: "Ventas SMS" });
  const firstSms = store.crmStages.find((stage) => stage.boardId === sms.id && stage.kind === "new");
  store.publications.push({ id: "p2", status: "published", text: "SMS masivo desde Gs. 150.000", target: { type: "page", name: "Niro" }, ai: { crm: { boardId: sms.id, stageId: firstSms.id, agent: "Carla" } } });
  await crm.onInteraction({
    id: "i1", dedupeKey: "facebook_notification:c9", channel: "comment", status: "pending", category: "price",
    person: { name: "Luis Gómez" }, text: "¿Cuánto sale el plan de 1.000 SMS?", url: "https://www.facebook.com/p2?comment_id=9",
    post: { text: "SMS masivo desde Gs. 150.000", url: "https://www.facebook.com/p2" }, publication: { kind: "niro", id: "p2", campaign: "SMS septiembre" },
    account: { name: "Niro" }, lead: { is_lead: true, phone: "0981 123 456", interest: "Plan 1.000 SMS" },
  });
  const card = store.crmOpportunities[0];
  assert.equal(card.boardId, sms.id);
  assert.equal(card.agent, "Carla");
  assert.equal(card.source.publicationId, "p2");
  assert.equal(card.source.campaign, "SMS septiembre");
  assert.equal(card.product, "Plan 1.000 SMS");
  assert.equal(store.crmContacts[0].phone, "0981 123 456");
  // Una interacción que no es de interés no crea tarjeta.
  await crm.onInteraction({ id: "i2", dedupeKey: "facebook_notification:c10", channel: "comment", status: "ignored", category: "greeting", person: { name: "Otro" }, text: "Gracias!" });
  assert.equal(store.crmOpportunities.length, 1);
});

test("formularios: sin duplicados por lead y reuso por teléfono dentro del mismo canal", async () => {
  const { store, crm } = setup();
  const lead = { provider: "meta", leadId: "L1", name: "Carlos Ruiz", phone: "+595 981 555 000", email: "carlos@example.com", fields: [{ name: "full_name", value: "Carlos Ruiz" }], attribution: { campaign: "Niro Bot septiembre", formId: "F1" } };
  const first = await crm.captureLead(lead);
  assert.equal(first.created, true);
  const again = await crm.captureLead(lead);
  assert.equal(again.duplicate, true);
  await crm.captureLead({ ...lead, leadId: "L2", phone: "0981 555 000" });
  assert.equal(store.crmContacts.length, 1, "mismo teléfono en otro formulario de Meta = misma persona");
  assert.equal(store.crmOpportunities.length, 1, "si vuelve a completar, se actualiza la tarjeta abierta");
  assert.equal(store.crmOpportunities[0].source.campaign, "Niro Bot septiembre");
  assert.equal(phoneKey("+595 981 555 000"), phoneKey("0981 555 000"));
});

test("mismo nombre en Messenger y en un comentario: sugerencia de unión supervisada", async () => {
  const { store, crm } = setup();
  await crm.captureEvent({ id: "n1", key: "facebook_notification:c1", source: "facebook_notification", kind: "comment", externalId: "c1", text: "Ana López comentó tu publicación: “info por favor”", url: "https://www.facebook.com/x?comment_id=1" });
  await crm.captureEvent(messengerEvent("a", "Ana López · Hola"));
  assert.equal(store.crmContacts.length, 2);
  assert.equal(store.crmContacts[1].duplicates.length, 1);
  const [target, source] = store.crmContacts;
  await crm.mergeContacts(target.id, source.id, "Carla");
  assert.equal(store.crmContacts.length, 1);
  assert.equal(store.crmIdentities.filter((identity) => identity.contactId === target.id).length, 2);
  assert.ok(store.crmActivities.some((activity) => /unido/i.test(activity.text)));
});

test("mover una tarjeta guarda quién, cuándo y por qué; hitos para reportes", async () => {
  const { store, crm } = setup();
  const card = await crm.createManual({ name: "Empresa Alfa", phone: "0971 222 333", title: "Niro Bot para Alfa", value: 2500000, product: "Niro Bot" }, "Carla");
  const quote = store.crmStages.find((stage) => stage.kind === "quote");
  const { history } = await crm.moveOpportunity(card.id, { stageId: quote.id, reason: "Envió la propuesta", actor: "Carla" });
  assert.equal(history.actor, "Carla");
  assert.equal(history.reason, "Envió la propuesta");
  assert.equal(history.toName, "Cotización enviada");
  assert.ok(card.milestones.quote);
  const won = store.crmStages.find((stage) => stage.kind === "won");
  await crm.moveOpportunity(card.id, { stageId: won.id, actor: "Carla" });
  assert.equal(card.status, "won");
  const report = crm.reports({ boardId: card.boardId });
  assert.equal(report.totals.interested, 1);
  assert.equal(report.totals.quotes, 1);
  assert.equal(report.totals.won, 1);
  assert.equal(report.totals.wonValue, 2500000);
});

test("tareas de seguimiento: avisan una sola vez al vencer y registran el resultado", async () => {
  const { store, crm, events, tick } = setup();
  const card = await crm.createManual({ name: "Beto", title: "Beto" }, "Carla");
  const task = await crm.saveTask({ opportunityId: card.id, title: "Volver a contactar", dueAt: new Date(Date.parse("2026-09-24T12:00:00Z") + 60_000).toISOString() }, "Carla");
  await crm.tickTasks();
  assert.equal(events.filter((event) => event.kind === "task-due").length, 0, "todavía no venció");
  tick(120_000);
  await crm.tickTasks();
  await crm.tickTasks();
  assert.equal(events.filter((event) => event.kind === "task-due").length, 1);
  await crm.saveTask({ id: task.id, status: "done", result: "Pidió cotización formal" }, "Carla");
  assert.equal(store.crmTasks[0].status, "done");
  assert.ok(store.crmActivities.some((activity) => /Pidió cotización formal/.test(activity.text)));
});

test("campañas: solo cuenta los contactos con canal disponible y explica el resto", async () => {
  const { store, crm } = setup();
  await crm.createManual({ name: "Con teléfono", phone: "0981 111 222" }, "Carla");
  await crm.createManual({ name: "Sin teléfono", email: "sin@telefono.com" }, "Carla");
  const withConsent = await crm.createManual({ name: "Autorizado", phone: "0982 333 444" }, "Carla");
  await crm.updateContact(withConsent.contactId, { consent: { whatsapp: "granted" } }, "Carla");
  const strict = crm.previewCampaign({ channel: "whatsapp", requireConsent: true });
  assert.equal(strict.total, 3);
  assert.equal(strict.available, 1);
  assert.equal(strict.excluded["Sin teléfono"], 1);
  assert.equal(strict.excluded["Sin autorización registrada para este canal"], 1);
  // Messenger: fuera de la ventana de 24 h no está disponible.
  await crm.captureEvent(messengerEvent("a", "Ana López · Hola"));
  store.crmIdentities.find((identity) => identity.channel === "messenger").lastInboundAt = "2026-09-22T11:00:00.000Z";
  const messenger = crm.previewCampaign({ channel: "messenger" });
  assert.equal(messenger.available, 0);
  assert.equal(messenger.excluded["Fuera de la ventana de 24 h de Messenger"], 1);
  const campaign = await crm.saveCampaign({ name: "Seguimiento WhatsApp", filters: { channel: "whatsapp", requireConsent: true } }, "Carla");
  assert.equal(campaign.available, 1);
  assert.equal(store.campaignRecipients.filter((row) => row.campaignId === campaign.id).length, 4);
});

test("no se puede eliminar un tablero con tarjetas ni una columna sin destino para sus tarjetas", async () => {
  const { store, crm } = setup();
  const card = await crm.createManual({ name: "X" }, "Carla");
  await assert.rejects(() => crm.deleteBoard(card.boardId), /al menos un tablero|tiene tarjetas/);
  await assert.rejects(() => crm.deleteStage(card.stageId, null), /Elegí a qué columna/);
  const contacted = store.crmStages.find((stage) => stage.kind === "contacted");
  await crm.deleteStage(card.stageId, contacted.id, "Carla");
  assert.equal(card.stageId, contacted.id);
});

test("borrar un contacto elimina sus tarjetas, actividades, tareas e historial", async () => {
  const { store, crm } = setup();
  const card = await crm.createManual({ name: "Para borrar", phone: "0981 999 888", note: "Nota" }, "Carla");
  await crm.saveTask({ opportunityId: card.id, title: "Llamar", dueAt: "2026-09-25T13:00:00.000Z" }, "Carla");
  await crm.moveOpportunity(card.id, { stageId: store.crmStages.find((stage) => stage.kind === "contacted").id, actor: "Carla" });
  const other = await crm.createManual({ name: "Queda" }, "Carla");
  const result = await crm.deleteContact(card.contactId);
  assert.equal(result.removedCards, 1);
  assert.deepEqual(store.crmOpportunities.map((item) => item.id), [other.id]);
  assert.equal(store.crmIdentities.some((identity) => identity.contactId === card.contactId), false);
  assert.equal(store.crmActivities.some((activity) => activity.opportunityId === card.id), false);
  assert.equal(store.crmTasks.length, 0);
  assert.equal(store.crmStageHistory.some((entry) => entry.opportunityId === card.id), false);
});

test("«Activo ahora» (estado de Messenger) nunca queda como nombre y se repara al arrancar", async () => {
  const { store, crm } = setup();
  store.chats[0].name = "Activo ahora";
  await crm.captureEvent(messengerEvent("a", "Activo ahora · hola"));
  assert.equal(store.crmContacts[0].name, "Sin nombre");
  // Con el nombre real en la lista de chats, el siguiente mensaje lo corrige (y el título de la tarjeta).
  store.chats[0].name = "Hector Wanderer";
  await crm.captureEvent(messengerEvent("b", "Hector Wanderer · ¿precio?"));
  assert.equal(store.crmContacts[0].name, "Hector Wanderer");
  assert.equal(store.crmOpportunities[0].title, "Hector Wanderer");
  // Un nombre editado a mano no se pisa.
  await crm.updateContact(store.crmContacts[0].id, { name: "Héctor (cliente mayorista)" }, "Carla");
  await crm.captureEvent(messengerEvent("c", "Hector Wanderer · gracias"));
  assert.equal(store.crmContacts[0].name, "Héctor (cliente mayorista)");
});

test("al arrancar repara contactos guardados con «Activo ahora» y quita la sugerencia de unión falsa", async () => {
  const { store, crm } = setup();
  store.chats.push({ id: "222", name: "Adán Morínigo", url: "https://www.facebook.com/messages/t/222" });
  for (const [id, chatId] of [["c1", "111"], ["c2", "222"]]) {
    store.crmContacts.push({ id, name: "Activo ahora", tags: [], consent: {}, duplicates: [{ contactId: id === "c1" ? "c2" : "c1", reason: "Mismo nombre en otro canal" }] });
    store.crmIdentities.push({ id: `messenger:${chatId}`, contactId: id, channel: "messenger", externalId: chatId, displayName: "Activo ahora" });
    store.crmOpportunities.push({ id: `o-${id}`, contactId: id, boardId: store.crmBoards[0].id, stageId: store.crmStages[0].id, title: "Activo ahora", status: "open" });
  }
  crm.start();
  assert.deepEqual(store.crmContacts.map((item) => item.name), ["Ana López", "Adán Morínigo"]);
  assert.deepEqual(store.crmOpportunities.map((item) => item.title), ["Ana López", "Adán Morínigo"]);
  assert.equal(store.crmContacts.every((item) => item.duplicates.length === 0), true);
});

test("al actualizarse la lista de chats el CRM toma el nombre corregido, sin pisar los editados a mano", async () => {
  const { store, crm } = setup();
  store.chats[0].name = "Activo ahora";
  await crm.captureEvent(messengerEvent("a", "Activo ahora · hola"));
  assert.equal(store.crmContacts[0].name, "Sin nombre");
  assert.equal(crm.syncChatNames([{ id: "111", name: "Activo ahora" }]), 0);
  assert.equal(crm.syncChatNames([{ id: "111", name: "Adán Alberto Morínigo" }]), 1);
  assert.equal(store.crmContacts[0].name, "Adán Alberto Morínigo");
  assert.equal(store.crmOpportunities[0].title, "Adán Alberto Morínigo");
  await crm.updateContact(store.crmContacts[0].id, { name: "Adán (proveedor)" }, "Carla");
  assert.equal(crm.syncChatNames([{ id: "111", name: "Adán Morínigo" }]), 0);
  assert.equal(store.crmContacts[0].name, "Adán (proveedor)");
});
