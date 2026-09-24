// Instagram dentro de Autopost.
// Ruta elegida: Meta Business Suite con la sesión de Facebook ya conectada.
// Cada cuenta profesional de Instagram vinculada a una página aparece en el
// selector "Publicar en" del editor de esa página; no se usan cookies de
// Instagram ni contraseñas. El estado se guarda por cuenta en social_accounts.
export function createInstagram(deps) {
  const { getStore, persist, broadcast, facebook, now, cleanText, withBrowser, mediaById } = deps;
  const db = () => getStore();

  function accounts() {
    return db().socialAccounts.filter((account) => account.platform === "instagram");
  }

  // Lee las opciones del selector "Publicar en" del editor de Business Suite.
  async function readDestinations(pageId) {
    await facebook.openUrl(`https://business.facebook.com/latest/composer/?asset_id=${pageId}`);
    const page = facebook.homePage;
    const combo = page.locator("[role='combobox']").first();
    await combo.waitFor({ state: "visible", timeout: 40_000 });
    for (const name of [/^OK$/, /^Entendido$/, /^Got it$/]) {
      const button = page.getByRole("button", { name }).first();
      if (await button.isVisible().catch(() => false)) await button.click().catch(() => {});
    }
    await combo.click();
    await page.waitForSelector("[role='option']", { timeout: 10_000 }).catch(() => {});
    // Las opciones de Instagram cargan después que la de la página.
    for (let wait = 0; wait < 10; wait += 1) {
      const count = await page.locator("[role='option']").count();
      if (count >= 2) break;
      await page.waitForTimeout(600);
    }
    await page.waitForTimeout(800);
    const options = await page.evaluate(() => Array.from(document.querySelectorAll("[role='option']")).map((option) => ({
      text: (option.innerText || "").replace(/\s+/g, " ").trim(),
      checked: option.getAttribute("aria-checked") === "true" || option.getAttribute("aria-selected") === "true" || Boolean(option.querySelector("input:checked")),
      image: (() => { const image = option.querySelector("img, svg image"); return image ? image.getAttribute("xlink:href") || image.src : null; })(),
    }))).catch(() => []);
    await page.keyboard.press("Escape").catch(() => {});
    return options;
  }

  // Revisa todas las páginas administradas y registra su Instagram vinculado.
  async function discover({ pageIds = null, onProgress = () => {} } = {}) {
    const pages = db().pages.filter((page) => /^\d+$/.test(String(page.id)) && (!pageIds || pageIds.includes(page.id)));
    const results = [];
    for (let index = 0; index < pages.length; index += 1) {
      if (facebook.cancelRequested) break;
      const page = pages[index];
      onProgress(`${index + 1}/${pages.length} · ${page.name}`);
      const result = await withBrowser(async () => {
        const options = await readDestinations(page.id);
        // Cuenta de Instagram = opción con forma de usuario de Instagram (sin espacios:
        // letras, números, punto y guion bajo). El selector también lista la página
        // y grupos de Facebook ("Grupo público · N miembros"), que no cuentan.
        const instagram = options
          .map((option) => ({ ...option, text: option.text.replace(/^(Perfil de Instagram|Instagram profile)\s*/i, "") }))
          .find((option) => option.text !== page.name && /^[A-Za-z0-9._]{1,30}$/.test(option.text));
        const needsConnect = options.some((option) => /conectar instagram|connect instagram/i.test(option.text));
        return { options, instagram, needsConnect };
      });
      if (result === null) { index -= 1; await new Promise((resolve) => setTimeout(resolve, 3_000)); continue; }
      const id = `instagram:${page.id}`;
      let account = db().socialAccounts.find((item) => item.id === id);
      if (!account) {
        account = { id, platform: "instagram", pageId: page.id, pageName: page.name, createdAt: now() };
        db().socialAccounts.push(account);
      }
      Object.assign(account, {
        username: result.instagram ? cleanText(result.instagram.text.replace(/^Perfil de Instagram\s*/i, ""), 120) : null,
        avatarUrl: result.instagram?.image || account.avatarUrl || null,
        status: result.instagram ? "connected" : result.needsConnect ? "disconnected" : "attention",
        statusDetail: result.instagram ? "Vinculada a la página en Business Suite" : result.needsConnect ? "La página no tiene una cuenta de Instagram vinculada" : "No se pudo leer el selector de destinos",
        checkedAt: now(),
        optionsSeen: result.options.map((option) => option.text).slice(0, 12),
      });
      results.push(account);
      await persist();
    }
    broadcast("instagram", { kind: "accounts" });
    return results;
  }

  /* ---------------------------------------------------------- Publicador */
  // Formatos: post (imagen/video/carrusel), reel e historia. Instagram exige
  // imagen o video: nunca se publica solo texto.
  const FORMAT_URL = {
    post: (pageId) => `https://business.facebook.com/latest/composer/?asset_id=${pageId}`,
    reel: (pageId) => `https://business.facebook.com/latest/reels_composer/?asset_id=${pageId}`,
    story: (pageId) => `https://business.facebook.com/latest/story_composer/?asset_id=${pageId}`,
  };

  function validate(job, attachments) {
    const format = job.format || "post";
    if (!FORMAT_URL[format]) throw new Error("Formato de Instagram no reconocido.");
    if (!attachments.length) throw new Error("Instagram necesita al menos una imagen o video.");
    const videos = attachments.filter((item) => item.mimeType?.startsWith("video/"));
    const images = attachments.filter((item) => item.mimeType?.startsWith("image/"));
    if (videos.length + images.length !== attachments.length) throw new Error("Instagram solo acepta imágenes y videos.");
    if (format === "reel" && (videos.length !== 1 || images.length)) throw new Error("Un Reel necesita exactamente un video.");
    if (format === "story" && attachments.length !== 1) throw new Error("Una historia de Instagram lleva una sola imagen o video.");
    if (format === "post" && attachments.length > 10) throw new Error("Un carrusel admite hasta 10 archivos.");
    if ((job.caption || "").length > 2_200) throw new Error("La descripción de Instagram admite hasta 2.200 caracteres.");
  }

  // Marca solo la cuenta de Instagram en "Publicar en" (la página de Facebook
  // se publica con su propio trabajo, así cada destino tiene su estado).
  async function selectOnlyInstagram(page, account) {
    const combo = page.locator("[role='combobox']").first();
    await combo.waitFor({ state: "visible", timeout: 40_000 });
    for (const name of [/^OK$/, /^Entendido$/, /^Got it$/]) {
      const button = page.getByRole("button", { name }).first();
      if (await button.isVisible().catch(() => false)) await button.click().catch(() => {});
    }
    await combo.click();
    await page.waitForSelector("[role='option']", { timeout: 10_000 });
    for (let wait = 0; wait < 10 && (await page.locator("[role='option']").count()) < 2; wait += 1) await page.waitForTimeout(600);
    const options = page.locator("[role='option']");
    const count = await options.count();
    let found = false;
    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);
      const text = ((await option.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      const selected = await option.evaluate((element) => element.getAttribute("aria-checked") === "true" || element.getAttribute("aria-selected") === "true" || Boolean(element.querySelector("input:checked"))).catch(() => false);
      const isInstagram = text === account.username;
      if (isInstagram) found = true;
      if (isInstagram !== selected) {
        await option.click();
        await page.waitForTimeout(500);
      }
    }
    await page.keyboard.press("Escape").catch(() => {});
    if (!found) throw Object.assign(new Error(`La cuenta @${account.username} ya no aparece en Business Suite. Reconectá Instagram.`), { reconnect: true });
    const summary = ((await combo.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (!summary.includes(account.username)) throw new Error(`No pude dejar seleccionada solo la cuenta @${account.username} (quedó: ${summary}).`);
  }

  async function attach(page, attachments) {
    const input = page.locator("input[type='file']");
    if (await input.count()) {
      await input.first().setInputFiles(attachments.map((item) => item.path));
    } else {
      const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
      await page.getByRole("button", { name: /Agregar foto\/video|Add photo\/video|Agregar video|Add video|Subir|Upload/i }).first().click();
      await (await chooser).setFiles(attachments.map((item) => item.path));
    }
    // Espera el procesamiento: no se da por listo solo porque empezó la carga.
    for (let wait = 0; wait < 120; wait += 1) {
      const busy = await page.evaluate(() => /Subiendo|Uploading|Procesando|Processing/i.test(document.body.innerText)).catch(() => false);
      if (!busy && wait > 2) break;
      await page.waitForTimeout(1_000);
    }
  }

  async function prepare(job) {
    const account = accounts().find((item) => item.id === job.accountId);
    if (!account) throw new Error("La cuenta de Instagram no existe en Niro. Revisá las cuentas conectadas.");
    if (account.status !== "connected") throw Object.assign(new Error(`@${account.username || account.pageName} requiere reconexión.`), { reconnect: true });
    const attachments = (job.media || []).map((id) => mediaById(typeof id === "string" ? id : id?.id)).filter(Boolean);
    validate(job, attachments);
    const format = job.format || "post";
    await facebook.openUrl(FORMAT_URL[format](account.pageId));
    const page = facebook.homePage;
    await selectOnlyInstagram(page, account);
    await attach(page, attachments);
    if (job.caption && format !== "story") {
      // El campo de descripción aparece después de procesar el archivo; puede haber
      // otros campos editables ocultos, así que se elige el visible con etiqueta de texto.
      let editor = null;
      for (let wait = 0; wait < 40 && !editor; wait += 1) {
        for (const candidate of await page.locator("[contenteditable=true]").all()) {
          if (!(await candidate.isVisible().catch(() => false))) continue;
          const label = (await candidate.getAttribute("aria-label")) || "";
          if (/coment|comment|buscar|search/i.test(label)) continue;
          editor = candidate;
          if (/texto|text|descrip|caption|publicaci/i.test(label)) break;
        }
        if (!editor) await page.waitForTimeout(750);
      }
      if (!editor) throw new Error("Business Suite no mostró el campo de descripción.");
      await editor.click();
      await editor.fill(job.caption);
      const written = ((await editor.innerText().catch(() => "")) || "").trim();
      if (!written.includes(job.caption.split(/\r?\n/)[0].slice(0, 20))) throw new Error("No se pudo escribir la descripción en Business Suite.");
    }
    await page.waitForTimeout(1_000);
    return { account, format, url: page.url() };
  }

  async function publishPrepared(account, format = "post", caption = "") {
    const page = facebook.homePage;
    // Solo el botón del pie del editor, con texto visible. Los íconos de la vista
    // previa ("Compartir" de Instagram) tienen solo aria-label y no cuentan.
    const label = format === "story" ? /^(Compartir|Share)$/i : /^(Publicar|Publish|Compartir|Share)$/i;
    let button = null;
    for (let wait = 0; wait < 30 && !button; wait += 1) {
      for (const candidate of await page.getByRole("button").all()) {
        const text = ((await candidate.innerText().catch(() => "")) || "").trim();
        if (label.test(text) && await candidate.isVisible().catch(() => false)) button = candidate;
      }
      if (!button) await page.waitForTimeout(700);
    }
    if (!button) throw new Error("Business Suite no mostró el botón para publicar.");
    if (await button.isDisabled().catch(() => false)) throw new Error("Business Suite no habilitó el botón para publicar (revisá el archivo).");
    await button.click();
    // Confirmación: primero un aviso de éxito/error o salida del editor; si no
    // aparece, se busca la publicación en la lista de publicadas de Business Suite.
    for (let wait = 0; wait < 20; wait += 1) {
      const state = await page.evaluate(() => {
        const text = document.body.innerText;
        if (/se (publicó|compartió)|publicaste|was (published|shared)|tu publicación (se )?(publicó|está)/i.test(text)) return "ok";
        if (/no se pudo|couldn't|error al publicar|something went wrong/i.test(text)) return "error";
        return null;
      }).catch(() => null);
      if (state === "ok" || !/composer/.test(page.url())) return { published: true, account: account.username, url: page.url() };
      if (state === "error") throw new Error("Business Suite informó un error al publicar en Instagram.");
      await page.waitForTimeout(1_000);
    }
    if (caption && format !== "story") {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (await verifyPublished(account, caption)) return { published: true, account: account.username, url: page.url(), verified: "lista de publicadas" };
        await page.waitForTimeout(10_000);
      }
    }
    throw new Error("Instagram sigue procesando: revisá la publicación antes de reintentar para no duplicarla.");
  }

  // Abre la lista de publicadas en otra pestaña y busca el comienzo de la descripción.
  async function verifyPublished(account, caption) {
    const snippet = caption.split(/\r?\n/)[0].trim().slice(0, 30);
    if (!snippet) return false;
    const tab = await facebook.context.newPage();
    try {
      await tab.goto(`https://business.facebook.com/latest/posts/published_posts?asset_id=${account.pageId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await tab.waitForSelector("[role='row']", { timeout: 30_000 }).catch(() => {});
      await tab.waitForTimeout(1_500);
      return await tab.evaluate(({ snippet, username }) => Array.from(document.querySelectorAll("[role='row']"))
        .some((row) => (row.innerText || "").includes(snippet) && (row.innerText || "").includes(username)), { snippet, username: account.username });
    } catch {
      return false;
    } finally {
      await tab.close().catch(() => {});
    }
  }

  // Deja marcada en "Publicar en" solo la opción que cumple el criterio.
  async function selectOnly(page, keep) {
    const combo = page.locator("[role='combobox']").first();
    if (!(await combo.isVisible().catch(() => false))) return false;
    await combo.click();
    await page.waitForSelector("[role='option']", { timeout: 10_000 }).catch(() => {});
    for (let wait = 0; wait < 10 && (await page.locator("[role='option']").count()) < 2; wait += 1) await page.waitForTimeout(600);
    const options = page.locator("[role='option']");
    const count = await options.count();
    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);
      const text = ((await option.innerText().catch(() => "")) || "").replace(/[\s\u200b]+/g, " ").trim();
      if (/conectar instagram|connect instagram/i.test(text)) continue;
      const selected = await option.evaluate((element) => element.getAttribute("aria-checked") === "true" || element.getAttribute("aria-selected") === "true" || Boolean(element.querySelector("input:checked"))).catch(() => false);
      if (keep(text) !== selected) {
        await option.click();
        await page.waitForTimeout(500);
      }
    }
    await page.keyboard.press("Escape").catch(() => {});
    return true;
  }

  async function publish(job) {
    const prepared = await prepare(job);
    return publishPrepared(prepared.account, prepared.format, job.caption);
  }

  return { accounts, discover, readDestinations, prepare, publish, publishPrepared, validate, selectOnly, verifyPublished };
}
