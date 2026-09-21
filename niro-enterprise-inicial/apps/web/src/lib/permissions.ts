import type { CurrentUser } from '../types';

export type PermissionKey =
  | 'campaigns' | 'statuses' | 'calls' | 'contacts' | 'contactsExport' | 'contactsDelete'
  | 'crm' | 'orders' | 'quickReplies' | 'transferChats' | 'reports' | 'management' | 'sms' | 'bot' | 'aiAgents' | 'developers';

export interface PermissionDef { key: PermissionKey; group: string; label: string; description: string }

/** Propietario, administrador y superadmin siempre pueden todo; el resto depende de lo que su admin habilitó (por defecto: todo). */
export function can(user: CurrentUser | null | undefined, key: PermissionKey): boolean {
  if (!user) return false;
  if (['SUPERADMIN', 'OWNER', 'ADMIN'].includes(user.role)) return true;
  return user.permissions?.[key] !== false;
}

export const isAdminRole = (user: CurrentUser | null | undefined) => Boolean(user && ['OWNER', 'ADMIN'].includes(user.role));
