// Ventana remota de Facebook: en el servidor Chrome no tiene pantalla, así que acá se muestra una
// captura de la pestaña que se refresca sola, y los clics/teclas se mandan a /api/browser/input.
// Sirve para iniciar sesión (código de verificación incluido) y para vincular Instagram.
export function createRemoteView({ base, toast, refresh }) {
  let box = null;
  let timer = null;
  let sending = Promise.resolve();

  let inFlight = 0;
  function setBusy(delta) {
    inFlight += delta;
    box?.querySelector(".rv-screen")?.classList.toggle("rv-busy", inFlight > 0);
  }

  async function send(payload) {
    setBusy(1);
    sending = sending.then(async () => {
      const response = await fetch(`${base}/api/browser/input`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) throw new Error(result.error || `HTTP ${response.status}`);
      box?.querySelector("[data-rv-url]")?.replaceChildren(document.createTextNode(result.url || ""));
      reload();
    }).catch((error) => toast(error.message, { error: true })).finally(() => setBusy(-1));
    return sending;
  }

  function reload() {
    const image = box?.querySelector("img");
    if (!image) return;
    const next = new Image();
    next.onload = () => { image.src = next.src; image.classList.remove("rv-loading"); };
    next.src = `${base}/api/browser/screen?t=${Date.now()}`;
  }

  function close() {
    clearInterval(timer);
    timer = null;
    box?.remove();
    box = null;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("paste", onPaste, true);
    refresh({ soft: false }).catch(() => {});
  }

  // Las letras se juntan y se mandan de a tandas: una petición por tecla hacía una cola lenta.
  let pending = "";
  let flushTimer = null;
  function flushText() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!pending) return sending;
    const text = pending;
    pending = "";
    return send({ action: "type", text });
  }

  function onKey(event) {
    if (!box || event.target.closest("[data-rv-text]")) return;
    if (event.key === "Escape" && event.shiftKey) return close();
    // AltGr (@, #, [ en teclado español) llega como Ctrl+Alt: es un carácter, no un atajo.
    const altGr = event.getModifierState?.("AltGraph") || (event.ctrlKey && event.altKey);
    if (!altGr && (event.ctrlKey || event.metaKey)) {
      if (event.key.toLowerCase() === "a") { event.preventDefault(); flushText(); send({ action: "selectAll" }); }
      return; // Ctrl+V lo maneja el evento paste
    }
    if (event.key.length === 1) {
      event.preventDefault();
      pending += event.key;
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flushText, 250);
      return;
    }
    if (["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock"].includes(event.key)) return;
    event.preventDefault();
    flushText();
    send({ action: "key", key: event.key });
  }

  function onPaste(event) {
    if (!box || event.target.closest("[data-rv-text]")) return;
    const text = event.clipboardData?.getData("text") || "";
    if (!text) return;
    event.preventDefault();
    flushText();
    send({ action: "type", text });
  }

  function open({ title = "Facebook en el servidor", hint = "" } = {}) {
    if (box) return;
    box = document.createElement("div");
    box.className = "modal rv-modal";
    box.innerHTML = `<div class="modal-card rv-card" role="dialog" aria-modal="true" aria-label="${title}">
        <div class="rv-head">
          <div><strong>${title}</strong><small>${hint || "Hacé clic sobre la imagen y escribí como en una ventana normal. Las teclas van directo a Facebook."}</small></div>
          <button class="btn gray sm" data-rv="close">Listo</button>
        </div>
        <div class="rv-tools">
          <button class="btn gray sm" data-rv="back">← Atrás</button>
          <button class="btn gray sm" data-rv="home">Inicio de Facebook</button>
          <button class="btn gray sm" data-rv="up">▲</button>
          <button class="btn gray sm" data-rv="down">▼</button>
          <button class="btn gray sm" data-rv="clear" title="Borra el campo donde está el cursor">Borrar campo</button>
          <form data-rv-text class="rv-text"><input placeholder="Pegar texto (usuario, código…)" autocomplete="off" /><button class="btn primary sm">Escribir</button></form>
        </div>
        <div class="rv-screen"><img class="rv-loading" alt="Pantalla de Facebook" draggable="false" /></div>
        <small class="rv-url" data-rv-url></small>
      </div>`;
    document.body.appendChild(box);
    const image = box.querySelector("img");
    image.addEventListener("click", (event) => {
      const rect = image.getBoundingClientRect();
      flushText();
      send({ action: "click", x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height });
    });
    image.addEventListener("wheel", (event) => { event.preventDefault(); send({ action: "scroll", dy: event.deltaY }); }, { passive: false });
    box.addEventListener("click", (event) => {
      const button = event.target.closest("[data-rv]");
      if (!button) return;
      const what = button.dataset.rv;
      if (what === "close") close();
      else if (what === "back") send({ action: "back" });
      else if (what === "home") send({ action: "home" });
      else if (what === "up") send({ action: "scroll", dy: -600 });
      else if (what === "down") send({ action: "scroll", dy: 600 });
      else if (what === "clear") { flushText(); send({ action: "selectAll" }).then(() => send({ action: "key", key: "Backspace" })); }
    });
    box.querySelector("[data-rv-text]").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = event.currentTarget.querySelector("input");
      if (input.value) send({ action: "type", text: input.value });
      input.value = "";
    });
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("paste", onPaste, true);
    reload();
    timer = setInterval(reload, 1000);
  }

  return { open, close };
}
