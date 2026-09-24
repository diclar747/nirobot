// Pruebas de "Unirte al grupo" con una página simulada en Chrome (sin Facebook).
// Verifican que se pulse solo el botón del encabezado del grupo y nunca el de
// una recomendación, y que se reconozcan miembro, solicitud y preguntas.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { createGroupsExplorer } from "../groups-explorer.mjs";

const CHROME = [
  process.env.NIRO_BROWSER_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((path) => path && existsSync(path));

// mode: "guest" (no miembro), "member", "requested" o "questions" (pide preguntas al unirse).
function fixture(mode) {
  const header = { guest: "<div role='button' id='join'>Unirte al grupo</div>", questions: "<div role='button' id='join'>Unirte al grupo</div>", member: "<div role='button'>Invitar</div><div role='button'>Miembro</div>", requested: "<div role='button'>Cancelar solicitud</div>" }[mode];
  const card = (name) => `<div class="card"><span>${name}</span><div role="button" class="rec">Unirte al grupo</div><div role="button" aria-label="Eliminar recomendación para ${name}">×</div></div>`;
  return `<html><body><div role="main">
    <section id="top-suggestions"><div role="button">Salir del cuadro de sugerencias</div>${card("Grupo sugerido arriba")}</section>
    <h1>Remates Encarnación</h1>
    <div id="header">${header}</div>
    <section id="related"><h2>Grupos relacionados</h2>${card("Itapúa ofertas")}${card("Ofertas Itapúa Poty")}</section>
  </div>
  <script>
    window.clicks = [];
    document.addEventListener("click", (event) => {
      const button = event.target.closest("[role=button]");
      if (!button) return;
      window.clicks.push(button.id || button.className || button.textContent);
      if (button.id !== "join") return;
      setTimeout(() => {
        if (${JSON.stringify(mode)} === "questions") document.body.insertAdjacentHTML("beforeend", "<div role='dialog' id='questions'>Responde las preguntas del administrador <div role='button'>Enviar</div></div>");
        else document.getElementById("header").innerHTML = "<div role='button'>Invitar</div><div role='button'>Miembro</div>";
      }, 1200);
    });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") document.getElementById("questions")?.remove(); });
  </script></body></html>`;
}

let browser = null;
let page = null;
let mode = "guest";
const store = { groups: [], discoveredGroups: [], groupSegments: [], groupJoinTasks: [], profile: { name: "Prueba" }, meta: {} };
const facebook = {
  isOpen: true,
  cancelRequested: false,
  get homePage() { return page; },
  openUrl: async () => { await page.setContent(fixture(mode)); },
  waitForFacebookReady: async () => {},
  cacheImage: async () => null,
};
const explorer = createGroupsExplorer({
  getStore: () => store,
  persist: async () => {},
  broadcast: () => {},
  facebook,
  now: () => new Date().toISOString(),
  cleanText: (value, max = 4_000) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max),
  withBrowser: (task) => task(),
});
const group = { id: "989345233123353", name: "Remates Encarnación", url: "https://www.facebook.com/groups/989345233123353" };
const clicks = () => page.evaluate(() => window.clicks);

before(async () => {
  if (!CHROME) return;
  browser = await chromium.launch({ headless: true, executablePath: CHROME });
  page = await browser.newPage();
});
after(async () => { await browser?.close(); });

test("no miembro: pulsa solo el «Unirte» del encabezado, aunque haya recomendaciones arriba y abajo", { skip: !CHROME && "sin Chrome ni Edge" }, async () => {
  mode = "guest";
  const result = await explorer.join(group);
  assert.equal(result.status, "member", result.note);
  assert.deepEqual(await clicks(), ["join"]);
});

test("ya miembro: el «Unirte» de los grupos relacionados no cuenta y no se pulsa nada", { skip: !CHROME && "sin Chrome ni Edge" }, async () => {
  mode = "member";
  const result = await explorer.join(group);
  assert.equal(result.status, "member");
  assert.equal(result.note, "Ya eras miembro.");
  assert.deepEqual(await clicks(), []);
});

test("solicitud pendiente: no vuelve a pedir ingreso", { skip: !CHROME && "sin Chrome ni Edge" }, async () => {
  mode = "requested";
  const result = await explorer.join(group);
  assert.equal(result.status, "requested");
  assert.deepEqual(await clicks(), []);
});

test("preguntas de ingreso: no las responde, cierra el diálogo y queda para intervención", { skip: !CHROME && "sin Chrome ni Edge" }, async () => {
  mode = "questions";
  const result = await explorer.join(group);
  assert.equal(result.status, "attention");
  assert.match(result.note, /preguntas|reglas/);
  assert.deepEqual(await clicks(), ["join"]);
  assert.equal(await page.locator("#questions").count(), 0, "el diálogo se cerró sin enviar respuestas");
});

test("la ficha detecta miembro aunque la página muestre «Unirte al grupo» de otros grupos", { skip: !CHROME && "sin Chrome ni Edge" }, async () => {
  mode = "member";
  const target = { ...group, status: "attention" };
  await explorer.readAbout(target);
  assert.equal(target.joinState, "member");
  assert.equal(target.status, "member");
  assert.ok(store.groups.some((item) => item.id === group.id), "queda disponible en Grupos para publicar");
});
