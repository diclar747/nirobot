import { io, type Socket } from 'socket.io-client';

interface WidgetConfig {
  org: string;
  apiBase?: string;
}

interface WidgetAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
}

interface WidgetMessage {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND' | 'NOTE';
  content: string;
  createdAt: string;
  sender: { name: string } | null;
  attachment: WidgetAttachment | null;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface WidgetConversation {
  id: string;
  status: string;
}

function readConfig(): WidgetConfig {
  const scriptTag = document.currentScript as HTMLScriptElement | null;
  const fromAttr = scriptTag?.dataset.org;
  const fromWindow = (window as unknown as { NiroWidget?: WidgetConfig }).NiroWidget;
  const org = fromAttr || fromWindow?.org;
  if (!org) throw new Error('NIRO widget: falta el slug de organización (atributo data-org o window.NiroWidget.org)');
  const apiBase = fromWindow?.apiBase || new URL(scriptTag?.src || window.location.href).origin;
  return { org, apiBase };
}

function tokenKey(org: string) {
  return `niro_widget_token_${org}`;
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

const STYLES = `
.niro-w-bubble{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;background:#2f5fe0;box-shadow:0 8px 24px rgba(47,95,224,.35);display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:999999;border:none;}
.niro-w-bubble svg{width:26px;height:26px;stroke:#fff;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}
.niro-w-badge{position:absolute;top:-4px;right:-4px;background:#dc2626;color:#fff;font:700 11px/1 Arial,sans-serif;min-width:18px;height:18px;border-radius:9px;display:flex;align-items:center;justify-content:center;padding:0 4px;}
.niro-w-panel{position:fixed;bottom:88px;right:20px;width:340px;max-width:calc(100vw - 32px);height:460px;max-height:calc(100vh - 120px);background:#fff;border-radius:18px;box-shadow:0 20px 60px rgba(16,24,40,.25);display:flex;flex-direction:column;overflow:hidden;z-index:999999;font-family:Inter,Arial,sans-serif;}
.niro-w-header{background:#2f5fe0;color:#fff;padding:16px;font-weight:700;font-size:15px;}
.niro-w-header small{display:block;font-weight:400;opacity:.85;font-size:12px;margin-top:2px;}
.niro-w-messages{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:#f4f6fc;}
.niro-w-bubble-msg{max-width:80%;padding:9px 12px;border-radius:13px;font-size:13.5px;line-height:1.4;white-space:pre-wrap;word-break:break-word;}
.niro-w-bubble-msg.mine{align-self:flex-end;background:#2f5fe0;color:#fff;border-bottom-right-radius:4px;}
.niro-w-bubble-msg.theirs{align-self:flex-start;background:#fff;border:1px solid #e7e9f3;color:#10152b;border-bottom-left-radius:4px;}
.niro-w-composer{display:flex;gap:8px;padding:10px;border-top:1px solid #e7e9f3;background:#fff;}
.niro-w-composer input{flex:1;border:1px solid #e7e9f3;border-radius:10px;padding:9px 12px;font-size:13.5px;outline:none;}
.niro-w-composer button{background:#2f5fe0;border:none;color:#fff;border-radius:10px;width:38px;flex-shrink:0;cursor:pointer;}
.niro-w-attach-btn{background:none!important;color:#6b7280!important;width:32px!important;}
.niro-w-closed{padding:10px 14px;font-size:12.5px;background:#fdeaea;color:#a91f1f;text-align:center;}
.niro-w-restart{background:none;border:none;color:#2347b8;text-decoration:underline;cursor:pointer;font-size:12.5px;padding:0;}
.niro-w-attach-img{max-width:100%;border-radius:8px;display:block;margin-bottom:4px;}
.niro-w-attach-file{display:flex;align-items:center;gap:6px;background:rgba(0,0,0,.06);border-radius:8px;padding:6px 8px;margin-bottom:4px;font-size:12px;text-decoration:none;color:inherit;}
`;

class NiroWidget {
  private config: WidgetConfig;
  private token: string | null = null;
  private conversation: WidgetConversation | null = null;
  private socket: Socket | null = null;
  private open = false;
  private unread = 0;
  private root: HTMLElement;
  private bubble!: HTMLButtonElement;
  private badge!: HTMLSpanElement;
  private panel!: HTMLDivElement;
  private messagesEl!: HTMLDivElement;
  private input!: HTMLInputElement;

  constructor(config: WidgetConfig) {
    this.config = config;
    this.root = document.createElement('div');
    document.body.appendChild(this.root);
    this.injectStyles();
    this.renderShell();
  }

  private injectStyles() {
    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  private api(path: string) {
    return `${this.config.apiBase}/api/public/widget/${this.config.org}${path}`;
  }

  private renderShell() {
    this.bubble = document.createElement('button');
    this.bubble.className = 'niro-w-bubble';
    this.bubble.setAttribute('aria-label', 'Abrir chat');
    this.bubble.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M4 11.5c0-4.4 3.6-8 8-8s8 3.6 8 8-3.6 8-8 8c-1 0-2-.2-2.9-.5L5 20l1-4.3c-1.3-1.2-2-2.7-2-4.2Z"/></svg>';
    this.badge = document.createElement('span');
    this.badge.className = 'niro-w-badge';
    this.badge.style.display = 'none';
    this.bubble.appendChild(this.badge);
    this.bubble.addEventListener('click', () => this.toggle());

    this.panel = document.createElement('div');
    this.panel.className = 'niro-w-panel';
    this.panel.style.display = 'none';

    this.root.appendChild(this.panel);
    this.root.appendChild(this.bubble);
  }

  private async toggle() {
    this.open = !this.open;
    this.panel.style.display = this.open ? 'flex' : 'none';
    if (this.open) {
      this.unread = 0;
      this.updateBadge();
      if (!this.token) {
        await this.start();
      } else if (!this.socket) {
        await this.loadConversation();
        this.connectSocket();
      }
    }
  }

  private updateBadge() {
    this.badge.style.display = this.unread > 0 ? 'flex' : 'none';
    this.badge.textContent = String(this.unread);
  }

  private async fetchInfo() {
    try {
      const res = await fetch(this.api('/info'));
      if (!res.ok) return null;
      return (await res.json()) as { name: string; welcomeMessage: string };
    } catch {
      return null;
    }
  }

  private async start() {
    const stored = localStorage.getItem(tokenKey(this.config.org));
    if (stored) {
      this.token = stored;
      const ok = await this.loadConversation();
      if (ok) {
        this.connectSocket();
        return;
      }
    }

    const info = await this.fetchInfo();
    const res = await fetch(this.api('/start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!res.ok) {
      this.renderError('No se pudo iniciar el chat. Probá de nuevo en un momento.');
      return;
    }
    const data = await res.json();
    this.token = data.token;
    this.conversation = data.conversation;
    localStorage.setItem(tokenKey(this.config.org), this.token!);
    this.renderHeader(info?.name || 'Chat');
    this.renderMessages([]);
    this.renderComposer();
    this.connectSocket();
  }

  private async loadConversation(): Promise<boolean> {
    if (!this.token) return false;
    const res = await fetch(this.api(`/conversation?token=${encodeURIComponent(this.token)}`));
    if (!res.ok) {
      localStorage.removeItem(tokenKey(this.config.org));
      this.token = null;
      return false;
    }
    const data = await res.json();
    this.conversation = data.conversation;
    const info = await this.fetchInfo();
    this.renderHeader(info?.name || 'Chat');
    this.renderMessages(data.messages);
    this.renderComposer();
    return true;
  }

  private renderError(message: string) {
    this.panel.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'niro-w-closed';
    div.textContent = message;
    this.panel.appendChild(div);
  }

  private renderHeader(orgName: string) {
    this.panel.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'niro-w-header';
    header.innerHTML = `${orgName}<small>Te respondemos en breve</small>`;
    this.panel.appendChild(header);

    if (this.conversation?.status === 'CLOSED') {
      const closed = document.createElement('div');
      closed.className = 'niro-w-closed';
      closed.innerHTML = 'Esta conversación fue cerrada. ';
      const restart = document.createElement('button');
      restart.className = 'niro-w-restart';
      restart.textContent = 'Empezar una nueva';
      restart.addEventListener('click', () => {
        localStorage.removeItem(tokenKey(this.config.org));
        this.token = null;
        this.socket?.disconnect();
        this.socket = null;
        this.start();
      });
      closed.appendChild(restart);
      this.panel.appendChild(closed);
    }

    this.messagesEl = document.createElement('div');
    this.messagesEl.className = 'niro-w-messages';
    this.panel.appendChild(this.messagesEl);
  }

  private renderMessages(messages: WidgetMessage[]) {
    this.messagesEl.innerHTML = '';
    for (const m of messages) this.appendMessage(m);
    this.scrollToBottom();
  }

  private appendMessage(m: WidgetMessage) {
    const bubble = document.createElement('div');
    bubble.className = `niro-w-bubble-msg ${m.direction === 'INBOUND' ? 'mine' : 'theirs'}`;

    if (m.attachment) {
      const url = this.api(`/attachments/${m.attachment.id}?token=${encodeURIComponent(this.token || '')}`);
      if (m.attachment.mimeType.startsWith('image/')) {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noreferrer';
        const img = document.createElement('img');
        img.className = 'niro-w-attach-img';
        img.src = url;
        img.alt = m.attachment.fileName;
        link.appendChild(img);
        bubble.appendChild(link);
      } else {
        const link = document.createElement('a');
        link.className = 'niro-w-attach-file';
        link.href = url;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = `📎 ${m.attachment.fileName} · ${formatFileSize(m.attachment.size)}`;
        bubble.appendChild(link);
      }
    }

    if (m.content) {
      const text = document.createElement('div');
      text.textContent = m.content;
      bubble.appendChild(text);
    }

    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:10px;opacity:.7;margin-top:3px;';
    meta.textContent = `${m.direction === 'INBOUND' ? 'Vos' : m.sender?.name || 'Asistente'} · ${formatTime(m.createdAt)}`;
    bubble.appendChild(meta);
    this.messagesEl.appendChild(bubble);
  }

  private scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private renderComposer() {
    if (this.conversation?.status === 'CLOSED') return;
    const form = document.createElement('form');
    form.className = 'niro-w-composer';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.style.display = 'none';
    fileInput.accept = 'image/*,audio/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.txt';
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file) this.uploadFile(file);
    });

    const attachButton = document.createElement('button');
    attachButton.type = 'button';
    attachButton.className = 'niro-w-attach-btn';
    attachButton.setAttribute('aria-label', 'Adjuntar archivo');
    attachButton.innerHTML =
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin:auto"><path d="M17.5 9.5 10 17a3 3 0 0 1-4.2-4.2l8-8a2 2 0 1 1 2.9 2.9l-7.6 7.6a1 1 0 0 1-1.4-1.4l6.9-6.9"/></svg>';
    attachButton.addEventListener('click', () => fileInput.click());

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.placeholder = 'Escribí tu mensaje…';
    const button = document.createElement('button');
    button.type = 'submit';
    button.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" style="margin:auto"><path fill="#fff" d="m3 11 18-8-8 18-2.5-6.5L3 11Z"/></svg>';
    form.appendChild(fileInput);
    form.appendChild(attachButton);
    form.appendChild(this.input);
    form.appendChild(button);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.send();
    });
    this.panel.appendChild(form);
  }

  private async uploadFile(file: File) {
    if (!this.token) return;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('token', this.token);
    const res = await fetch(this.api('/attachments'), { method: 'POST', body: formData });
    if (res.ok) {
      const data = await res.json();
      this.appendMessage(data.message);
      this.scrollToBottom();
    }
  }

  private async send() {
    const content = this.input.value.trim();
    if (!content || !this.token) return;
    this.input.value = '';
    const res = await fetch(this.api('/messages'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: this.token, content })
    });
    if (res.ok) {
      const data = await res.json();
      this.appendMessage(data.message);
      this.scrollToBottom();
    }
  }

  private connectSocket() {
    if (!this.token || this.socket) return;
    this.socket = io(this.config.apiBase, { auth: { widgetToken: this.token } });
    this.socket.on('message:new', ({ message }: { message: WidgetMessage }) => {
      if (message.direction === 'INBOUND') return; // already rendered optimistically on send
      if (this.messagesEl) {
        this.appendMessage(message);
        this.scrollToBottom();
      }
      if (!this.open) {
        this.unread += 1;
        this.updateBadge();
      }
    });
  }
}

try {
  const config = readConfig();
  new NiroWidget(config);
} catch (err) {
  console.error(err);
}
