export type UserRole = 'SUPERADMIN' | 'OWNER' | 'ADMIN' | 'SUPERVISOR' | 'AGENT';

export const ORG_ROLES: UserRole[] = ['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT'];

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  organizationId: string | null;
  mustChangePassword: boolean;
  organization: { id: string; name: string; slug: string } | null;
}

export interface OrgUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  mustChangePassword: boolean;
  createdAt: string;
}

export interface Department {
  id: string;
  name: string;
  description: string | null;
  members: { id: string; name: string; email: string }[];
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  planTier: string;
  maxUsers: number;
  createdAt: string;
  userCount?: number;
  settings: { welcomeMessage: string; aiEnabled: boolean } | null;
}

export interface MenuOption {
  key: string;
  label: string;
  departmentId: string;
}

export interface OrgSettings {
  welcomeMessage: string;
  systemPrompt: string;
  aiEnabled: boolean;
  menuOptions: MenuOption[];
}

export interface OwnOrganization {
  id: string;
  name: string;
  slug: string;
  planTier: string;
  maxUsers: number;
  userCount: number;
  settings: OrgSettings | null;
}

export type ConversationStatus = 'OPEN' | 'PENDING' | 'RESOLVED' | 'CLOSED';
export type ConversationPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type MessageDirection = 'INBOUND' | 'OUTBOUND' | 'NOTE';

export const CONVERSATION_STATUSES: ConversationStatus[] = ['OPEN', 'PENDING', 'RESOLVED', 'CLOSED'];
export const CONVERSATION_PRIORITIES: ConversationPriority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

export interface Contact {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  externalId?: string | null;
  avatarUrl?: string | null;
  tags: string[];
  createdAt?: string;
}

export interface Conversation {
  id: string;
  subject: string | null;
  status: ConversationStatus;
  priority: ConversationPriority;
  channel: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  contact: Contact;
  department: { id: string; name: string } | null;
  assignedTo: { id: string; name: string; email: string } | null;
}

export interface MessageAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface MessageReaction {
  emoji: string;
  from: 'agent' | 'customer';
  at: string;
}

export interface Message {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  content: string;
  contentType: string;
  deliveryStatus: string;
  waMessageId: string | null;
  quotedMessageId: string | null;
  quotedPreview: string | null;
  quotedSender: string | null;
  reactions: MessageReaction[];
  createdAt: string;
  sender: { id: string; name: string } | null;
  attachment: MessageAttachment | null;
  transcription: string | null;
}

export type OrderStatus = 'RECEIVED' | 'CONFIRMED' | 'PREPARING' | 'DISPATCHED' | 'DELIVERED' | 'CANCELLED';

export const ORDER_STATUSES: OrderStatus[] = ['RECEIVED', 'CONFIRMED', 'PREPARING', 'DISPATCHED', 'DELIVERED', 'CANCELLED'];

export interface OrderItem {
  id?: string;
  name: string;
  quantity: number;
  unitPrice: number | null;
}

export interface Order {
  id: string;
  status: OrderStatus;
  notes: string | null;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
  contact: Contact;
  assignedTo: { id: string; name: string; email: string } | null;
  items: OrderItem[];
  total: number;
}

export type AgentPresenceStatus = 'available' | 'busy' | 'away' | 'offline';

export interface AgentPresence {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  status: AgentPresenceStatus;
  online: boolean;
  lastSeen?: string;
}

export interface DashboardStats {
  kpis: {
    messages: {
      total: number;
      today: number;
      inbound: number;
      outbound: number;
      notes: number;
      bot: number;
      responseRate: number;
      avgFirstResponseMinutes: number;
    };
    conversations: {
      total: number;
      open: number;
      pending: number;
      resolved: number;
      closed: number;
      unassigned: number;
      activeClients: number;
      pendingClients: number;
      followingClients: number;
      resolvedClients: number;
    };
    orders: {
      total: number;
      received: number;
      confirmed: number;
      preparing: number;
      dispatched: number;
      delivered: number;
      cancelled: number;
      pending: number;
      revenueTotal: number;
      revenueToday: number;
    };
    bot: {
      active: boolean;
      welcomeMessage: string;
      systemPrompt: string;
      menuCount: number;
    };
    agents: {
      total: number;
      onlineCount: number;
      availableCount: number;
      busyCount: number;
      awayCount: number;
      offlineCount: number;
      list: {
        id: string;
        name: string;
        email: string;
        role: UserRole;
        online: boolean;
        status: AgentPresenceStatus;
      }[];
    };
  };
  recentUnassigned: {
    id: string;
    subject: string | null;
    channel: string;
    status: ConversationStatus;
    priority: ConversationPriority;
    updatedAt: string;
    contact: Contact;
    department: { id: string; name: string } | null;
    lastMessage: string | null;
  }[];
  dailyActivity: {
    date: string;
    dayName: string;
    inbound: number;
    outbound: number;
    total: number;
  }[];
  departments: {
    id: string;
    name: string;
    description: string | null;
    conversationsCount: number;
    membersCount: number;
  }[];
  channels: {
    channel: string;
    count: number;
  }[];
}

export type CampaignStatus = 'DRAFT' | 'SCHEDULED' | 'SENDING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
export type CampaignRecipientStatus = 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

export interface CampaignCounts {
  total: number;
  pending: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  replies: number;
}

export type CampaignSpeedProfile = 'CONSERVATIVE' | 'BALANCED' | 'PERFORMANCE' | 'HIGH_PERFORMANCE';
export type CampaignType = 'DIRECT' | 'SCHEDULED';

export interface Campaign {
  id: string;
  name: string;
  message: string;
  attachment: MessageAttachment | null;
  tagFilter: string[];
  sendLine: string | null;
  campaignType: CampaignType;
  speedProfile: CampaignSpeedProfile;
  messagesPerHour: number;
  ratePerMinute: number;
  status: CampaignStatus;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  counts: CampaignCounts | null;
}

export interface CampaignRecipientInfo {
  id: string;
  status: CampaignRecipientStatus;
  errorMessage: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  waMessageId: string | null;
  contact: { id: string; name: string | null; phone: string | null; avatarUrl: string | null };
}

export interface WhatsAppSession {
  id: string;
  label: string;
  phone: string | null;
  status: 'disconnected' | 'connecting' | 'qr' | 'connected';
  hasQr: boolean;
}

export type AiAgentCategory = 'CHAT' | 'CODING' | 'RESEARCH';

export interface AiAgent {
  id: string;
  name: string;
  category: AiAgentCategory;
  description?: string | null;
  createdAt?: string;
}

export interface AiStatus {
  configured: boolean;
  aiEnabled: boolean;
  systemPrompt: string;
  defaultPersona: string;
}

export interface AiChatTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}
