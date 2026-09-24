// Capa de persistencia PostgreSQL para Niro.
// Cada colección del store se guarda completa en `data` (jsonb) para que la
// ida y vuelta sea exacta, y además en columnas tipadas para consultas SQL.
import pg from "pg";

const { Pool } = pg;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_meta (
  key text PRIMARY KEY,
  value jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fb_profile (
  id text PRIMARY KEY,
  name text,
  url text,
  avatar_url text,
  synced_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fb_groups (
  id text PRIMARY KEY,
  name text,
  url text,
  synced_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fb_pages (
  id text PRIMARY KEY,
  name text,
  url text,
  synced_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chats (
  id text PRIMARY KEY,
  name text,
  preview text,
  url text,
  kind text,
  unread_count int,
  message_count int,
  last_message text,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  synced_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id text PRIMARY KEY,
  chat_id text,
  sender text,
  text text,
  sent_label text,
  url text,
  first_seen_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_chat_idx ON chat_messages (chat_id);
CREATE TABLE IF NOT EXISTS events (
  id text PRIMARY KEY,
  key text,
  source text,
  kind text,
  external_id text,
  text text,
  url text,
  read boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_source_idx ON events (source, first_seen_at DESC);
CREATE TABLE IF NOT EXISTS drafts (
  id text PRIMARY KEY,
  event_id text,
  body text,
  status text,
  created_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS schedules (
  id text PRIMARY KEY,
  destination text,
  text text,
  status text,
  auto_publish boolean,
  next_run_at timestamptz,
  completed_count int,
  failed_count int,
  created_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS schedule_jobs (
  id text PRIMARY KEY,
  schedule_id text REFERENCES schedules(id) ON DELETE CASCADE,
  target_type text,
  target_id text,
  target_name text,
  text text,
  run_at timestamptz,
  status text,
  attempts int,
  published_at timestamptz,
  last_error text,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS schedule_jobs_due_idx ON schedule_jobs (status, run_at);
CREATE TABLE IF NOT EXISTS media (
  id text PRIMARY KEY,
  path text,
  name text,
  mime_type text,
  size bigint,
  created_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS publications (
  id text PRIMARY KEY,
  target_type text,
  target_id text,
  target_name text,
  text text,
  status text,
  origin text,
  schedule_id text,
  job_id text,
  url text,
  error text,
  created_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS publications_created_idx ON publications (created_at DESC);
CREATE TABLE IF NOT EXISTS fb_posts (
  id text PRIMARY KEY,
  owner_type text,
  owner_id text,
  owner_name text,
  url text,
  text text,
  posted_label text,
  observed_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fb_posts_owner_idx ON fb_posts (owner_type, owner_id);
CREATE TABLE IF NOT EXISTS social_interactions (
  id text PRIMARY KEY,
  channel text,
  status text,
  category text,
  person_name text,
  account_name text,
  text text,
  final_reply text,
  thread_key text,
  created_at timestamptz,
  sent_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS social_interactions_status_idx ON social_interactions (status, created_at DESC);
CREATE TABLE IF NOT EXISTS ai_reply_prompts (
  id text PRIMARY KEY,
  scope text,
  scope_id text,
  scope_name text,
  version int,
  mode text,
  changed_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS crm_leads (
  id text PRIMARY KEY,
  name text,
  phone text,
  email text,
  interest text,
  channel text,
  created_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_reply_audit (
  id text PRIMARY KEY,
  interaction_id text,
  action text,
  actor text,
  details text,
  at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_reply_audit_interaction_idx ON ai_reply_audit (interaction_id);
CREATE TABLE IF NOT EXISTS social_accounts (
  id text PRIMARY KEY,
  platform text,
  page_id text,
  page_name text,
  username text,
  status text,
  checked_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS group_segments (
  id text PRIMARY KEY,
  name text,
  keywords text[],
  last_search_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS discovered_groups (
  id text PRIMARY KEY,
  name text,
  url text,
  privacy text,
  members text,
  status text,
  segment_ids text[],
  description text,
  rules text,
  requested_at timestamptz,
  member_since timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS discovered_groups_status_idx ON discovered_groups (status);
CREATE TABLE IF NOT EXISTS group_join_tasks (
  id text PRIMARY KEY,
  group_id text,
  group_name text,
  account text,
  run_at timestamptz,
  status text,
  attempts int,
  last_attempt_at timestamptz,
  note text,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS group_join_tasks_run_idx ON group_join_tasks (status, run_at);
CREATE OR REPLACE VIEW group_memberships AS
  SELECT id AS group_id, name, url, status, requested_at, member_since,
         (data->>'membershipCheckedAt')::timestamptz AS checked_at, data->>'lastNote' AS note
  FROM discovered_groups
  WHERE status IN ('requested', 'member', 'rejected', 'attention');
CREATE TABLE IF NOT EXISTS crm_boards (
  id text PRIMARY KEY,
  name text,
  archived boolean,
  created_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS crm_stages (
  id text PRIMARY KEY,
  board_id text,
  pipeline_id text,
  name text,
  kind text,
  sort_order int,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_stages_board_idx ON crm_stages (board_id, pipeline_id, sort_order);
CREATE TABLE IF NOT EXISTS crm_contacts (
  id text PRIMARY KEY,
  name text,
  phone text,
  email text,
  created_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_contacts_phone_idx ON crm_contacts (phone);
CREATE TABLE IF NOT EXISTS crm_contact_identities (
  id text PRIMARY KEY,
  contact_id text,
  channel text,
  external_id text,
  display_name text,
  last_inbound_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_contact_identities_contact_idx ON crm_contact_identities (contact_id);
CREATE TABLE IF NOT EXISTS crm_opportunities (
  id text PRIMARY KEY,
  board_id text,
  pipeline_id text,
  stage_id text,
  contact_id text,
  title text,
  value numeric,
  status text,
  agent text,
  source_channel text,
  publication_id text,
  created_at timestamptz,
  stage_changed_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_opportunities_board_idx ON crm_opportunities (board_id, stage_id);
CREATE INDEX IF NOT EXISTS crm_opportunities_contact_idx ON crm_opportunities (contact_id);
CREATE TABLE IF NOT EXISTS crm_activities (
  id text PRIMARY KEY,
  opportunity_id text,
  contact_id text,
  type text,
  channel text,
  text text,
  external_id text,
  actor text,
  at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_activities_opportunity_idx ON crm_activities (opportunity_id, at DESC);
CREATE INDEX IF NOT EXISTS crm_activities_external_idx ON crm_activities (external_id);
CREATE TABLE IF NOT EXISTS crm_tasks (
  id text PRIMARY KEY,
  opportunity_id text,
  contact_id text,
  title text,
  due_at timestamptz,
  agent text,
  status text,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_tasks_due_idx ON crm_tasks (status, due_at);
CREATE TABLE IF NOT EXISTS crm_stage_history (
  id text PRIMARY KEY,
  opportunity_id text,
  board_id text,
  from_stage_id text,
  to_stage_id text,
  actor text,
  reason text,
  at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_stage_history_opportunity_idx ON crm_stage_history (opportunity_id, at DESC);
CREATE TABLE IF NOT EXISTS campaign_sources (
  id text PRIMARY KEY,
  kind text,
  network text,
  publication_id text,
  campaign text,
  board_id text,
  created_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS crm_campaigns (
  id text PRIMARY KEY,
  name text,
  channel text,
  total int,
  available int,
  created_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id text PRIMARY KEY,
  campaign_id text,
  contact_id text,
  opportunity_id text,
  channel text,
  status text,
  reason text,
  created_at timestamptz,
  data jsonb NOT NULL,
  position int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaign_recipients_campaign_idx ON campaign_recipients (campaign_id);
`;

const ts = (value) => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

// append: la colección nunca borra elementos en memoria, así que no hace falta
// sincronizar eliminaciones (evita un DELETE ... NOT IN con miles de ids).
const COLLECTIONS = {
  groups: {
    table: "fb_groups",
    columns: { name: "text", url: "text", synced_at: "timestamptz" },
    row: (item) => ({ name: item.name, url: item.url, synced_at: ts(item.syncedAt) }),
  },
  pages: {
    table: "fb_pages",
    columns: { name: "text", url: "text", synced_at: "timestamptz" },
    row: (item) => ({ name: item.name, url: item.url, synced_at: ts(item.syncedAt) }),
  },
  chats: {
    table: "chats",
    append: true,
    columns: {
      name: "text", preview: "text", url: "text", kind: "text", unread_count: "int", message_count: "int",
      last_message: "text", first_seen_at: "timestamptz", last_seen_at: "timestamptz", synced_at: "timestamptz",
    },
    row: (item) => ({
      name: item.name, preview: item.preview, url: item.url, kind: item.kind,
      unread_count: Number(item.unreadCount) || 0, message_count: Number(item.messageCount) || 0,
      last_message: item.lastMessage || null, first_seen_at: ts(item.firstSeenAt), last_seen_at: ts(item.lastSeenAt), synced_at: ts(item.syncedAt),
    }),
  },
  messages: {
    table: "chat_messages",
    append: true,
    columns: { chat_id: "text", sender: "text", text: "text", sent_label: "text", url: "text", first_seen_at: "timestamptz" },
    row: (item) => ({ chat_id: item.chatId, sender: item.sender, text: item.text, sent_label: item.timestamp, url: item.url, first_seen_at: ts(item.firstSeenAt) }),
  },
  events: {
    table: "events",
    append: true,
    columns: {
      key: "text", source: "text", kind: "text", external_id: "text", text: "text", url: "text", read: "boolean",
      first_seen_at: "timestamptz", last_seen_at: "timestamptz",
    },
    row: (item) => ({
      key: item.key, source: item.source, kind: item.kind || null, external_id: item.externalId, text: item.text, url: item.url,
      read: item.read === true, first_seen_at: ts(item.firstSeenAt), last_seen_at: ts(item.lastSeenAt),
    }),
  },
  drafts: {
    table: "drafts",
    append: true,
    columns: { event_id: "text", body: "text", status: "text", created_at: "timestamptz" },
    row: (item) => ({ event_id: item.eventId, body: item.body, status: item.status, created_at: ts(item.createdAt) }),
  },
  schedules: {
    table: "schedules",
    columns: {
      destination: "text", text: "text", status: "text", auto_publish: "boolean", next_run_at: "timestamptz",
      completed_count: "int", failed_count: "int", created_at: "timestamptz",
    },
    row: (item) => ({
      destination: item.destination, text: item.text, status: item.status, auto_publish: item.autoPublish === true,
      next_run_at: ts(item.nextRunAt), completed_count: Number(item.completedCount) || 0, failed_count: Number(item.failedCount) || 0,
      created_at: ts(item.createdAt),
    }),
  },
  media: {
    table: "media",
    columns: { path: "text", name: "text", mime_type: "text", size: "bigint", created_at: "timestamptz" },
    row: (item) => ({ path: item.path, name: item.name, mime_type: item.mimeType, size: Number(item.size) || 0, created_at: ts(item.createdAt) }),
  },
  publications: {
    table: "publications",
    columns: {
      target_type: "text", target_id: "text", target_name: "text", text: "text", status: "text", origin: "text",
      schedule_id: "text", job_id: "text", url: "text", error: "text", created_at: "timestamptz",
    },
    row: (item) => ({
      target_type: item.target?.type, target_id: item.target?.id, target_name: item.target?.name, text: item.text, status: item.status,
      origin: item.origin, schedule_id: item.scheduleId || null, job_id: item.jobId || null, url: item.url || null, error: item.error || null,
      created_at: ts(item.createdAt),
    }),
  },
  aiInteractions: {
    table: "social_interactions",
    columns: {
      channel: "text", status: "text", category: "text", person_name: "text", account_name: "text", text: "text",
      final_reply: "text", thread_key: "text", created_at: "timestamptz", sent_at: "timestamptz",
    },
    row: (item) => ({
      channel: item.channel, status: item.status, category: item.category, person_name: item.person?.name || null, account_name: item.account?.name || null,
      text: item.text || item.notificationText, final_reply: item.sentText || item.finalReply || null, thread_key: item.threadKey, created_at: ts(item.createdAt), sent_at: ts(item.sentAt),
    }),
  },
  groupSegments: {
    table: "group_segments",
    columns: { name: "text", keywords: "text[]", last_search_at: "timestamptz" },
    row: (item) => ({ name: item.name, keywords: item.keywords || [], last_search_at: ts(item.lastSearchAt) }),
  },
  discoveredGroups: {
    table: "discovered_groups",
    columns: { name: "text", url: "text", privacy: "text", members: "text", status: "text", segment_ids: "text[]", description: "text", rules: "text", requested_at: "timestamptz", member_since: "timestamptz" },
    row: (item) => ({ name: item.name, url: item.url, privacy: item.privacy || null, members: item.members || null, status: item.status, segment_ids: item.segmentIds || [], description: item.description || null, rules: item.rules || null, requested_at: ts(item.requestedAt), member_since: ts(item.memberSince) }),
  },
  groupJoinTasks: {
    table: "group_join_tasks",
    columns: { group_id: "text", group_name: "text", account: "text", run_at: "timestamptz", status: "text", attempts: "int", last_attempt_at: "timestamptz", note: "text" },
    row: (item) => ({ group_id: item.groupId, group_name: item.groupName, account: item.account, run_at: ts(item.runAt), status: item.status, attempts: item.attempts || 0, last_attempt_at: ts(item.lastAttemptAt), note: item.note || null }),
  },
  socialAccounts: {
    table: "social_accounts",
    columns: { platform: "text", page_id: "text", page_name: "text", username: "text", status: "text", checked_at: "timestamptz" },
    row: (item) => ({ platform: item.platform, page_id: item.pageId, page_name: item.pageName, username: item.username, status: item.status, checked_at: ts(item.checkedAt) }),
  },
  aiPrompts: {
    table: "ai_reply_prompts",
    columns: { scope: "text", scope_id: "text", scope_name: "text", version: "int", mode: "text", changed_at: "timestamptz" },
    row: (item) => ({ scope: item.scope, scope_id: item.scopeId, scope_name: item.scopeName, version: item.version, mode: item.mode, changed_at: ts(item.updatedAt) }),
  },
  leads: {
    table: "crm_leads",
    columns: { name: "text", phone: "text", email: "text", interest: "text", channel: "text", created_at: "timestamptz" },
    row: (item) => ({ name: item.name, phone: item.phone, email: item.email, interest: item.interest, channel: item.channel, created_at: ts(item.createdAt) }),
  },
  aiAudit: {
    table: "ai_reply_audit",
    append: true,
    columns: { interaction_id: "text", action: "text", actor: "text", details: "text", at: "timestamptz" },
    row: (item) => ({ interaction_id: item.interactionId, action: item.action, actor: item.actor, details: item.details, at: ts(item.at) }),
  },
  crmBoards: {
    table: "crm_boards",
    columns: { name: "text", archived: "boolean", created_at: "timestamptz" },
    row: (item) => ({ name: item.name, archived: item.archived === true, created_at: ts(item.createdAt) }),
  },
  crmStages: {
    table: "crm_stages",
    columns: { board_id: "text", pipeline_id: "text", name: "text", kind: "text", sort_order: "int" },
    row: (item) => ({ board_id: item.boardId, pipeline_id: item.pipelineId, name: item.name, kind: item.kind, sort_order: Number(item.position) || 0 }),
  },
  crmContacts: {
    table: "crm_contacts",
    columns: { name: "text", phone: "text", email: "text", created_at: "timestamptz" },
    row: (item) => ({ name: item.name, phone: item.phone || null, email: item.email || null, created_at: ts(item.createdAt) }),
  },
  crmIdentities: {
    table: "crm_contact_identities",
    columns: { contact_id: "text", channel: "text", external_id: "text", display_name: "text", last_inbound_at: "timestamptz" },
    row: (item) => ({ contact_id: item.contactId, channel: item.channel, external_id: item.externalId, display_name: item.displayName || null, last_inbound_at: ts(item.lastInboundAt) }),
  },
  crmOpportunities: {
    table: "crm_opportunities",
    columns: {
      board_id: "text", pipeline_id: "text", stage_id: "text", contact_id: "text", title: "text", value: "numeric", status: "text", agent: "text",
      source_channel: "text", publication_id: "text", created_at: "timestamptz", stage_changed_at: "timestamptz",
    },
    row: (item) => ({
      board_id: item.boardId, pipeline_id: item.pipelineId, stage_id: item.stageId, contact_id: item.contactId, title: item.title,
      value: Number.isFinite(Number(item.value)) && item.value !== null ? Number(item.value) : null, status: item.status, agent: item.agent || null,
      source_channel: item.source?.channel || null, publication_id: item.source?.publicationId || null, created_at: ts(item.createdAt), stage_changed_at: ts(item.stageChangedAt),
    }),
  },
  // Actividades e historial se sincronizan con borrados: eliminar un contacto
  // (por ejemplo, si pide que se borren sus datos) tiene que borrarlo todo.
  crmActivities: {
    table: "crm_activities",
    columns: { opportunity_id: "text", contact_id: "text", type: "text", channel: "text", text: "text", external_id: "text", actor: "text", at: "timestamptz" },
    row: (item) => ({ opportunity_id: item.opportunityId, contact_id: item.contactId, type: item.type, channel: item.channel || null, text: item.text || null, external_id: item.externalId || null, actor: item.actor || null, at: ts(item.at) }),
  },
  crmTasks: {
    table: "crm_tasks",
    columns: { opportunity_id: "text", contact_id: "text", title: "text", due_at: "timestamptz", agent: "text", status: "text" },
    row: (item) => ({ opportunity_id: item.opportunityId, contact_id: item.contactId, title: item.title, due_at: ts(item.dueAt), agent: item.agent || null, status: item.status }),
  },
  crmStageHistory: {
    table: "crm_stage_history",
    columns: { opportunity_id: "text", board_id: "text", from_stage_id: "text", to_stage_id: "text", actor: "text", reason: "text", at: "timestamptz" },
    row: (item) => ({ opportunity_id: item.opportunityId, board_id: item.boardId, from_stage_id: item.fromStageId, to_stage_id: item.toStageId, actor: item.actor, reason: item.reason || null, at: ts(item.at) }),
  },
  campaignSources: {
    table: "campaign_sources",
    columns: { kind: "text", network: "text", publication_id: "text", campaign: "text", board_id: "text", created_at: "timestamptz" },
    row: (item) => ({ kind: item.kind, network: item.network || null, publication_id: item.publicationId || null, campaign: item.campaign || null, board_id: item.boardId || null, created_at: ts(item.createdAt) }),
  },
  crmCampaigns: {
    table: "crm_campaigns",
    columns: { name: "text", channel: "text", total: "int", available: "int", created_at: "timestamptz" },
    row: (item) => ({ name: item.name, channel: item.channel, total: item.total || 0, available: item.available || 0, created_at: ts(item.createdAt) }),
  },
  campaignRecipients: {
    table: "campaign_recipients",
    columns: { campaign_id: "text", contact_id: "text", opportunity_id: "text", channel: "text", status: "text", reason: "text", created_at: "timestamptz" },
    row: (item) => ({ campaign_id: item.campaignId, contact_id: item.contactId, opportunity_id: item.opportunityId || null, channel: item.channel, status: item.status, reason: item.reason || null, created_at: ts(item.createdAt) }),
  },
  posts: {
    table: "fb_posts",
    // Se pueden eliminar desde el panel: se sincronizan también los borrados.
    columns: {
      owner_type: "text", owner_id: "text", owner_name: "text", url: "text", text: "text", posted_label: "text", observed_at: "timestamptz",
    },
    row: (item) => ({
      owner_type: item.ownerType, owner_id: item.ownerId, owner_name: item.ownerName, url: item.url, text: item.text,
      posted_label: item.postedLabel || null, observed_at: ts(item.observedAt),
    }),
  },
};

const CHUNK = 1_000;

export class PgStore {
  constructor(connectionString) {
    this.pool = new Pool({ connectionString, max: 5 });
    this.snapshots = new Map();
    this.queue = Promise.resolve();
    this.lastError = null;
    this.lastSavedAt = null;
  }

  async init() {
    await this.pool.query(SCHEMA);
  }

  async isEmpty() {
    const { rows } = await this.pool.query(
      "SELECT (SELECT count(*) FROM app_meta) + (SELECT count(*) FROM events) + (SELECT count(*) FROM fb_groups) + (SELECT count(*) FROM chats) AS total"
    );
    return Number(rows[0].total) === 0;
  }

  async load() {
    const result = {};
    for (const [name, spec] of Object.entries(COLLECTIONS)) {
      const { rows } = await this.pool.query(`SELECT data FROM ${spec.table} ORDER BY position, id`);
      result[name] = rows.map((row) => row.data);
      this.snapshots.set(name, JSON.stringify(result[name]));
    }
    const { rows: profileRows } = await this.pool.query("SELECT data FROM fb_profile ORDER BY position LIMIT 1");
    result.profile = profileRows[0]?.data || null;
    this.snapshots.set("profile", JSON.stringify(result.profile));
    const { rows: metaRows } = await this.pool.query("SELECT value FROM app_meta WHERE key = 'meta'");
    result.meta = metaRows[0]?.value || {};
    this.snapshots.set("meta", JSON.stringify(result.meta));
    return result;
  }

  // Serializa las escrituras: dos persist() simultáneos no se mezclan.
  save(store) {
    const snapshot = {};
    for (const name of [...Object.keys(COLLECTIONS), "profile", "meta"]) {
      const value = store[name] ?? (name === "profile" ? null : name === "meta" ? {} : []);
      const json = JSON.stringify(value);
      if (this.snapshots.get(name) !== json) snapshot[name] = { value: JSON.parse(json), json };
    }
    const task = this.queue.then(() => this._write(snapshot));
    this.queue = task.catch(() => {});
    return task;
  }

  async _write(snapshot) {
    if (!Object.keys(snapshot).length) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [name, { value }] of Object.entries(snapshot)) {
        if (name === "profile") await this._writeProfile(client, value);
        else if (name === "meta") await client.query(
          "INSERT INTO app_meta (key, value, updated_at) VALUES ('meta', $1, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
          [JSON.stringify(value)]
        );
        else await this._writeCollection(client, name, value);
      }
      if (snapshot.schedules) await this._writeScheduleJobs(client, snapshot.schedules.value);
      await client.query("COMMIT");
      for (const [name, { json }] of Object.entries(snapshot)) this.snapshots.set(name, json);
      this.lastError = null;
      this.lastSavedAt = new Date().toISOString();
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      this.lastError = error.message;
      throw error;
    } finally {
      client.release();
    }
  }

  async _writeProfile(client, profile) {
    await client.query("DELETE FROM fb_profile");
    if (!profile) return;
    await client.query(
      "INSERT INTO fb_profile (id, name, url, avatar_url, synced_at, data) VALUES ($1, $2, $3, $4, $5, $6)",
      [String(profile.id || "profile"), profile.name || null, profile.url || null, profile.avatarUrl || null, ts(profile.syncedAt), JSON.stringify(profile)]
    );
  }

  async _upsert(client, table, columns, rows) {
    const names = ["id", ...Object.keys(columns), "data", "position"];
    const types = { id: "text", ...columns, data: "jsonb", position: "int" };
    const recordset = names.map((name) => `${name} ${types[name]}`).join(", ");
    const updates = names.filter((name) => name !== "id").map((name) => `${name} = EXCLUDED.${name}`).join(", ");
    for (let index = 0; index < rows.length; index += CHUNK) {
      await client.query(
        `INSERT INTO ${table} (${names.join(", ")}) SELECT ${names.join(", ")} FROM jsonb_to_recordset($1::jsonb) AS x(${recordset})
         ON CONFLICT (id) DO UPDATE SET ${updates}, updated_at = now()`,
        [JSON.stringify(rows.slice(index, index + CHUNK))]
      );
    }
  }

  async _writeCollection(client, name, items) {
    const spec = COLLECTIONS[name];
    const valid = (Array.isArray(items) ? items : []).filter((item) => item && item.id != null);
    const seen = new Set();
    const rows = [];
    valid.forEach((item, position) => {
      const id = String(item.id);
      if (seen.has(id)) return;
      seen.add(id);
      rows.push({ id, ...spec.row(item), data: item, position });
    });
    await this._upsert(client, spec.table, spec.columns, rows);
    if (!spec.append) await client.query(`DELETE FROM ${spec.table} WHERE NOT (id = ANY($1::text[]))`, [[...seen]]);
  }

  async _writeScheduleJobs(client, schedules) {
    const columns = {
      schedule_id: "text", target_type: "text", target_id: "text", target_name: "text", text: "text", run_at: "timestamptz",
      status: "text", attempts: "int", published_at: "timestamptz", last_error: "text",
    };
    const rows = [];
    for (const schedule of schedules || []) {
      (schedule.jobs || []).forEach((job, position) => rows.push({
        id: String(job.id), schedule_id: String(schedule.id), target_type: job.target?.type, target_id: job.target?.id,
        target_name: job.target?.name, text: job.text, run_at: ts(job.runAt), status: job.status, attempts: Number(job.attempts) || 0,
        published_at: ts(job.publishedAt), last_error: job.lastError || null, data: job, position,
      }));
    }
    await this._upsert(client, "schedule_jobs", columns, rows);
    await client.query("DELETE FROM schedule_jobs WHERE NOT (id = ANY($1::text[]))", [rows.map((row) => row.id)]);
  }

  async metaUpdatedAt() {
    const { rows } = await this.pool.query("SELECT updated_at FROM app_meta WHERE key = 'meta'");
    return rows[0]?.updated_at || null;
  }

  // Borra todo antes de una importación completa desde el JSON heredado.
  async truncateAll() {
    const tables = ["schedule_jobs", ...Object.values(COLLECTIONS).map((spec) => spec.table), "fb_profile", "app_meta"];
    await this.pool.query(`TRUNCATE ${[...new Set(tables)].join(", ")}`);
    this.snapshots.clear();
  }

  async stats() {
    const { rows } = await this.pool.query(`
      SELECT current_database() AS database,
        (SELECT count(*) FROM events)::int AS events,
        (SELECT count(*) FROM fb_groups)::int AS groups,
        (SELECT count(*) FROM fb_pages)::int AS pages,
        (SELECT count(*) FROM chats)::int AS chats,
        (SELECT count(*) FROM chat_messages)::int AS messages,
        (SELECT count(*) FROM schedules)::int AS schedules,
        (SELECT count(*) FROM schedule_jobs)::int AS jobs,
        (SELECT count(*) FROM publications)::int AS publications,
        (SELECT count(*) FROM fb_posts)::int AS posts,
        (SELECT count(*) FROM social_interactions)::int AS interactions,
        (SELECT count(*) FROM crm_leads)::int AS leads,
        (SELECT count(*) FROM crm_opportunities)::int AS opportunities,
        (SELECT count(*) FROM crm_contacts)::int AS contacts,
        (SELECT count(*) FROM discovered_groups)::int AS discovered,
        pg_size_pretty(pg_database_size(current_database())) AS size`);
    return rows[0];
  }

  async close() {
    await this.queue;
    await this.pool.end();
  }
}
