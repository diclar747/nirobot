// Apariencia del panel: "Color del sistema" (tema claro u oscuro con acento) y
// menú lateral. En escritorio el menú se minimiza a íconos; en pantallas chicas
// se abre como panel sobre el contenido.
export const THEMES = [
  { key: "dark-blue", name: "Azul", note: "Oscuro", swatch: "#5b9cff" },
  { key: "dark-violet", name: "Violeta", note: "Oscuro", swatch: "#8a7bff" },
  { key: "dark-green", name: "Verde", note: "Oscuro", swatch: "#3cc983" },
  { key: "dark-orange", name: "Naranja", note: "Oscuro", swatch: "#f59a4b" },
  { key: "dark-graphite", name: "Grafito", note: "Oscuro", swatch: "#8b939e" },
  { key: "light", name: "Claro", note: "Fondo blanco", swatch: "#ffffff" },
];

export function installAppearance(ctx) {
  const { $, $$, hooks, actions, icon, esc, closeDropdown, showDropdown } = ctx;
  const root = document.documentElement;
  // Valores simples (sin JSON): el script del <head> los lee antes de pintar.
  const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* sin almacenamiento */ } };

  /* ---------------------------------------------------------- Color del sistema */
  function current() {
    const saved = read("niro-appearance");
    if (THEMES.some((theme) => theme.key === saved)) return saved;
    if (root.dataset.theme === "light") return "light";
    if (root.dataset.theme === "dark" || matchMedia("(prefers-color-scheme: dark)").matches) return "dark-violet";
    return "light";
  }

  function apply(key) {
    const [theme, accent] = key.split("-");
    root.dataset.theme = theme;
    if (accent) root.dataset.accent = accent;
    else delete root.dataset.accent;
    write("niro-appearance", key);
    write("niro-theme", theme);
    if (theme === "dark") write("niro-last-dark", key);
  }

  hooks.dropdowns.theme = () => {
    const active = current();
    return `<div class="theme-head"><span class="eyebrow">Color del sistema</span></div>
      <div class="theme-list" role="menu" aria-label="Color del sistema">${THEMES.map((theme) => `<button class="theme-option ${theme.key === active ? "active" : ""}" role="menuitemradio" aria-checked="${theme.key === active}" data-action="set-appearance" data-key="${theme.key}">
        <span class="theme-dot" style="background:${theme.swatch}"></span><span class="grow"><strong>${esc(theme.name)}</strong><small>${esc(theme.note)}</small></span>${theme.key === active ? icon("check", "sm") : ""}</button>`).join("")}</div>`;
  };

  actions["set-appearance"] = (el) => { apply(el.dataset.key); closeDropdown(); };
  // "Tema claro / oscuro" del menú de cuenta: alterna con el último oscuro elegido.
  actions["toggle-theme"] = () => { apply(current() === "light" ? read("niro-last-dark") || "dark-violet" : "light"); closeDropdown(); };
  $("#top-theme")?.addEventListener("click", (event) => { event.stopPropagation(); showDropdown("theme", event.currentTarget); });

  /* ---------------------------------------------------------- Menú lateral */
  const small = matchMedia("(max-width: 900px)");
  const toggle = $("#side-toggle");
  const overlay = $("#side-overlay");

  function sync() {
    const open = small.matches ? root.dataset.menu === "open" : root.dataset.sidebar !== "collapsed";
    const label = small.matches ? (open ? "Cerrar menú" : "Abrir menú") : (open ? "Minimizar menú" : "Expandir menú");
    toggle?.setAttribute("aria-expanded", String(open));
    toggle?.setAttribute("aria-label", label);
    if (toggle) toggle.title = label;
    if (overlay) overlay.hidden = !(small.matches && open);
  }

  function setCollapsed(collapsed) {
    if (collapsed) root.dataset.sidebar = "collapsed";
    else delete root.dataset.sidebar;
    write("niro-sidebar", collapsed ? "collapsed" : "open");
    sync();
  }

  function setMenuOpen(open) {
    if (open) root.dataset.menu = "open";
    else delete root.dataset.menu;
    sync();
    if (open) $(".side-nav a.active, .side-nav a")?.focus();
  }

  toggle?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (small.matches) setMenuOpen(root.dataset.menu !== "open");
    else setCollapsed(root.dataset.sidebar !== "collapsed");
  });
  overlay?.addEventListener("click", () => setMenuOpen(false));
  window.addEventListener("hashchange", () => { if (root.dataset.menu === "open") setMenuOpen(false); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && root.dataset.menu === "open") { setMenuOpen(false); toggle?.focus(); } });
  small.addEventListener("change", () => { delete root.dataset.menu; sync(); });

  // Con el menú minimizado cada ícono muestra su nombre al pasar el mouse.
  for (const link of $$(".side-nav a")) {
    const label = [...link.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("").trim();
    if (label) link.title = label;
  }
  sync();
  return { apply, current };
}
