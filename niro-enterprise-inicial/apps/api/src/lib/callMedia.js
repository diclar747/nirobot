// Live audio is bound to a single authenticated user/socket and an unguessable call token.
function attachCallMedia(socket) {
  let binding = null;
  let callId = null;
  let windowStart = Date.now();
  let frames = 0;
  socket.on('wa-call:attach', async (data, ack) => {
    if (typeof ack !== 'function') return;
    const auth = socket.data.auth;
    if (!auth?.organizationId || !['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT'].includes(auth.role)) return ack({ ok: false });
    try {
      const user = await require('./prisma').prisma.user.findUnique({ where: { id: auth.userId }, include: { organization: true } });
      if (!user?.active || !user.organization?.active || user.organizationId !== auth.organizationId || !['OWNER','ADMIN','SUPERVISOR','AGENT'].includes(user.role)) return ack({ ok: false });
    } catch { return ack({ ok: false }); }
    const next = require('./callCampaigns').bindDirectAudio(auth, data?.id, data?.token, socket);
    if (!next) return ack({ ok: false });
    binding?.detach();
    // Rebind after detaching a previous stream so its disconnect timer is cleared.
    binding = require('./callCampaigns').bindDirectAudio(auth, data.id, data.token, socket);
    callId = data.id;
    ack({ ok: true, sampleRate: 16000 });
  });
  socket.on('wa-call:pcm', data => {
    if (!binding || data?.id !== callId || !Buffer.isBuffer(data.pcm) || data.pcm.length !== 1280) return;
    const now = Date.now();
    if (now - windowStart >= 1000) { windowStart = now; frames = 0; }
    if (++frames > 75) return;
    const pcm = new Float32Array(320);
    for (let i = 0; i < pcm.length; i++) {
      const value = data.pcm.readFloatLE(i * 4);
      if (!Number.isFinite(value) || Math.abs(value) > 1) return;
      pcm[i] = value;
    }
    binding.push(pcm);
  });
  const detach = () => { binding?.detach(); binding = null; callId = null; };
  socket.on('wa-call:detach', detach);
  socket.on('disconnect', detach);
}
module.exports = { attachCallMedia };
