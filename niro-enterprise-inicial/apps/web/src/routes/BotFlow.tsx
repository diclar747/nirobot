import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPatch, apiPost, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { PageHeader, PageShell } from '../components/PageKit';
import type { AiStatus, BotFlow, BotFlowEdge, BotFlowNode, BotNodeType, Department, OrgUser } from '../types';
import '../styles/bot-flow.css';
import { Glyph } from '../components/Ui';

type BuilderTab = 'flow' | 'settings' | 'stats';
type TestMessage = { from: 'user' | 'bot' | 'system' | 'event'; text: string; at: string };
type SimState = { started: boolean; tags: string[]; assignedToId: string | null; departmentId: string | null };
type SimTraceStep = { id: string; title: string; type: string };
interface SimResponse {
  replies: string[];
  handoff?: boolean;
  departmentName?: string | null;
  agentName?: string | null;
  crmStage?: string | null;
  tags?: string[];
  trace?: SimTraceStep[];
  usedAi?: boolean;
  silent?: boolean;
  silentReason?: 'handoff' | 'no-match';
  state: SimState;
}

const EMPTY_SIM_STATE: SimState = { started: false, tags: [], assignedToId: null, departmentId: null };
const nowLabel = () => new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });

const NODE_DEFS: Record<BotNodeType, { label: string; icon: string; color: string; description: string }> = {
  start: { label: 'Inicio', icon: '▶', color: '#10b981', description: 'Comienza el recorrido' },
  message: { label: 'Mensaje', icon: '✉', color: '#3b82f6', description: 'Envía un mensaje' },
  menu: { label: 'Menú de opciones', icon: '☰', color: '#0ea5e9', description: 'Opción 1, 2, 3… a cada departamento' },
  keyword: { label: 'Palabra clave', icon: '⌕', color: '#8b5cf6', description: 'Detecta una intención' },
  condition: { label: 'Condición', icon: '◇', color: '#f59e0b', description: 'Toma una decisión' },
  ai: { label: 'IA / OpenAI', icon: '✦', color: '#a855f7', description: 'Responde con inteligencia artificial' },
  crm: { label: 'Acción CRM', icon: '▦', color: '#14b8a6', description: 'Actualiza una etapa o etiqueta' },
  agent: { label: 'Agente humano', icon: '♙', color: '#f97316', description: 'Deriva a una persona o departamento' },
  end: { label: 'Fin', icon: '■', color: '#ef476f', description: 'Termina el recorrido' }
};

const PALETTE_TYPES: BotNodeType[] = ['message', 'menu', 'keyword', 'condition', 'ai', 'crm', 'agent', 'end'];
const CRM_STAGES = ['abiertas', 'pendientes', 'clientes', 'interesados', 'cerradas'];
const BOT_NODE_WIDTH = 205;
const BOT_NODE_PORT_Y = 46;

type CanvasPoint = { x: number; y: number };

type MenuOption = { key: string; label: string; keywords: string[]; departmentId: string; userId: string; message: string };
function menuOptionsOf(node: BotFlowNode): MenuOption[] {
  const raw = node.data?.options;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const o = (item || {}) as Record<string, unknown>;
    return { key: String(o.key ?? ''), label: String(o.label ?? ''), keywords: Array.isArray(o.keywords) ? o.keywords.map(String) : [], departmentId: String(o.departmentId ?? ''), userId: String(o.userId ?? ''), message: String(o.message ?? '') };
  });
}

// Acomoda los bloques en orden de recorrido, bien juntos, y los baja de fila cuando no entran en el ancho visible.
const LAYOUT_STEP_X = BOT_NODE_WIDTH + 24;
const LAYOUT_STEP_Y = 108;
function visibleCanvasWidth() {
  return Math.max(460, (typeof window === 'undefined' ? 1200 : window.innerWidth) - 620);
}
function layoutPositions(flow: BotFlow, width = visibleCanvasWidth()): Map<string, { x: number; y: number }> {
  const cols = Math.max(2, Math.floor((width - 30) / LAYOUT_STEP_X));
  const start = flow.nodes.find((node) => node.type === 'start');
  const order: string[] = [];
  const queue = start ? [start.id] : [];
  if (start) order.push(start.id);
  while (queue.length) {
    const current = queue.shift()!;
    flow.edges.filter((edge) => edge.from === current).forEach((edge) => {
      if (!order.includes(edge.to)) { order.push(edge.to); queue.push(edge.to); }
    });
  }
  flow.nodes.forEach((node) => { if (!order.includes(node.id)) order.push(node.id); });
  const positions = new Map<string, { x: number; y: number }>();
  order.forEach((id, index) => positions.set(id, { x: 30 + (index % cols) * LAYOUT_STEP_X, y: 30 + Math.floor(index / cols) * LAYOUT_STEP_Y }));
  return positions;
}
// Un flujo "estirado": hay bloques fuera de lo que entra en pantalla.
function isSpreadOut(flow: BotFlow, width = visibleCanvasWidth()) {
  if (flow.nodes.length < 3) return false;
  const xs = flow.nodes.map((node) => node.position.x);
  const ys = flow.nodes.map((node) => node.position.y);
  return Math.max(...xs) + BOT_NODE_WIDTH + 30 > width || Math.max(...ys) - Math.min(...ys) > 500;
}
function readPref(key: string) { try { return localStorage.getItem(key) === '1'; } catch { return false; } }
function writePref(key: string, on: boolean) { try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* sin almacenamiento */ } }


function nodeDataString(node: BotFlowNode, key: string) {
  const value = node.data?.[key];
  return typeof value === 'string' ? value : '';
}

function nodeDataBoolean(node: BotFlowNode, key: string) {
  return node.data?.[key] === true;
}

function nodeDataArray(node: BotFlowNode, key: string) {
  const value = node.data?.[key];
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function createNode(type: BotNodeType, index: number, position?: { x: number; y: number }): BotFlowNode {
  const def = NODE_DEFS[type];
  const defaults: Record<BotNodeType, Record<string, unknown>> = {
    start: {},
    message: { text: 'Escribí el mensaje que recibirá el cliente.', onlyOnNew: false },
    menu: { text: '¿Con qué área querés hablar?', invalidText: 'No entendí tu respuesta. Elegí una opción:', options: [{ key: '1', label: 'Ventas', keywords: [], departmentId: '', userId: '', message: 'Te paso con Ventas. En un momento te atienden.' }] },
    keyword: { keywords: ['ventas', 'precio'], response: 'Perfecto, te ayudamos con eso.', matchLabel: 'Coincide', fallbackLabel: 'No coincide' },
    condition: { condition: 'new_contact' },
    ai: { prompt: 'Respondé con claridad, en español y ofrecé pasar a un agente si no tenés la información.' },
    crm: { stage: 'interesados', tags: ['Bot'] },
    agent: { departmentId: '', userId: '', message: 'Te paso con una persona del equipo. En un momento te atienden.' },
    end: {}
  };
  return {
    id: `node-${Date.now()}-${index}`,
    type,
    title: def.label,
    description: def.description,
    position: position || { x: 90 + (index % 3) * 270, y: 90 + Math.floor(index / 3) * 170 },
    data: defaults[type]
  };
}

function flowNodeSummary(node: BotFlowNode) {
  if (node.type === 'message') return nodeDataString(node, 'text') || 'Sin mensaje configurado';
  if (node.type === 'menu') return `${menuOptionsOf(node).length} opciones: ${menuOptionsOf(node).map((o) => o.key || o.label).join(', ')}`;
  if (node.type === 'keyword') return nodeDataArray(node, 'keywords').join(', ') || 'Sin palabras clave';
  if (node.type === 'ai') return 'Responde con IA según sus instrucciones';
  if (node.type === 'crm') return `Etapa: ${nodeDataString(node, 'stage') || 'No definida'}`;
  if (node.type === 'agent') return 'Deriva a un agente o departamento';
  if (node.type === 'condition') return `Condición: ${nodeDataString(node, 'condition') || 'Siempre'}`;
  return NODE_DEFS[node.type].description;
}

export function BotFlow() {
  const { user } = useAuth();
  const canManage = user ? ['OWNER', 'ADMIN', 'SUPERVISOR'].includes(user.role) : false;
  const [flow, setFlow] = useState<BotFlow | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [tab, setTab] = useState<BuilderTab>('flow');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leftMin, setLeftMin] = useState(() => readPref('niro_bot_left_min'));
  const [rightMin, setRightMin] = useState(() => readPref('niro_bot_right_min'));
  const [notice, setNotice] = useState<string | null>(null);
  const [testInput, setTestInput] = useState('');
  const [testMessages, setTestMessages] = useState<TestMessage[]>([]);
  const [testing, setTesting] = useState(false);
  const [simState, setSimState] = useState<SimState>(EMPTY_SIM_STATE);
  const [simTrace, setSimTrace] = useState<SimTraceStep[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const nodeDragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [connectionStartId, setConnectionStartId] = useState<string | null>(null);
  const [connectionPointer, setConnectionPointer] = useState<CanvasPoint | null>(null);

  useEffect(() => {
    Promise.all([
      apiGet<{ flow: BotFlow; aiEnabled: boolean; aiConfigured: boolean }>('/api/org/bot-flow'),
      apiGet<{ departments: Department[] }>('/api/org/departments'),
      apiGet<{ users: OrgUser[] }>('/api/org/users').catch(() => ({ users: [] })),
      apiGet<AiStatus>('/api/org/ai/status').catch(() => null)
    ]).then(([flowData, departmentData, userData, statusData]) => {
      const loaded = flowData.flow;
      if (isSpreadOut(loaded)) {
        const positions = layoutPositions(loaded);
        setFlow({ ...loaded, nodes: loaded.nodes.map((node) => ({ ...node, position: positions.get(node.id) || node.position })) });
        setNotice('Acomodé los bloques más juntos para que se vea todo. Guardá el flujo si querés conservarlo.');
      } else setFlow(loaded);
      setSelectedNodeId(loaded.nodes[0]?.id || '');
      setDepartments(departmentData.departments);
      setUsers(userData.users);
      setAiStatus(statusData);
    }).catch((err) => setError(err instanceof ApiError ? err.message : 'No se pudo cargar el flujo del bot')).finally(() => setLoading(false));
  }, []);

  const selectedNode = useMemo(() => flow?.nodes.find((node) => node.id === selectedNodeId) || null, [flow, selectedNodeId]);
  const metrics = useMemo(() => {
    const nodes = flow?.nodes || [];
    return {
      nodes: nodes.length,
      keywords: nodes.filter((node) => node.type === 'keyword').length,
      actions: nodes.filter((node) => ['crm', 'agent', 'menu'].includes(node.type)).length,
      ai: nodes.filter((node) => node.type === 'ai').length,
      connections: flow?.edges.length || 0
    };
  }, [flow]);

  const canvasSize = useMemo(() => {
    const nodes = flow?.nodes || [];
    const maxX = Math.max(0, ...nodes.map((node) => node.position.x + BOT_NODE_WIDTH + 100), connectionPointer?.x || 0);
    const maxY = Math.max(0, ...nodes.map((node) => node.position.y + 150), connectionPointer?.y || 0);
    return { width: Math.max(760, maxX), height: Math.max(520, maxY) };
  }, [flow?.nodes, connectionPointer]);

  function updateFlow(patch: Partial<BotFlow>) {
    setFlow((current) => current ? { ...current, ...patch } : current);
    setNotice(null);
  }

  function updateNode(id: string, patch: Partial<BotFlowNode>) {
    setFlow((current) => current ? { ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, ...patch } : node) } : current);
    setNotice(null);
  }

  function updateNodePosition(id: string, position: CanvasPoint) {
    setFlow((current) => current ? { ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, position } : node) } : current);
    setNotice(null);
  }

  function updateNodeData(id: string, key: string, value: unknown) {
    setFlow((current) => current ? { ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, [key]: value } } : node) } : current);
    setNotice(null);
  }


  // Arma el flujo por áreas: UN bloque "Menú de opciones" con una opción numerada por departamento. No se guarda hasta apretar Guardar.
  function buildAreasFlow() {
    if (!flow) return;
    if (!departments.length) { setNotice(null); setError('Primero creá tus departamentos (Ventas, Compras, Soporte…) en Departamentos y volvé acá.'); return; }
    setError(null);
    const stamp = Date.now();
    const menuId = `menu-${stamp}`;
    const options: MenuOption[] = departments.slice(0, 20).map((department, index) => ({
      key: String(index + 1), label: department.name, keywords: [], departmentId: department.id, userId: '',
      message: `Te paso con ${department.name}. En un momento te atienden.`
    }));
    const nodes: BotFlowNode[] = [
      { id: 'start', type: 'start', title: 'Inicio', description: 'Entrada de cada conversación', position: { x: 30, y: 30 }, data: {} },
      { id: menuId, type: 'menu', title: 'Menú de áreas', description: 'Opción 1, 2, 3… a cada departamento', position: { x: 30 + LAYOUT_STEP_X, y: 30 }, data: { text: '¡Hola {{nombre}}! ¿Con qué área querés hablar?', invalidText: 'No entendí tu respuesta. Elegí una opción:', options } },
      { id: `end-${stamp}`, type: 'end', title: 'Fin', description: 'Finaliza este recorrido', position: { x: 30 + LAYOUT_STEP_X * 2, y: 30 }, data: {} }
    ];
    updateFlow({ nodes, edges: [{ id: `edge-start-${menuId}`, from: 'start', to: menuId, label: '' }, { id: `edge-${menuId}-end`, from: menuId, to: `end-${stamp}`, label: '' }] });
    setSelectedNodeId(menuId);
    setTab('flow');
    setNotice('Menú por áreas generado con tus departamentos. Revisá las opciones, probalo abajo, y apretá Guardar y luego Publicar flujo.');
  }

  function addNode(type: BotNodeType, position?: { x: number; y: number }) {
    if (!flow) return;
    const node = createNode(type, flow.nodes.length, position);
    const previous = flow.nodes[flow.nodes.length - 1];
    const edge: BotFlowEdge | null = previous && previous.type !== 'end' ? { id: `edge-${previous.id}-${node.id}`, from: previous.id, to: node.id, label: '' } : null;
    updateFlow({ nodes: [...flow.nodes, node], edges: edge ? [...flow.edges, edge] : flow.edges });
    setSelectedNodeId(node.id);
    setTab('flow');
  }

  // Copia un bloque con toda su configuración (útil para menús u opciones parecidas).
  function duplicateNode(id: string) {
    if (!flow) return;
    const original = flow.nodes.find((node) => node.id === id);
    if (!original || ['start', 'end'].includes(original.type)) return;
    const copy: BotFlowNode = {
      ...original,
      id: `${original.type}-${Date.now()}`,
      title: `${original.title} (copia)`,
      data: JSON.parse(JSON.stringify(original.data || {})),
      position: { x: original.position.x + 30, y: original.position.y + 30 }
    };
    updateFlow({ nodes: [...flow.nodes, copy] });
    setSelectedNodeId(copy.id);
  }

  // Deja el flujo vacío (solo el bloque Inicio) para armarlo de nuevo desde cero.
  async function clearFlow() {
    if (!flow) return;
    if (!window.confirm('¿Vaciar el flujo? Se borran todos los bloques y conexiones, y el bot deja de responder hasta que publiques uno nuevo.')) return;
    const start = flow.nodes.find((node) => node.type === 'start') || { id: 'start', type: 'start' as BotNodeType, title: 'Inicio', description: 'Entrada de cada conversación', position: { x: 30, y: 30 }, data: {} };
    const empty = { ...flow, nodes: [{ ...start, position: { x: 30, y: 30 } }], edges: [], enabled: false, published: false };
    setSelectedNodeId('start');
    updateFlow(empty);
    await saveFlow(empty);
    setNotice('Flujo vaciado. Armá el nuevo y tocá "Publicar flujo" cuando esté listo.');
  }

  function removeNode(id: string) {
    if (!flow || ['start', 'end'].includes(flow.nodes.find((node) => node.id === id)?.type || '')) return;
    updateFlow({ nodes: flow.nodes.filter((node) => node.id !== id), edges: flow.edges.filter((edge) => edge.from !== id && edge.to !== id) });
    setSelectedNodeId(flow.nodes.find((node) => node.id !== id)?.id || '');
  }

  function updateEdge(id: string, patch: Partial<BotFlowEdge>) {
    if (!flow) return;
    updateFlow({ edges: flow.edges.map((edge) => edge.id === id ? { ...edge, ...patch } : edge) });
  }

  function addConnection(to: string) {
    if (!flow || !selectedNode || !to || to === selectedNode.id) return;
    const source = flow.nodes.find((node) => node.id === selectedNode.id);
    const target = flow.nodes.find((node) => node.id === to);
    if (!source || !target || source.type === 'end' || target.type === 'start') return;
    const exists = flow.edges.some((edge) => edge.from === selectedNode.id && edge.to === to);
    if (exists) return;
    updateFlow({ edges: [...flow.edges, { id: `edge-${selectedNode.id}-${to}-${Date.now()}`, from: selectedNode.id, to, label: '' }] });
  }

  function connectNodes(from: string, to: string) {
    if (!flow || !from || !to || from === to) return;
    const source = flow.nodes.find((node) => node.id === from);
    const target = flow.nodes.find((node) => node.id === to);
    if (!source || !target || source.type === 'end' || target.type === 'start') return;
    if (flow.edges.some((edge) => edge.from === from && edge.to === to)) return;
    updateFlow({ edges: [...flow.edges, { id: `edge-${from}-${to}-${Date.now()}`, from, to, label: '' }] });
    setSelectedNodeId(from);
    setNotice('Conexión creada. Guardá el flujo para aplicar los cambios.');
  }

  function removeEdge(id: string) {
    if (!flow) return;
    updateFlow({ edges: flow.edges.filter((edge) => edge.id !== id) });
  }

  function dropNode(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const id = event.dataTransfer.getData('text/plain');
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || !flow || !id) return;
    const position = { x: Math.max(12, event.clientX - rect.left + (canvasRef.current?.scrollLeft || 0) - 100), y: Math.max(12, event.clientY - rect.top + (canvasRef.current?.scrollTop || 0) - 35) };
    if (id.startsWith('palette:')) {
      const type = id.slice('palette:'.length) as BotNodeType;
      if (PALETTE_TYPES.includes(type)) addNode(type, position);
      return;
    }
    updateNode(id, { position });
  }

  function canvasPoint(clientX: number, clientY: number): CanvasPoint | null {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || !canvasRef.current) return null;
    return { x: clientX - rect.left + canvasRef.current.scrollLeft, y: clientY - rect.top + canvasRef.current.scrollTop };
  }

  function beginNodeDrag(event: React.PointerEvent<HTMLDivElement>, node: BotFlowNode) {
    if (event.button !== 0 || connectionStartId) return;
    const point = canvasPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    nodeDragRef.current = { id: node.id, offsetX: point.x - node.position.x, offsetY: point.y - node.position.y };
    setSelectedNodeId(node.id);
    setDraggingNodeId(node.id);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveNodeFromPointer(event: React.PointerEvent<HTMLDivElement>, id: string) {
    const drag = nodeDragRef.current;
    if (!drag || drag.id !== id) return;
    const point = canvasPoint(event.clientX, event.clientY);
    if (!point) return;
    updateNodePosition(id, { x: Math.max(18, Math.round(point.x - drag.offsetX)), y: Math.max(18, Math.round(point.y - drag.offsetY)) });
  }

  function endNodeDrag(event: React.PointerEvent<HTMLDivElement>, id: string) {
    if (nodeDragRef.current?.id !== id) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    nodeDragRef.current = null;
    setDraggingNodeId(null);
  }

  function beginConnection(event: React.PointerEvent<HTMLDivElement>, nodeId: string) {
    event.preventDefault();
    event.stopPropagation();
    const node = flow?.nodes.find((item) => item.id === nodeId);
    const point = canvasPoint(event.clientX, event.clientY);
    if (!node || node.type === 'end' || !point) return;
    nodeDragRef.current = null;
    setDraggingNodeId(null);
    setConnectionStartId(nodeId);
    setConnectionPointer(point);
  }

  function moveConnection(event: React.PointerEvent<HTMLDivElement>) {
    if (!connectionStartId) return;
    const point = canvasPoint(event.clientX, event.clientY);
    if (point) setConnectionPointer(point);
  }

  function finishConnection(event: React.PointerEvent<HTMLDivElement>, nodeId: string) {
    event.preventDefault();
    event.stopPropagation();
    if (connectionStartId) connectNodes(connectionStartId, nodeId);
    setConnectionStartId(null);
    setConnectionPointer(null);
  }

  function cancelConnection() {
    setConnectionStartId(null);
    setConnectionPointer(null);
  }

  function arrangeNodes() {
    if (!flow) return;
    const positions = layoutPositions(flow, canvasRef.current?.clientWidth || undefined);
    updateFlow({ nodes: flow.nodes.map((node) => ({ ...node, position: positions.get(node.id) || node.position })) });
    setNotice('Flujo ordenado y compacto. Guardá el flujo para conservar la distribución.');
  }

  async function saveFlow(nextFlow = flow) {
    if (!nextFlow || !canManage) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const data = await apiPatch<{ flow: BotFlow }>('/api/org/bot-flow', { flow: nextFlow });
      setFlow(data.flow);
      setNotice('Cambios guardados correctamente.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar el flujo');
    } finally {
      setSaving(false);
    }
  }

  async function publishFlow() {
    if (!flow) return;
    const nextFlow = { ...flow, enabled: true, published: true };
    updateFlow(nextFlow);
    await saveFlow(nextFlow);
  }

  // ---- Simulador ---------------------------------------------------------
  // Corre el flujo guardado/editado contra un cliente de prueba. El servidor mantiene el estado de la conversación
  // simulada (primer mensaje, derivación), así el resultado es el mismo que verá el cliente real.
  const menuChips = useMemo(() => {
    if (!flow) return [] as { key: string; label: string }[];
    const menu = flow.nodes.find((node) => node.type === 'menu');
    if (!menu) return [];
    return menuOptionsOf(menu)
      .filter((option) => option.key || option.label)
      .slice(0, 6)
      .map((option) => ({ key: String(option.key || option.label), label: String(option.label || option.key) }));
  }, [flow]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ block: 'end' }); }, [testMessages, testing]);

  function resetSimulation() {
    setTestMessages([]);
    setSimState(EMPTY_SIM_STATE);
    setSimTrace([]);
    setTestInput('');
  }

  async function sendToSimulator(rawMessage: string) {
    const message = rawMessage.trim();
    if (!message || testing) return;
    setTesting(true);
    setTestMessages((current) => [...current, { from: 'user', text: message, at: nowLabel() }]);
    setTestInput('');
    try {
      const data = await apiPost<SimResponse>('/api/org/bot-flow/test', { message, flow, state: simState });
      const events: TestMessage[] = [];
      if (data.handoff) {
        const destino = data.agentName || data.departmentName;
        events.push({ from: 'event', text: destino ? `Derivado a ${destino}. Desde acá responde tu equipo.` : 'Derivado al equipo. Desde acá responde una persona.', at: nowLabel() });
      }
      if (data.crmStage) events.push({ from: 'event', text: `CRM: la conversación pasa a "${data.crmStage}".`, at: nowLabel() });
      if (data.tags && data.tags.length) events.push({ from: 'event', text: `Etiquetas: ${data.tags.join(', ')}.`, at: nowLabel() });
      if (data.usedAi) events.push({ from: 'event', text: 'Respondió el bloque de IA.', at: nowLabel() });

      const replies: TestMessage[] = data.replies.map((text) => ({ from: 'bot' as const, text, at: nowLabel() }));
      const silent: TestMessage[] = data.silent
        ? [{ from: 'system' as const, at: nowLabel(), text: data.silentReason === 'handoff'
            ? 'El bot no responde: la conversación ya está derivada a tu equipo.'
            : 'El bot no respondió: ningún bloque coincide con este mensaje. Agregá una salida "No coincide" o un bloque de IA.' }]
        : [];
      setTestMessages((current) => [...current, ...replies, ...events, ...silent]);
      setSimTrace(data.trace || []);
      setSimState(data.state);
    } catch (err) {
      setTestMessages((current) => [...current, { from: 'system', text: err instanceof ApiError ? err.message : 'No se pudo probar el flujo.', at: nowLabel() }]);
    } finally {
      setTesting(false);
    }
  }

  async function testFlow(event: React.FormEvent) {
    event.preventDefault();
    await sendToSimulator(testInput);
  }

  if (loading) return <PageShell><PageHeader tone="violet" icon={<Glyph c="✦" size={22} />} title="Flujos de Bot" subtitle="Cargando el constructor de Niro…" /><div className="bot-flow-loading">Preparando tu espacio de automatización…</div></PageShell>;
  if (!flow) return <PageShell><PageHeader tone="violet" icon={<Glyph c="✦" size={22} />} title="Flujos de Bot" subtitle="Automatizaciones conversacionales de Niro" /><div className="alert error">{error || 'No se pudo cargar el flujo.'}</div></PageShell>;

  return (
    <PageShell><div className="bot-flow-page">
      <PageHeader tone="violet" hero={{ eyebrow: 'Automatización', title: 'Conversaciones que se responden solas.', text: 'Combiná IA, palabras clave, CRM y derivación a agentes humanos.', compact: true }} icon={<Glyph c="✦" size={22} />} title="Flujos de Bot" subtitle="Creá experiencias conversacionales con IA, palabras clave, CRM y agentes humanos." actions={<div className="bot-header-actions"><span className={`bot-publish-pill ${flow.published && flow.enabled ? 'active' : ''}`}><i /> {flow.published && flow.enabled ? 'Publicado' : 'Borrador'}</span>{canManage && <button type="button" className="btn secondary" onClick={() => saveFlow()} disabled={saving}>{saving ? 'Guardando…' : 'Guardar'}</button>}{canManage && <button type="button" className="btn" onClick={publishFlow} disabled={saving}>{flow.published && flow.enabled ? <><Glyph c="✓" size={14} /> Publicado</> : 'Publicar flujo'}</button>}</div>} />
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}

      <div className="bot-flow-topbar"><div className="bot-flow-title"><span className="bot-flow-logo">N</span><div><input value={flow.name} onChange={(event) => updateFlow({ name: event.target.value })} disabled={!canManage} aria-label="Nombre del flujo" /><small>{metrics.nodes} nodos · {metrics.connections} conexiones · guardado por organización</small></div></div><div className="bot-flow-tabs" role="tablist">{([['flow', '⚯ Flujo'], ['settings', '⚙ Configuración'], ['stats', '▥ Estadísticas']] as [BuilderTab, string][]).map(([value, label]) => <button type="button" key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}><Glyph c={label.split(' ')[0]} size={16} /> {label.split(' ').slice(1).join(' ')}</button>)}</div></div>

      {tab === 'flow' && <div className={`bot-builder-layout${leftMin ? ' left-min' : ''}${rightMin ? ' right-min' : ''}`}>
        {leftMin ? <aside className="bot-palette is-min" aria-label="Herramientas (minimizado)"><button type="button" className="bot-panel-toggle" onClick={() => { setLeftMin(false); writePref('niro_bot_left_min', false); }} title="Mostrar herramientas" aria-label="Mostrar herramientas"><Glyph c="»" size={14} /></button>{PALETTE_TYPES.map((type) => <button key={type} type="button" className="bot-rail-icon" style={{ color: NODE_DEFS[type].color }} draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', `palette:${type}`)} onClick={() => addNode(type)} title={`Agregar: ${NODE_DEFS[type].label}`} aria-label={`Agregar ${NODE_DEFS[type].label}`}><Glyph c={NODE_DEFS[type].icon} size={16} /></button>)}</aside> : <aside className="bot-palette"><button type="button" className="bot-panel-toggle end" onClick={() => { setLeftMin(true); writePref('niro_bot_left_min', true); }} title="Minimizar herramientas" aria-label="Minimizar herramientas"><Glyph c="«" size={14} /></button><div className="bot-panel-kicker">NODOS</div><h3>Construí tu flujo</h3><p>Arrastrá un nodo al lienzo o agregalo con un clic.</p><button type="button" className="bot-palette-start" onClick={() => setSelectedNodeId(flow.nodes.find((node) => node.type === 'start')?.id || '')}><Glyph c="▶" size={13} /> <span>Inicio activo</span></button>{canManage && <button type="button" className="btn secondary small" style={{ width: '100%', margin: '0 0 12px', whiteSpace: 'nowrap', justifyContent: 'center' }} onClick={buildAreasFlow} title="Crea un menú con una opción numerada por cada departamento (1 Ventas, 2 Compras…)"><Glyph c="♙" size={14} /> Menú por áreas</button>}<div className="bot-palette-group"><small>MENSAJES</small>{PALETTE_TYPES.slice(0, 2).map((type) => <PaletteButton key={type} type={type} onAdd={() => addNode(type)} />)}</div><div className="bot-palette-group"><small>LÓGICA</small>{PALETTE_TYPES.slice(2, 5).map((type) => <PaletteButton key={type} type={type} onAdd={() => addNode(type)} />)}</div><div className="bot-palette-group"><small>ACCIONES</small>{PALETTE_TYPES.slice(5).map((type) => <PaletteButton key={type} type={type} onAdd={() => addNode(type)} />)}</div><div className="bot-flow-mini-map"><div className="bot-mini-map-title">Vista general</div><div className="bot-mini-map-dots">{flow.nodes.slice(0, 18).map((node) => <i key={node.id} style={{ background: NODE_DEFS[node.type].color }} />)}</div></div></aside>}
        <main className="bot-canvas-panel"><div className="bot-canvas-toolbar"><div><strong>Flujo: {flow.name}</strong><span>Arrastrá bloques · conectá desde los puntos</span></div><div className="bot-canvas-tools">{canManage && <button type="button" className="bot-canvas-clear" onClick={clearFlow} title="Borra todos los bloques y deja el flujo vacío para empezar de nuevo">✕ Empezar de cero</button>}<span className={`bot-canvas-mode ${connectionStartId ? 'active' : ''}`}>{connectionStartId ? 'Elegí un destino' : 'Editor visual'}</span><button type="button" className="bot-tool-button" onClick={arrangeNodes}>⌗ Organizar</button><button type="button" className="bot-tool-button" onClick={() => setTab('settings')} aria-label="Configuración del flujo"><Glyph c="⚙" size={16} /></button></div></div><div className={`bot-canvas ${connectionStartId ? 'is-connecting' : ''}`} ref={canvasRef} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }} onDrop={dropNode} onPointerMove={moveConnection} onPointerUp={cancelConnection} onPointerCancel={cancelConnection}><div className="bot-canvas-grid" style={{ width: canvasSize.width, height: canvasSize.height }} /><svg className="bot-canvas-lines" style={{ width: canvasSize.width, height: canvasSize.height }} aria-hidden="true"><defs><marker id="bot-edge-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M 0 0 L 7 3.5 L 0 7 z" fill="#8eb8ed" /></marker></defs>{flow.edges.map((edge, edgeIndex) => { const from = flow.nodes.find((node) => node.id === edge.from); const to = flow.nodes.find((node) => node.id === edge.to); if (!from || !to) return null; const x1 = from.position.x + BOT_NODE_WIDTH; const y1 = from.position.y + BOT_NODE_PORT_Y; const x2 = to.position.x; const y2 = to.position.y + BOT_NODE_PORT_Y; const mid = (x1 + x2) / 2; const path = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`; const signalColor = NODE_DEFS[from.type].color; return <g key={edge.id} className="bot-edge-group"><path className="bot-edge-base" d={path} markerEnd="url(#bot-edge-arrow)" /><path className="bot-edge-signal" d={path} style={{ stroke: signalColor, animationDelay: `${edgeIndex * -0.24}s` }} /><text x={mid} y={(y1 + y2) / 2 - 5}>{edge.label}</text></g>; })}{connectionStartId && connectionPointer && (() => { const from = flow.nodes.find((node) => node.id === connectionStartId); if (!from) return null; const x1 = from.position.x + BOT_NODE_WIDTH; const y1 = from.position.y + BOT_NODE_PORT_Y; const mid = (x1 + connectionPointer.x) / 2; return <path className="bot-edge-preview" d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${connectionPointer.y}, ${connectionPointer.x} ${connectionPointer.y}`} />; })()}</svg>{flow.nodes.map((node) => <BotNodeCard key={node.id} node={node} selected={node.id === selectedNodeId} dragging={node.id === draggingNodeId} onDuplicate={() => duplicateNode(node.id)} onRemove={() => removeNode(node.id)} onSelect={() => setSelectedNodeId(node.id)} onPointerDown={(event) => beginNodeDrag(event, node)} onPointerMove={(event) => moveNodeFromPointer(event, node.id)} onPointerUp={(event) => endNodeDrag(event, node.id)} onConnectStart={(event) => beginConnection(event, node.id)} onConnectEnd={(event) => finishConnection(event, node.id)} />)}<div className="bot-canvas-hint">{connectionStartId ? 'Soltá sobre el punto izquierdo de otro nodo' : 'Arrastrá bloques · conectá los puntos'}</div></div></main>
        {rightMin ? <aside className="bot-properties-panel is-min" aria-label="Propiedades (minimizado)"><button type="button" className="bot-panel-toggle" onClick={() => { setRightMin(false); writePref('niro_bot_right_min', false); }} title="Mostrar propiedades" aria-label="Mostrar propiedades"><Glyph c="«" size={14} /></button>{selectedNode && <button type="button" className="bot-rail-icon" style={{ color: NODE_DEFS[selectedNode.type].color }} onClick={() => { setRightMin(false); writePref('niro_bot_right_min', false); }} title={`Propiedades: ${selectedNode.title}`} aria-label="Mostrar propiedades"><Glyph c={NODE_DEFS[selectedNode.type].icon} size={16} /></button>}{selectedNode && !['start', 'end'].includes(selectedNode.type) && <button type="button" className="bot-rail-icon danger" onClick={() => removeNode(selectedNode.id)} title="Eliminar bloque" aria-label="Eliminar bloque"><Glyph c="⌫" size={15} /></button>}</aside> : <aside className="bot-properties-panel"><div className="bot-properties-head"><button type="button" className="bot-panel-toggle" onClick={() => { setRightMin(true); writePref('niro_bot_right_min', true); }} title="Minimizar propiedades" aria-label="Minimizar propiedades"><Glyph c="»" size={14} /></button><div><span className="bot-panel-kicker">PROPIEDADES</span><h3>{selectedNode ? selectedNode.title : 'Seleccioná un nodo'}</h3></div>{selectedNode && !['start', 'end'].includes(selectedNode.type) && <button type="button" className="bot-icon-button danger" onClick={() => removeNode(selectedNode.id)} aria-label="Eliminar nodo">⌫</button>}</div>{selectedNode ? <NodeProperties node={selectedNode} flow={flow} departments={departments} users={users} onUpdate={updateNode} onData={updateNodeData} onConnect={addConnection} onEdgeUpdate={updateEdge} onEdgeRemove={removeEdge} /> : <div className="bot-properties-empty">Elegí un bloque del lienzo para configurar su comportamiento.</div>}</aside>}
      </div>}

      {tab === 'settings' && <BotSettings flow={flow} aiStatus={aiStatus} canManage={canManage} onUpdate={updateFlow} onSave={() => saveFlow()} saving={saving} />}
      {tab === 'stats' && <BotStats flow={flow} metrics={metrics} />}

      <section className="bot-sim-panel" aria-label="Simulador de conversación">
        <header className="bot-sim-head">
          <div className="bot-sim-title">
            <span className="bot-panel-kicker">PROBAR FLUJO</span>
            <h3>Simulador de conversación</h3>
            <p>Escribí como si fueras el cliente. No se contacta a nadie: es una copia del flujo corriendo en seco.</p>
          </div>
          <div className="bot-sim-head-actions">
            <span className={`bot-sim-state ${simState.started ? 'live' : ''}`}><i /> {simState.tags.includes('Derivado') ? 'Derivado al equipo' : simState.started ? 'Conversación en curso' : 'Sin iniciar'}</span>
            <button type="button" className="btn secondary small" onClick={resetSimulation} disabled={testing || (!simState.started && testMessages.length === 0)}>↺ Reiniciar</button>
          </div>
        </header>

        <div className="bot-sim-body">
          <div className="bot-sim-chat">
            <div className="bot-sim-contact">
              <span className="bot-sim-avatar">MG</span>
              <div>
                <b>María González</b>
                <small>+595 981 123 456 · cliente de prueba</small>
              </div>
              <span className="bot-sim-channel">WhatsApp</span>
            </div>

            <div className="bot-sim-messages">
              {testMessages.length === 0 && (
                <div className="bot-sim-empty">
                  <Glyph c="✦" size={22} />
                  <b>Probá tu flujo</b>
                  <span>El primer mensaje se trata como una conversación nueva: vas a ver el saludo y el menú tal cual los recibe el cliente.</span>
                </div>
              )}
              {testMessages.map((message, index) => (
                message.from === 'event' || message.from === 'system' ? (
                  <div className={`bot-sim-note ${message.from}`} key={`${message.from}-${index}`}>
                    <Glyph c={message.from === 'event' ? '✓' : 'i'} size={12} /> {message.text}
                  </div>
                ) : (
                  <div className={`bot-sim-bubble-row ${message.from}`} key={`${message.from}-${index}`}>
                    {message.from === 'bot' && <span className="bot-sim-bubble-avatar">N</span>}
                    <div className="bot-sim-bubble">
                      <p>{message.text}</p>
                      <time>{message.at}</time>
                    </div>
                  </div>
                )
              ))}
              {testing && <div className="bot-sim-bubble-row bot"><span className="bot-sim-bubble-avatar">N</span><div className="bot-sim-bubble typing"><i /><i /><i /></div></div>}
              <div ref={chatEndRef} />
            </div>

            {menuChips.length > 0 && (
              <div className="bot-sim-chips">
                <span>Respuestas rápidas:</span>
                {menuChips.map((chip) => (
                  <button type="button" key={chip.key} disabled={testing} onClick={() => sendToSimulator(chip.key)}>{chip.key}. {chip.label}</button>
                ))}
              </div>
            )}

            <form className="bot-sim-form" onSubmit={testFlow}>
              <input value={testInput} onChange={(event) => setTestInput(event.target.value)} placeholder="Escribí un mensaje como el cliente…" disabled={testing} aria-label="Mensaje de prueba" />
              <button type="submit" disabled={testing || !testInput.trim()} aria-label="Enviar"><Glyph c="➤" size={15} /></button>
            </form>
          </div>

          <aside className="bot-sim-side">
            <div className="bot-sim-side-block">
              <span className="bot-sim-side-title">Recorrido del último mensaje</span>
              {simTrace.length === 0 ? (
                <p className="bot-sim-side-empty">Todavía no hay recorrido. Mandá un mensaje para ver por qué bloques pasa.</p>
              ) : (
                <ol className="bot-sim-trace">
                  {simTrace.map((step, index) => (
                    <li key={`${step.id}-${index}`}>
                      <span className="bot-sim-trace-dot" style={{ background: NODE_DEFS[step.type as BotNodeType]?.color || 'var(--text-dim)' }} />
                      <b>{step.title}</b>
                      <small>{NODE_DEFS[step.type as BotNodeType]?.label || step.type}</small>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div className="bot-sim-side-block">
              <span className="bot-sim-side-title">Estado de la conversación</span>
              <ul className="bot-sim-facts">
                <li><span>Etapa</span><b>{simState.tags.includes('Derivado') ? 'Derivada al equipo' : simState.started ? 'Atendida por el bot' : 'Sin iniciar'}</b></li>
                <li><span>Área</span><b>{departments.find((department) => department.id === simState.departmentId)?.name || '—'}</b></li>
                <li><span>Agente</span><b>{users.find((item) => item.id === simState.assignedToId)?.name || '—'}</b></li>
                <li><span>Etiquetas</span><b>{simState.tags.length ? simState.tags.join(', ') : '—'}</b></li>
              </ul>
              {aiStatus && !aiStatus.configured && <p className="bot-sim-side-empty">La IA no está configurada en el servidor: los bloques de IA no van a responder.</p>}
            </div>
          </aside>
        </div>
      </section>
    </div></PageShell>
  );
}

function MenuEditor({ node, departments, users, onData }: { node: BotFlowNode; departments: Department[]; users: OrgUser[]; onData: (id: string, key: string, value: unknown) => void }) {
  const options = menuOptionsOf(node);
  const [advanced, setAdvanced] = useState<number | null>(null);
  const [showErrorText, setShowErrorText] = useState(false);
  const save = (next: MenuOption[]) => onData(node.id, 'options', next);
  const patch = (index: number, change: Partial<MenuOption>) => save(options.map((option, i) => i === index ? { ...option, ...change } : option));
  const remove = (index: number) => save(options.filter((_, i) => i !== index));
  const nextKey = () => { const used = new Set(options.map((o) => o.key)); let n = options.length + 1; while (used.has(String(n))) n += 1; return String(n); };
  // Un solo destino por opción: un área o una persona. El valor viaja como "dep:<id>" o "user:<id>".
  const destinationValue = (option: MenuOption) => (option.userId ? `user:${option.userId}` : option.departmentId ? `dep:${option.departmentId}` : '');
  const setDestination = (index: number, value: string) => patch(index, {
    departmentId: value.startsWith('dep:') ? value.slice(4) : '',
    userId: value.startsWith('user:') ? value.slice(5) : ''
  });
  return <>
    <div className="bot-field">
      <label>Texto</label>
      <textarea className="input" rows={3} value={nodeDataString(node, 'text')} onChange={(event) => onData(node.id, 'text', event.target.value)} placeholder="Gracias por llegar hasta aquí. Si desea hablar con ventas, presione opción 1." />
      <small>Las opciones numeradas se agregan solas debajo de este texto.</small>
    </div>

    <div className="bot-field"><label>Opciones</label>
      {options.map((option, index) => <div className="bot-menu-option" key={index}>
        <div className="bot-menu-row">
          <input className="input bot-menu-key" value={option.key} onChange={(event) => patch(index, { key: event.target.value.slice(0, 6) })} aria-label={`Número de la opción ${index + 1}`} placeholder="1" />
          <input className="input" value={option.label} onChange={(event) => patch(index, { label: event.target.value })} aria-label={`Nombre de la opción ${index + 1}`} placeholder="Ventas" />
          <button type="button" className="bot-menu-option-remove" onClick={() => remove(index)} aria-label={`Quitar la opción ${option.key || index + 1}`} title="Quitar esta opción">×</button>
        </div>
        <select className="input bot-menu-destination" value={destinationValue(option)} onChange={(event) => setDestination(index, event.target.value)} aria-label={`Derivar la opción ${index + 1} a`}>
          <option value="">Derivar a: cola general (cualquier agente)</option>
          {departments.length > 0 && <optgroup label="Áreas">{departments.map((department) => <option key={department.id} value={`dep:${department.id}`}>Área: {department.name}</option>)}</optgroup>}
          <optgroup label="Personas">{users.filter((item) => item.active).map((item) => <option key={item.id} value={`user:${item.id}`}>Agente: {item.name}</option>)}</optgroup>
        </select>
        {advanced === index && <div className="bot-menu-advanced">
          <div className="bot-subfield">
            <label>Mensaje al elegir esta opción</label>
            <input className="input" value={option.message} onChange={(event) => patch(index, { message: event.target.value })} placeholder={`Te paso con ${option.label || 'el área'}. En un momento te atienden.`} />
            <small>Si lo dejás vacío, el bot avisa con este mismo texto.</small>
          </div>
          <div className="bot-subfield">
            <label>Palabras que también sirven</label>
            <input className="input" value={option.keywords.join(', ')} onChange={(event) => patch(index, { keywords: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} placeholder="ventas, comprar, precio" />
            <small>Además del número y del nombre de la opción.</small>
          </div>
        </div>}
        <button type="button" className="bot-menu-more" onClick={() => setAdvanced(advanced === index ? null : index)}>
          {advanced === index ? '− Ocultar ajustes' : '+ Ajustes de esta opción'}
        </button>
      </div>)}
      <button type="button" className="btn secondary small" onClick={() => save([...options, { key: nextKey(), label: '', keywords: [], departmentId: '', userId: '', message: '' }])}>＋ Agregar opción</button>
    </div>

    {showErrorText ? <div className="bot-field">
      <label>Si escribe algo que no es una opción</label>
      <input className="input" value={nodeDataString(node, 'invalidText')} onChange={(event) => onData(node.id, 'invalidText', event.target.value)} placeholder="No entendí tu respuesta. Elegí una opción:" />
    </div> : <button type="button" className="bot-menu-more" onClick={() => setShowErrorText(true)}>+ Ajustes generales (opcional)</button>}
  </>;
}

function PaletteButton({ type, onAdd }: { type: BotNodeType; onAdd: () => void }) {
  const def = NODE_DEFS[type];
  return <button type="button" draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', `palette:${type}`)} onClick={onAdd} className="bot-palette-button"><span style={{ color: def.color }}><Glyph c={def.icon} size={18} /></span>{def.label}<b><Glyph c="＋" size={14} /></b></button>;
}

function BotNodeCard({ node, selected, dragging, onSelect, onDuplicate, onRemove, onPointerDown, onPointerMove, onPointerUp, onConnectStart, onConnectEnd }: { node: BotFlowNode; selected: boolean; dragging: boolean; onDuplicate: () => void; onRemove: () => void; onSelect: () => void; onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void; onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void; onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void; onConnectStart: (event: React.PointerEvent<HTMLDivElement>) => void; onConnectEnd: (event: React.PointerEvent<HTMLDivElement>) => void }) {
  const def = NODE_DEFS[node.type];
  return <div className={`bot-node-card ${selected ? 'selected' : ''} ${dragging ? 'dragging' : ''}`} style={{ left: node.position.x, top: node.position.y, borderTopColor: def.color }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onClick={onSelect} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(); }}><div className="bot-node-title"><span style={{ background: `${def.color}22`, color: def.color }}><Glyph c={def.icon} size={18} /></span><strong>{node.title}</strong>{node.type === 'start' && <i className="bot-live-dot" />}</div>
    <div className="bot-node-actions" onPointerDown={(event) => event.stopPropagation()}>
      <button type="button" title="Editar este bloque" aria-label={`Editar ${node.title}`} onClick={(event) => { event.stopPropagation(); onSelect(); }}><Glyph c="✎" size={13} /></button>
      {!['start', 'end'].includes(node.type) && <button type="button" title="Duplicar este bloque" aria-label={`Duplicar ${node.title}`} onClick={(event) => { event.stopPropagation(); onDuplicate(); }}><Glyph c="⧉" size={13} /></button>}
      {!['start', 'end'].includes(node.type) && <button type="button" className="danger" title="Eliminar este bloque" aria-label={`Eliminar ${node.title}`} onClick={(event) => { event.stopPropagation(); onRemove(); }}><Glyph c="⌫" size={13} /></button>}
    </div><p>{flowNodeSummary(node)}</p><div className="bot-node-port right source" role="button" aria-label={`Conectar desde ${node.title}`} onPointerDown={onConnectStart} /><div className="bot-node-port left target" role="button" aria-label={`Conectar con ${node.title}`} onPointerUp={onConnectEnd} /></div>;
}

function NodeProperties({ node, flow, departments, users, onUpdate, onData, onConnect, onEdgeUpdate, onEdgeRemove }: { node: BotFlowNode; flow: BotFlow; departments: Department[]; users: OrgUser[]; onUpdate: (id: string, patch: Partial<BotFlowNode>) => void; onData: (id: string, key: string, value: unknown) => void; onConnect: (to: string) => void; onEdgeUpdate: (id: string, patch: Partial<BotFlowEdge>) => void; onEdgeRemove: (id: string) => void }) {
  const edges = flow.edges.filter((edge) => edge.from === node.id);
  const editable = !['start', 'end'].includes(node.type);
  return <div className="bot-properties-scroll"><div className="bot-field"><label>Nombre del bloque</label><input className="input" value={node.title} disabled={!editable} onChange={(event) => onUpdate(node.id, { title: event.target.value })} placeholder="Menú principal" /><small>Solo para vos: es el título que se ve en el bloque del lienzo.</small></div><div className="bot-field"><label>Descripción</label><input className="input" value={node.description} disabled={!editable} onChange={(event) => onUpdate(node.id, { description: event.target.value })} placeholder="Nota para acordarte de qué hace este bloque" /><small>Solo para vos, como recordatorio. El cliente no la ve.</small></div>{node.type === 'message' && <><div className="bot-field"><label>Texto del mensaje</label><textarea className="input" rows={5} value={nodeDataString(node, 'text')} onChange={(event) => onData(node.id, 'text', event.target.value)} placeholder="Hola {{nombre}}, ¿en qué podemos ayudarte?" /></div><label className="bot-check-row"><input type="checkbox" checked={nodeDataBoolean(node, 'onlyOnNew')} onChange={(event) => onData(node.id, 'onlyOnNew', event.target.checked)} /> Mostrar solo al iniciar la conversación</label></>}{node.type === 'keyword' && <><div className="bot-field"><label>Palabras clave</label><textarea className="input" rows={3} value={nodeDataArray(node, 'keywords').join(', ')} onChange={(event) => onData(node.id, 'keywords', event.target.value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean))} placeholder="precio, cotización, comprar" /><small>Separalas por coma o salto de línea.</small></div><div className="bot-field"><label>Respuesta cuando coincide</label><textarea className="input" rows={4} value={nodeDataString(node, 'response')} onChange={(event) => onData(node.id, 'response', event.target.value)} /></div><div className="bot-form-grid"><div className="bot-field"><label>Salida positiva</label><input className="input" value={nodeDataString(node, 'matchLabel') || 'Coincide'} onChange={(event) => onData(node.id, 'matchLabel', event.target.value)} /></div><div className="bot-field"><label>Salida alternativa</label><input className="input" value={nodeDataString(node, 'fallbackLabel') || 'No coincide'} onChange={(event) => onData(node.id, 'fallbackLabel', event.target.value)} /></div></div></>}{node.type === 'condition' && <div className="bot-field"><label>Condición</label><select className="input" value={nodeDataString(node, 'condition') || 'always'} onChange={(event) => onData(node.id, 'condition', event.target.value)}><option value="always">Siempre</option><option value="new_contact">Es contacto nuevo</option><option value="has_name">Tiene nombre guardado</option><option value="contains_text">El mensaje tiene contenido</option></select></div>}{node.type === 'ai' && <div className="bot-field"><label>Instrucciones para la IA</label><textarea className="input" rows={6} value={nodeDataString(node, 'prompt')} onChange={(event) => onData(node.id, 'prompt', event.target.value)} /></div>}{node.type === 'crm' && <><div className="bot-field"><label>Etapa CRM</label><select className="input" value={nodeDataString(node, 'stage')} onChange={(event) => onData(node.id, 'stage', event.target.value)}>{CRM_STAGES.map((stage) => <option key={stage} value={stage}>{stage[0].toUpperCase() + stage.slice(1)}</option>)}</select></div><div className="bot-field"><label>Etiquetas adicionales</label><input className="input" value={nodeDataArray(node, 'tags').join(', ')} onChange={(event) => onData(node.id, 'tags', event.target.value.split(',').map((item) => item.trim()).filter(Boolean))} placeholder="Bot, seguimiento" /></div></>}{node.type === 'menu' && <MenuEditor node={node} departments={departments} users={users} onData={onData} />}{node.type === 'agent' && <><div className="bot-field"><label>Mensaje al cliente al derivar</label><textarea className="input" rows={3} value={nodeDataString(node, 'message')} onChange={(event) => onData(node.id, 'message', event.target.value)} placeholder="Te paso con Ventas. En un momento te atienden." /><small>Desde acá el bot deja de responder y el chat queda para tu equipo. Si no elegís departamento ni agente, el chat solo se marca como derivado.</small></div><div className="bot-field"><label>Departamento</label><select className="input" value={nodeDataString(node, 'departmentId')} onChange={(event) => onData(node.id, 'departmentId', event.target.value)}><option value="">Seleccionar departamento</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></div><div className="bot-field"><label>Agente específico (opcional)</label><select className="input" value={nodeDataString(node, 'userId')} onChange={(event) => onData(node.id, 'userId', event.target.value)}><option value="">Cualquier agente disponible</option>{users.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div></>}{node.type !== 'end' && <div className="bot-connections"><div className="bot-field"><label>Conexiones de salida</label>{edges.map((edge) => <div className="bot-edge-row" key={edge.id}><input className="input" value={edge.label} onChange={(event) => onEdgeUpdate(edge.id, { label: event.target.value })} placeholder="Salida" /><select className="input" value={edge.to} onChange={(event) => onEdgeUpdate(edge.id, { to: event.target.value })}><option value="">Elegir nodo</option>{flow.nodes.filter((target) => target.id !== node.id).map((target) => <option key={target.id} value={target.id}>{target.title}</option>)}</select><button type="button" onClick={() => onEdgeRemove(edge.id)} aria-label="Quitar conexión">×</button></div>)}<select className="input" value="" onChange={(event) => onConnect(event.target.value)}><option value="">＋ Conectar con otro nodo</option>{flow.nodes.filter((target) => target.id !== node.id && !edges.some((edge) => edge.to === target.id)).map((target) => <option key={target.id} value={target.id}>{target.title}</option>)}</select></div></div>}</div>;
}

function BotSettings({ flow, aiStatus, canManage, onUpdate, onSave, saving }: { flow: BotFlow; aiStatus: AiStatus | null; canManage: boolean; onUpdate: (patch: Partial<BotFlow>) => void; onSave: () => void; saving: boolean }) {
  return <section className="bot-settings-layout"><div className="bot-settings-main"><div className="bot-settings-card"><span className="bot-panel-kicker">CONFIGURACIÓN DEL FLUJO</span><h2>Controlá cuándo responde Niro</h2><p>El flujo publicado atiende conversaciones nuevas y aplica las acciones que definiste. Un agente humano siempre toma prioridad.</p><label className="bot-setting-toggle"><input type="checkbox" checked={flow.enabled} disabled={!canManage} onChange={(event) => onUpdate({ enabled: event.target.checked })} /><span><b>Flujo habilitado</b><small>Permite que este recorrido procese mensajes entrantes.</small></span></label><label className="bot-setting-toggle"><input type="checkbox" checked={flow.published} disabled={!canManage} onChange={(event) => onUpdate({ published: event.target.checked })} /><span><b>Versión publicada</b><small>Solo los cambios publicados se aplican en WhatsApp y el widget.</small></span></label></div><div className="bot-settings-card"><span className="bot-panel-kicker">INTELIGENCIA ARTIFICIAL</span><h2>Conectá Niro IA al flujo</h2><p>{aiStatus?.configured ? 'La API de Niro IA está configurada y lista para usar nodos de respuesta inteligente.' : 'La API de Niro IA todavía no está configurada en el servidor.'}</p><div className={`bot-integration-state ${aiStatus?.configured ? 'ready' : ''}`}><i />{aiStatus?.configured ? 'API disponible' : 'Falta configurar NIRO_AI_API_KEY'}<span>Se usa solo en los bloques “Asistente IA” del flujo</span></div></div><button type="button" className="btn" onClick={onSave} disabled={!canManage || saving}>{saving ? 'Guardando…' : 'Guardar configuración'}</button></div><aside className="bot-settings-aside"><div className="bot-settings-illustration"><Glyph c="✦" size={28} /><strong>Niro Flow</strong><small>Automatiza. Entiende. Deriva.</small></div><h3>Buenas prácticas</h3><ul><li>Usá palabras clave específicas y respuestas cortas.</li><li>Derivá a una persona cuando el cliente lo solicite.</li><li>Marcá la etapa CRM en cada camino importante.</li><li>Probá el flujo antes de publicarlo.</li></ul></aside></section>;
}

function BotStats({ flow, metrics }: { flow: BotFlow; metrics: { nodes: number; keywords: number; actions: number; ai: number; connections: number } }) {
  return <section className="bot-stats-layout"><div className="bot-stats-grid"><div><span>ESTADO</span><strong>{flow.enabled && flow.published ? 'Activo' : 'Borrador'}</strong><small>{flow.enabled && flow.published ? 'Procesando mensajes' : 'No afecta conversaciones'}</small></div><div><span>NODOS</span><strong>{metrics.nodes}</strong><small>{metrics.connections} conexiones configuradas</small></div><div><span>AUTOMATIZACIÓN</span><strong>{metrics.keywords + metrics.actions}</strong><small>Reglas y acciones manuales</small></div><div><span>IA</span><strong>{metrics.ai}</strong><small>Bloques inteligentes</small></div></div><div className="bot-stats-empty"><span><Glyph c="▥" size={26} /></span><h2>Métricas de ejecución</h2><p>Cuando publiques y recibas conversaciones, acá vas a ver respuestas del bot, derivaciones a agentes, etapas CRM y caminos más utilizados.</p></div></section>;
}
