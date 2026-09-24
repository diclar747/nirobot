// Diálogos del panel: reemplazan alert(), confirm() y prompt() del navegador con
// el mismo estilo de Niro. Devuelven promesas:
//   await dialogs.confirm({ title, message, confirmLabel, tone: "danger" }) → true | false
//   await dialogs.prompt({ title, label, value, required, multiline })     → texto | null
//   await dialogs.alert({ title, message })                                 → undefined
// Escape o tocar fuera cancela; Enter confirma; el foco queda dentro del diálogo
// y vuelve al botón que lo abrió. Si se piden dos a la vez, se muestran en orden.
export function createDialogs({ icon }) {
  const esc = (value = "") => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" })[char]);
  const TONES = { primary: "check", danger: "trash", warning: "alert", info: "alert" };
  let root = null;
  let queue = Promise.resolve();

  function layer() {
    if (root) return root;
    root = document.createElement("div");
    root.className = "modal niro-dialog hidden";
    root.setAttribute("role", "presentation");
    document.body.appendChild(root);
    return root;
  }

  function paragraphs(message) {
    return String(message || "").split(/\n{2,}/).map((part) => part.trim()).filter(Boolean).map((part) => `<p>${esc(part).replace(/\n/g, "<br />")}</p>`).join("");
  }

  function show(options) {
    const {
      kind = "confirm", title = "¿Continuar?", message = "", eyebrow = null, tone = "primary", iconName = null,
      confirmLabel = kind === "alert" ? "Entendido" : "Aceptar", cancelLabel = "Cancelar", input = null,
    } = options;
    return new Promise((resolve) => {
      const box = layer();
      const previousFocus = document.activeElement;
      const field = input ? (input.multiline
        ? `<textarea id="dialog-input" rows="3" maxlength="${Number(input.maxLength) || 500}" placeholder="${esc(input.placeholder || "")}">${esc(input.value || "")}</textarea>`
        : `<input id="dialog-input" maxlength="${Number(input.maxLength) || 200}" placeholder="${esc(input.placeholder || "")}" value="${esc(input.value || "")}" autocomplete="off" />`) : "";
      box.innerHTML = `<div class="modal-card dialog-card tone-${esc(tone)}" role="${kind === "confirm" && tone === "danger" ? "alertdialog" : "dialog"}" aria-modal="true" aria-labelledby="dialog-title" ${message ? 'aria-describedby="dialog-message"' : ""}>
          <div class="dialog-main">
            <span class="dialog-icon" aria-hidden="true">${icon(iconName || TONES[tone] || "alert")}</span>
            <div class="dialog-text">
              ${eyebrow ? `<span class="eyebrow">${esc(eyebrow)}</span>` : ""}
              <h3 id="dialog-title">${esc(title)}</h3>
              ${message ? `<div id="dialog-message" class="dialog-message">${paragraphs(message)}</div>` : ""}
              ${input ? `<label class="field dialog-field" for="dialog-input">${esc(input.label || "")}${field}</label>${input.hint ? `<small class="dialog-hint">${esc(input.hint)}</small>` : ""}` : ""}
            </div>
          </div>
          <div class="modal-foot dialog-foot">
            ${kind === "alert" ? "" : `<button type="button" class="btn gray" data-dialog="cancel">${esc(cancelLabel)}</button>`}
            <button type="button" class="btn ${tone === "danger" ? "danger-solid" : "primary"}" data-dialog="confirm">${esc(confirmLabel)}</button>
          </div>
        </div>`;
      box.classList.remove("hidden");
      document.documentElement.classList.add("dialog-open");
      const card = box.querySelector(".dialog-card");
      const confirmButton = box.querySelector("[data-dialog='confirm']");
      const textField = box.querySelector("#dialog-input");
      const syncRequired = () => { if (input?.required) confirmButton.disabled = !textField.value.trim(); };
      syncRequired();

      const finish = (confirmed) => {
        box.removeEventListener("click", onClick);
        box.removeEventListener("keydown", onKeydown);
        textField?.removeEventListener("input", syncRequired);
        box.classList.add("hidden");
        box.innerHTML = "";
        document.documentElement.classList.remove("dialog-open");
        if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
        if (kind === "prompt") resolve(confirmed ? textField.value.trim() : null);
        else resolve(kind === "alert" ? undefined : confirmed);
      };
      const onClick = (event) => {
        if (event.target === box && kind !== "alert") return finish(false);
        const action = event.target.closest("[data-dialog]")?.dataset.dialog;
        if (action === "cancel") finish(false);
        if (action === "confirm" && !confirmButton.disabled) finish(true);
      };
      const onKeydown = (event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(kind === "alert"); return; }
        if (event.key === "Enter" && !event.shiftKey && event.target.tagName !== "TEXTAREA" && event.target.tagName !== "BUTTON") {
          event.preventDefault();
          if (!confirmButton.disabled) finish(true);
          return;
        }
        if (event.key === "Tab") {
          // El foco no sale del diálogo mientras está abierto.
          const focusable = Array.from(card.querySelectorAll("button:not([disabled]), input, textarea"));
          const first = focusable[0];
          const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      };
      box.addEventListener("click", onClick);
      box.addEventListener("keydown", onKeydown);
      textField?.addEventListener("input", syncRequired);
      // En acciones destructivas el foco empieza en "Cancelar": Enter no borra por accidente.
      requestAnimationFrame(() => {
        if (textField) { textField.focus(); textField.select?.(); }
        else (tone === "danger" ? box.querySelector("[data-dialog='cancel']") : confirmButton)?.focus();
      });
    });
  }

  // Un diálogo a la vez: si llega otro mientras hay uno abierto, espera su turno.
  function enqueue(options) {
    const next = queue.then(() => show(options));
    queue = next.catch(() => {});
    return next;
  }

  return {
    confirm: (options) => enqueue({ ...options, kind: "confirm" }),
    prompt: (options) => enqueue({ ...options, kind: "prompt", input: { label: options.label, placeholder: options.placeholder, value: options.value, required: options.required, multiline: options.multiline, maxLength: options.maxLength, hint: options.hint } }),
    alert: (options) => enqueue({ tone: "info", ...options, kind: "alert" }),
  };
}
