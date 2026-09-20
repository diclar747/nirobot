import { getSocket } from './socket';
import type { Socket } from 'socket.io-client';

export class CallAudio {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private capture: AudioWorkletNode | null = null;
  private socket: Socket | null = null;
  private id: string | null = null;
  private token = '';
  private nextPlay = 0;
  private stopped = false;
  private ready = false;
  private sources = new Set<AudioBufferSourceNode>();
  constructor(private onFailure: (message: string) => void) {}

  async prepare() {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) throw new Error('Este navegador no admite llamadas de voz. Usá un navegador actualizado con HTTPS.');
    this.context = new AudioContext({ sampleRate: 16000 });
    await this.context.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (this.stopped) { this.stream.getTracks().forEach(track => track.stop()); return; }
    await this.context.audioWorklet.addModule('/call-audio-worklet.js');
    if (this.stopped) return;
    this.capture = new AudioWorkletNode(this.context, 'niro-capture');
    this.context.createMediaStreamSource(this.stream).connect(this.capture);
    this.capture.connect(this.context.destination);
    this.capture.port.onmessage = event => {
      if (this.ready && this.socket?.connected && this.id) this.socket.volatile.emit('wa-call:pcm', { id: this.id, pcm: event.data });
    };
    this.capture.onprocessorerror = () => this.onFailure('Se interrumpió el micrófono. Finalizá la llamada y volvé a intentarlo.');
    for (const track of this.stream.getAudioTracks()) track.onended = () => { if (!this.stopped) this.onFailure('El micrófono se desconectó.'); };
    this.socket = getSocket();
    if (!this.socket.connected) await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => { this.socket?.off('connect', connected); reject(new Error('No se pudo conectar el audio al servidor')); }, 8000);
      const connected = () => { clearTimeout(timer); resolve(); };
      this.socket!.once('connect', connected);
    });
  }
  async attach(id: string, token: string) {
    if (this.stopped || !this.socket) throw new Error('El audio fue cancelado');
    this.id = id; this.token = token;
    this.socket.on('wa-call:audio', this.receive);
    this.socket.on('wa-call:ended', this.ended);
    this.socket.on('connect', this.reconnect);
    this.socket.on('disconnect', this.disconnected);
    await this.bind();
  }
  private bind = async () => {
    if (this.stopped) return;
    await new Promise<void>((resolve, reject) => {
      this.socket!.timeout(5000).emit('wa-call:attach', { id: this.id, token: this.token }, (error: Error | null, result: { ok: boolean }) => {
        if (error || !result?.ok) reject(new Error('No se pudo habilitar el audio de esta llamada'));
        else { this.ready = true; resolve(); }
      });
    });
  };
  private reconnect = () => { void this.bind().catch(error => this.onFailure(error.message)); };
  private disconnected = () => { this.ready = false; };
  private ended = (data: { id: string }) => { if (data.id === this.id) this.stop(); };
  private receive = (data: { id: string; pcm: ArrayBuffer }) => {
    if (this.stopped || data.id !== this.id || !this.context || !(data.pcm instanceof ArrayBuffer) || data.pcm.byteLength % 4) return;
    const samples = new Float32Array(data.pcm);
    if (!samples.length || samples.length > 16000) return;
    const audio = this.context.createBuffer(1, samples.length, 16000);
    audio.copyToChannel(samples, 0);
    const source = this.context.createBufferSource();
    source.buffer = audio; source.connect(this.context.destination);
    const now = this.context.currentTime;
    if (this.nextPlay < now || this.nextPlay > now + 0.3) {
      this.sources.forEach(item => { try { item.stop(); } catch { /* already stopped */ } });
      this.sources.clear(); this.nextPlay = now + 0.04;
    }
    this.sources.add(source); source.onended = () => this.sources.delete(source);
    source.start(this.nextPlay); this.nextPlay += audio.duration;
  };
  mute(muted: boolean) { this.stream?.getAudioTracks().forEach(track => { track.enabled = !muted; }); }
  stop() {
    if (this.stopped) return;
    this.stopped = true; this.ready = false;
    if (this.id) this.socket?.emit('wa-call:detach');
    this.socket?.off('wa-call:audio', this.receive);
    this.socket?.off('wa-call:ended', this.ended);
    this.socket?.off('connect', this.reconnect);
    this.socket?.off('disconnect', this.disconnected);
    this.stream?.getTracks().forEach(track => track.stop());
    this.capture?.disconnect();
    if (this.context) void this.context.close();
    this.sources.clear();
  }
}
