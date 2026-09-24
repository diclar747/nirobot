// Secciones del panel de Facebook/Instagram (niro-autofacebook-paquete). `route` es la ruta interna
// del panel (#/crm, #/messenger...) y también el último tramo de /facebook-instagram/<route> en Niro.
export const FACEBOOK_SECTIONS = [
  { route: 'inicio', panel: '', label: 'Inicio' },
  { route: 'notificaciones', panel: 'notificaciones', label: 'Notificaciones' },
  { route: 'messenger', panel: 'messenger', label: 'Messenger' },
  { route: 'crm', panel: 'crm', label: 'CRM' },
  { route: 'respuestas', panel: 'respuestas', label: 'Respuestas IA' },
  { route: 'publicar', panel: 'publicar', label: 'Crear publicación' },
  { route: 'programacion', panel: 'programacion', label: 'Programación' },
  { route: 'publicaciones', panel: 'publicaciones', label: 'Publicaciones' },
  { route: 'grupos', panel: 'grupos', label: 'Grupos' },
  { route: 'explorar', panel: 'explorar', label: 'Explorar grupos' },
  { route: 'paginas', panel: 'paginas', label: 'Páginas e Instagram' },
  { route: 'borradores', panel: 'borradores', label: 'Borradores' },
  { route: 'datos', panel: 'datos', label: 'Datos y conexión' },
] as const;

export const FACEBOOK_BASE_ROUTE = '/facebook-instagram';

export function sectionByRoute(route: string | undefined) {
  return FACEBOOK_SECTIONS.find((s) => s.route === route) || FACEBOOK_SECTIONS[0];
}

// Hash del panel (#/crm?x=1) → sección de Niro.
export function sectionByPanelHash(hash: string) {
  const name = hash.replace(/^#\/?/, '').split(/[?/]/)[0] || '';
  return FACEBOOK_SECTIONS.find((s) => s.panel === name) || FACEBOOK_SECTIONS[0];
}
