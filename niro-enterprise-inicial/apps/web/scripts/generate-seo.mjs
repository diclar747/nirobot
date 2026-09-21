// Genera las páginas públicas de SEO (HTML estático), sitemap.xml y robots.txt dentro de public/.
// Uso: node scripts/generate-seo.mjs   (el resultado se versiona; vite lo copia a dist/)
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SITE = 'https://niro.com.py';
const OUT = new URL('../public/', import.meta.url).pathname;
const TODAY = new Date().toISOString().slice(0, 10);

const pages = [
  {
    slug: 'whatsapp-crm',
    name: 'CRM para WhatsApp',
    title: 'CRM para WhatsApp en Paraguay | Bandeja compartida y equipo | NIRO',
    description: 'NIRO es el CRM para WhatsApp de Paraguay: una bandeja compartida para todo tu equipo, chats por área, respuestas rápidas, etiquetas y seguimiento de cada cliente. Probalo 24 horas.',
    keywords: 'crm whatsapp paraguay, crm para whatsapp, bandeja compartida whatsapp, whatsapp business multiagente, atención al cliente whatsapp, whatsapp para empresas paraguay',
    h1: 'El CRM para WhatsApp de tu empresa en Paraguay',
    lead: 'Conectá el WhatsApp de tu negocio con un código QR y atendé desde un solo lugar con todo tu equipo.',
    points: [
      ['Bandeja compartida', 'Todos los agentes responden desde el mismo número de WhatsApp sin perder mensajes ni pisarse entre sí.'],
      ['Chats por área', 'Cada agente ve los chats de su área (ventas, caja, soporte, recursos humanos) y el auto chat le asigna los nuevos.'],
      ['Estado del equipo en tiempo real', 'Cada agente indica si está disponible, ocupado, en receso o descanso y lo ves al instante.'],
      ['Mensajes bien formateados', 'Negritas, cursivas, listas y enlaces clicables tal como se ven en WhatsApp.'],
      ['Cierre con resultado', 'Al cerrar una conversación registrás categoría y monto, así sabés qué se vendió y quién lo logró.'],
    ],
    related: ['campanas-whatsapp', 'embudo-de-ventas-crm', 'chatbot-ia-whatsapp'],
  },
  {
    slug: 'campanas-whatsapp',
    name: 'Campañas masivas de WhatsApp',
    title: 'Envío masivo de WhatsApp en Paraguay | Campañas personalizadas | NIRO',
    description: 'Enviá campañas de WhatsApp a tus contactos y grupos con el nombre de cada cliente, imágenes, audio y programación. Editá, reenviá y remarcá a quienes no respondieron. Desde NIRO Paraguay.',
    keywords: 'envío masivo whatsapp paraguay, campañas whatsapp, mensajes masivos whatsapp, whatsapp marketing paraguay, difusión whatsapp, enviar whatsapp a muchos contactos',
    h1: 'Campañas de WhatsApp personalizadas para vender más',
    lead: 'Llegá a cientos de clientes con mensajes que llevan su nombre, con imágenes o audio, y medí el resultado.',
    points: [
      ['Personalización', 'Usá {nombre} y otras variables para que cada mensaje se sienta uno a uno.'],
      ['Contactos, grupos y CRM', 'Elegí destinatarios desde tus contactos, tus grupos de WhatsApp o desde un archivo.'],
      ['Programación y control', 'Programá el envío, pausá, editá, reenviá o eliminá campañas desde el listado con filtros por fecha y estado.'],
      ['Remarcar', 'Volvé a escribirles solo a quienes no respondieron.'],
      ['Resultados en vivo', 'Enviados, entregados, leídos y respuestas actualizados en tiempo real.'],
    ],
    related: ['sms-masivo', 'llamadas-masivas-whatsapp', 'whatsapp-crm'],
  },
  {
    slug: 'sms-masivo',
    name: 'SMS masivos',
    title: 'SMS masivos en Paraguay | Campañas de SMS desde Gs. 130 | NIRO',
    description: 'Enviá SMS masivos a celulares de Paraguay desde Gs. 130 por mensaje. Importá contactos desde el CRM, TXT o CSV, normalizamos los números y ves el estado de cada envío. Comprá saldo online.',
    keywords: 'sms masivos paraguay, envío de sms paraguay, mensajes de texto masivos, sms marketing paraguay, campañas sms, comprar sms paraguay, plataforma sms',
    h1: 'SMS masivos en Paraguay, con saldo que comprás online',
    lead: 'Mensajes de texto que se leen en segundos, sin depender de que el cliente tenga internet.',
    points: [
      ['Desde Gs. 130 por SMS', 'Comprás el saldo que necesitás con tarjeta o QR y se acredita a tu empresa.'],
      ['Números siempre bien formados', 'Aceptamos 0985…, 985… o +595… y los convertimos al formato correcto de Paraguay.'],
      ['Importá como quieras', 'Desde tus contactos del CRM, pegando números, un archivo TXT o CSV.'],
      ['Control total', 'Creá la campaña, ejecutala cuando quieras, detenela, editala y reenviala; el saldo se descuenta solo por lo enviado.'],
      ['Historial claro', 'Cada mensaje con su estado de envío y entrega y el consumo de tu saldo.'],
    ],
    related: ['campanas-whatsapp', 'llamadas-masivas-whatsapp', 'gestion-y-reportes'],
  },
  {
    slug: 'llamadas-masivas-whatsapp',
    name: 'Llamadas masivas por WhatsApp',
    title: 'Llamadas masivas por WhatsApp con audio y encuesta | NIRO Paraguay',
    description: 'Automatizá llamadas de WhatsApp que reproducen tu audio y luego le hacen una encuesta al cliente. Cada respuesta puede enviar al contacto a tu embudo de ventas. Solo en NIRO.',
    keywords: 'llamadas masivas whatsapp, llamadas automáticas whatsapp, robocall whatsapp, encuesta por whatsapp, audio masivo whatsapp, llamadas automatizadas paraguay',
    h1: 'Llamadas de WhatsApp automáticas con audio y encuesta',
    lead: 'Tu mensaje de voz llega a cada cliente y, al terminar la llamada, recibe una encuesta para responder con un toque.',
    points: [
      ['Audio propio', 'Subí tu grabación y se reproduce cuando el cliente atiende.'],
      ['Encuesta posterior', 'Cuando la llamada termina, incluso si el cliente corta, le llega la encuesta por WhatsApp.'],
      ['Cada opción, un destino', 'Una respuesta puede mover al contacto a la etapa que elijas del tablero de ventas.'],
      ['Rellamar', 'Relanzá la campaña solo para quienes no atendieron.'],
      ['Historial y filtros', 'Consultá por fecha, categoría y estado, y eliminá campañas viejas.'],
    ],
    related: ['embudo-de-ventas-crm', 'campanas-whatsapp', 'sms-masivo'],
  },
  {
    slug: 'estados-whatsapp',
    name: 'Estados de WhatsApp',
    title: 'Publicar Estados de WhatsApp y ver quién los vio | NIRO',
    description: 'Programá y publicá Estados de WhatsApp de tu empresa y mirá en tiempo real quién los vio y quién les dio me gusta. Marketing de Estados para negocios de Paraguay.',
    keywords: 'estados whatsapp empresa, publicar estados whatsapp, ver quien vio mi estado whatsapp, marketing estados whatsapp, status whatsapp business',
    h1: 'Estados de WhatsApp para tu negocio, con vistas en tiempo real',
    lead: 'Publicá ofertas y novedades en el Estado de tu número de empresa y sabé exactamente quién las vio.',
    points: [
      ['Publicación desde el panel', 'Texto, imagen o video sin tomar el teléfono.'],
      ['Quién lo vio', 'Lista de personas que vieron cada Estado, actualizada al instante.'],
      ['Me gusta', 'Identificá a los clientes que reaccionan para escribirles después.'],
    ],
    related: ['campanas-whatsapp', 'whatsapp-crm', 'gestion-y-reportes'],
  },
  {
    slug: 'chatbot-ia-whatsapp',
    name: 'Chatbot con inteligencia artificial para WhatsApp',
    title: 'Chatbot con IA para WhatsApp en español | Agentes IA | NIRO',
    description: 'Un bot con inteligencia artificial que responde por WhatsApp las 24 horas con la información de tu negocio y pasa el chat a una persona cuando hace falta. Agentes IA por área en NIRO.',
    keywords: 'chatbot whatsapp, bot whatsapp inteligencia artificial, chatbot ia paraguay, atención automática whatsapp, agente ia whatsapp, asistente virtual whatsapp',
    h1: 'Chatbot de inteligencia artificial que atiende tu WhatsApp',
    lead: 'Respuestas inmediatas fuera de horario y en horas pico, con derivación a tu equipo cuando el cliente lo necesita.',
    points: [
      ['Conoce tu negocio', 'Le cargás tus servicios, precios y preguntas frecuentes y responde con eso.'],
      ['Agentes IA por área', 'Distintos asistentes según el tipo de consulta.'],
      ['Pasa a una persona', 'Cuando hace falta, el chat llega a tu equipo con todo el historial.'],
    ],
    related: ['whatsapp-crm', 'widget-chat-web', 'embudo-de-ventas-crm'],
  },
  {
    slug: 'embudo-de-ventas-crm',
    name: 'Embudo de ventas y tableros CRM',
    title: 'Embudo de ventas y tablero Kanban CRM para WhatsApp | NIRO',
    description: 'Organizá tus oportunidades en tableros tipo Kanban con etapas propias, arrastrá clientes de una etapa a otra y conectá cada respuesta de tus campañas al embudo. CRM de ventas NIRO.',
    keywords: 'embudo de ventas, tablero kanban crm, pipeline de ventas, crm de ventas paraguay, seguimiento de clientes, gestión de oportunidades',
    h1: 'Embudo de ventas visual conectado a tu WhatsApp',
    lead: 'Cada cliente en su etapa, con el chat a un clic y el historial completo.',
    points: [
      ['Tableros a tu medida', 'Creá los tableros y etapas que use tu equipo.'],
      ['Arrastrar y soltar', 'Movés a los clientes entre etapas como en un Kanban.'],
      ['Automatizado', 'Las respuestas de las encuestas de llamadas pueden ubicar al contacto en la etapa correcta.'],
      ['Contactos', 'Base de contactos con importación y exportación CSV.'],
    ],
    related: ['whatsapp-crm', 'llamadas-masivas-whatsapp', 'gestion-y-reportes'],
  },
  {
    slug: 'gestion-y-reportes',
    name: 'Gestión y reportes de ventas',
    title: 'Reportes y métricas de atención y ventas por WhatsApp | NIRO',
    description: 'Mirá cuántas conversaciones se cerraron, por qué categoría y por qué monto, con gráficos y filtros por agente y fecha. Reportes de gestión del equipo de atención en NIRO.',
    keywords: 'reportes whatsapp, métricas atención al cliente, dashboard ventas, indicadores de gestión, productividad de agentes, analítica crm',
    h1: 'Reportes de gestión: qué se vende y quién lo logra',
    lead: 'Datos reales de cada conversación cerrada, sin planillas.',
    points: [
      ['Resultados por categoría y monto', 'Cada cierre queda registrado y se suma a los totales.'],
      ['Filtros', 'Por período, agente, área y categoría.'],
      ['Gráficos', 'Evolución en el tiempo y comparación entre agentes.'],
    ],
    related: ['whatsapp-crm', 'embudo-de-ventas-crm', 'sms-masivo'],
  },
  {
    slug: 'widget-chat-web',
    name: 'Widget de chat para tu sitio web',
    title: 'Chat web para tu sitio con bot IA y WhatsApp | NIRO Paraguay',
    description: 'Agregá un chat a tu página web con una línea de código: tus visitantes escriben, el bot IA responde y tu equipo continúa la conversación desde NIRO.',
    keywords: 'chat para sitio web, widget de chat, live chat paraguay, chat web con ia, chat en vivo para empresas',
    h1: 'Chat en tu sitio web conectado con tu equipo',
    lead: 'Convertí visitantes en conversaciones con un widget que se instala pegando un script.',
    points: [
      ['Instalación rápida', 'Un fragmento de código en tu página.'],
      ['Bot y personas', 'El asistente de IA atiende y tu equipo toma el chat cuando quiera.'],
      ['Todo en la misma bandeja', 'Web y WhatsApp juntos.'],
    ],
    related: ['chatbot-ia-whatsapp', 'whatsapp-crm', 'embudo-de-ventas-crm'],
  },
];

const bySlug = Object.fromEntries(pages.map((p) => [p.slug, p]));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const css = `*{box-sizing:border-box}body{margin:0;font:16px/1.65 Inter,system-ui,sans-serif;background:#0b1329;color:#e2e8f0}a{color:#7dd3fc}
header,main,footer{max-width:960px;margin:0 auto;padding:20px}header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;font:800 20px Manrope,system-ui;color:#fff;text-decoration:none}nav a{margin-right:14px;font-size:14px}
h1{font:800 clamp(26px,5vw,40px)/1.2 Manrope,system-ui;color:#fff;margin:24px 0 10px}h2{font:700 22px Manrope,system-ui;color:#fff;margin-top:36px}
.lead{font-size:18px;color:#cbd5e1}.cta{display:inline-block;margin:18px 0;padding:13px 24px;border-radius:12px;background:#22c55e;color:#04210f;font-weight:700;text-decoration:none}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px}.card{background:#111c3a;border:1px solid #1f2d55;border-radius:14px;padding:16px}.card h3{margin:0 0 6px;color:#fff;font-size:17px}.card p{margin:0;color:#cbd5e1;font-size:15px}
footer{color:#94a3b8;font-size:14px;border-top:1px solid #1f2d55;margin-top:40px}`;

function jsonLd(p) {
  const url = `${SITE}/${p.slug}/`;
  return JSON.stringify([
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: `NIRO – ${p.name}`,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web, Android, iOS, Windows',
      description: p.description,
      url,
      inLanguage: 'es',
      areaServed: { '@type': 'Country', name: 'Paraguay' },
      offers: { '@type': 'Offer', priceCurrency: 'PYG', price: '49000', description: 'Desde 49.000 Gs por mes, con 24 horas de prueba' },
      publisher: { '@type': 'Organization', name: 'NIRO', url: SITE },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'NIRO', item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: p.name, item: url },
      ],
    },
  ]);
}

function render(p) {
  const url = `${SITE}/${p.slug}/`;
  const related = p.related.map((s) => `<li><a href="/${s}/">${esc(bySlug[s].name)}</a></li>`).join('');
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.description)}">
<meta name="keywords" content="${esc(p.keywords)}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="theme-color" content="#0b1329">
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="es-PY" href="${url}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta property="og:type" content="website">
<meta property="og:site_name" content="NIRO">
<meta property="og:locale" content="es_PY">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/icons/niro-512.png">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(p.title)}">
<meta name="twitter:description" content="${esc(p.description)}">
<script type="application/ld+json">${jsonLd(p)}</script>
<style>${css}</style>
</head>
<body>
<header><a class="brand" href="/"><img src="/icons/niro-192.png" alt="NIRO" width="40" height="40">NIRO</a>
<nav aria-label="Servicios">${pages.slice(0, 4).map((x) => `<a href="/${x.slug}/">${esc(x.name)}</a>`).join('')}</nav></header>
<main>
<h1>${esc(p.h1)}</h1>
<p class="lead">${esc(p.lead)}</p>
<a class="cta" href="/login">Probar 24 horas</a>
<h2>Qué incluye</h2>
<div class="grid">${p.points.map(([t, d]) => `<section class="card"><h3>${esc(t)}</h3><p>${esc(d)}</p></section>`).join('')}</div>
<h2>Más de NIRO</h2>
<ul>${related}<li><a href="/">Todos los servicios de NIRO</a></li></ul>
<a class="cta" href="/login">Empezar ahora</a>
</main>
<footer>NIRO Enterprise · CRM, campañas, llamadas y SMS por WhatsApp · Paraguay · <a href="https://niro.com.py/">niro.com.py</a></footer>
</body>
</html>
`;
}

for (const p of pages) {
  mkdirSync(resolve(OUT, p.slug), { recursive: true });
  writeFileSync(resolve(OUT, p.slug, 'index.html'), render(p));
}

const urls = [{ loc: `${SITE}/`, priority: '1.0' }, ...pages.map((p) => ({ loc: `${SITE}/${p.slug}/`, priority: '0.8' }))];
writeFileSync(
  resolve(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${TODAY}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`)
    .join('\n')}\n</urlset>\n`
);

const priv = ['/api/', '/dashboard', '/inbox', '/board', '/contactos', '/orders', '/campaigns', '/llamadas', '/estados', '/sms', '/sms-admin', '/gestion', '/reports', '/bot', '/ai-agents', '/users', '/departments', '/settings', '/desarrolladores', '/organizations', '/clientes', '/planes', '/home', '/change-password'];
writeFileSync(
  resolve(OUT, 'robots.txt'),
  `User-agent: *\nAllow: /\n${priv.map((p) => `Disallow: ${p}`).join('\n')}\n\nSitemap: ${SITE}/sitemap.xml\n`
);
console.log(`SEO: ${pages.length} páginas + sitemap.xml + robots.txt`);
