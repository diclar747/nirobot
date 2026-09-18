import type { Conversation, ConversationStatus } from '../types';

export type CrmStage = 'abiertas' | 'pendientes' | 'clientes' | 'interesados' | 'cerradas';

export const CRM_STAGES: { key: CrmStage; label: string; tag: string; color: string }[] = [
  { key: 'abiertas', label: 'Abiertas', tag: 'Abiertas', color: '#0284c7' },
  { key: 'pendientes', label: 'Pendientes', tag: 'Pendientes', color: '#f59e0b' },
  { key: 'clientes', label: 'Clientes', tag: 'Clientes', color: '#10b981' },
  { key: 'interesados', label: 'Interesados', tag: 'Interesados', color: '#8b5cf6' },
  { key: 'cerradas', label: 'Cerradas', tag: 'Cerradas', color: '#64748b' }
];

const STAGE_TAGS = CRM_STAGES.map((s) => s.tag);

// A conversation's CRM stage is stored as one of a fixed set of tags in Conversation.tags
// (agent-assignable, independent of the support-ticket `status` field). Falls back to a
// status-derived stage for conversations nobody has tagged yet, so the board is never empty.
export function deriveStage(conversation: Conversation): CrmStage {
  const stageTag = conversation.tags.find((t) => STAGE_TAGS.includes(t));
  if (stageTag) return CRM_STAGES.find((s) => s.tag === stageTag)!.key;
  if (conversation.status === 'PENDING') return 'pendientes';
  if (conversation.status === 'RESOLVED' || conversation.status === 'CLOSED') return 'cerradas';
  return 'abiertas';
}

export function tagsForStage(currentTags: string[], stage: CrmStage): string[] {
  const stageTag = CRM_STAGES.find((s) => s.key === stage)!.tag;
  const withoutStage = currentTags.filter((t) => !STAGE_TAGS.includes(t));
  return [...withoutStage, stageTag];
}

// abiertas/pendientes/cerradas mirror the conversation's lifecycle status too, so status-based
// filters elsewhere in the app (Inbox, reports) stay consistent with the board. clientes/interesados
// are pure CRM classification with no status equivalent.
export function statusForStage(stage: CrmStage): ConversationStatus | null {
  if (stage === 'abiertas') return 'OPEN';
  if (stage === 'pendientes') return 'PENDING';
  if (stage === 'cerradas') return 'CLOSED';
  return null;
}
