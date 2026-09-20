import { useMemo, useState } from 'react';

const EMOJI_GROUPS: { key: string; icon: string; label: string; emojis: string[] }[] = [
  { key: 'caras', icon: '😀', label: 'Caras', emojis: '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😜 🤪 😝 🤗 🤭 🤔 🤩 🥳 😎 🤓 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤤 😴 🙄 😬 🤐 😷' .split(' ') },
  { key: 'gestos', icon: '👋', label: 'Gestos', emojis: '👋 🤚 🖐️ ✋ 🖖 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 🦾 👀 👁️ 👂 👃 🧠' .split(' ') },
  { key: 'corazones', icon: '❤️', label: 'Corazones', emojis: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 😻 💌 💋 💯 💢 💥 💫 💦 💨 ✨ ⭐ 🌟 🔥 🎉 🎊 🎁 🎈' .split(' ') },
  { key: 'negocios', icon: '💼', label: 'Negocios', emojis: '💼 📣 📢 📞 ☎️ 📱 💬 🗨️ ✉️ 📧 📩 📦 🛍️ 🛒 💰 💵 💳 🏷️ 🧾 📈 📊 📅 🗓️ ⏰ ⏳ 🚚 🏪 🏢 🏠 📍 🗺️ 🔔 🔗 ✅ ☑️ ✔️ ❌ ⚠️ ❗ ❓ 🆕 🆓 🔝 👉' .split(' ') },
  { key: 'comida', icon: '🍕', label: 'Comida', emojis: '🍎 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥑 🍅 🥕 🌽 🥖 🧀 🍗 🍖 🍔 🍟 🍕 🌭 🌮 🌯 🥗 🍝 🍣 🍰 🎂 🍩 🍪 🍫 🍬 🍦 ☕ 🍵 🥤 🍺 🍷 🥂 🍾' .split(' ') },
  { key: 'naturaleza', icon: '🌿', label: 'Naturaleza', emojis: '🐶 🐱 🐭 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦅 🦋 🐝 🌸 🌹 🌺 🌻 🌼 🌷 🌱 🌿 🍀 🌴 🌳 🌞 🌙 ⭐ ☀️ ⛅ 🌈 ☔ ❄️ 🌊' .split(' ') },
  { key: 'objetos', icon: '⚽', label: 'Actividades', emojis: '⚽ 🏀 🏈 ⚾ 🎾 🏐 🎱 🏓 🥇 🏆 🏅 🎮 🎯 🎲 🎵 🎶 🎤 🎧 🎬 🎨 📚 💡 🔑 🔒 🎓 🚗 ✈️ 🚀 ⛱️ 🏖️ 🎄 🎃 🎁 🕯️ 🧸 💎 👑 👗 👟 🕶️' .split(' ') }
];

export function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const [group, setGroup] = useState(EMOJI_GROUPS[0].key);
  const active = useMemo(() => EMOJI_GROUPS.find((item) => item.key === group) || EMOJI_GROUPS[0], [group]);
  return (
    <div className="emoji-picker" role="dialog" aria-label="Selector de emojis">
      <div className="emoji-picker-tabs">
        {EMOJI_GROUPS.map((item) => (
          <button type="button" key={item.key} className={item.key === group ? 'active' : ''} onClick={() => setGroup(item.key)} title={item.label} aria-label={item.label}>{item.icon}</button>
        ))}
        <button type="button" className="emoji-picker-close" onClick={onClose} aria-label="Cerrar selector">×</button>
      </div>
      <div className="emoji-picker-label">{active.label}</div>
      <div className="emoji-picker-grid">
        {active.emojis.map((emoji, index) => (
          <button type="button" key={`${emoji}-${index}`} onClick={() => onPick(emoji)}>{emoji}</button>
        ))}
      </div>
    </div>
  );
}
