import data from '@emoji-mart/data';
import es from '@emoji-mart/data/i18n/es.json';
import Picker from '@emoji-mart/react';

/**
 * Selector de emojis completo (emoji-mart): todas las categorías, buscador, recientes/frecuentes,
 * tonos de piel y textos en español. Se carga de forma diferida desde EmojiPicker.
 */
export default function EmojiMartPanel({ onPick, dark, perLine = 8 }: { onPick: (emoji: string) => void; dark: boolean; perLine?: number }) {
  return (
    <Picker
      data={data}
      i18n={es}
      locale="es"
      theme={dark ? 'dark' : 'light'}
      set="native"
      perLine={perLine}
      previewPosition="none"
      skinTonePosition="search"
      navPosition="top"
      searchPosition="sticky"
      maxFrequentRows={2}
      emojiButtonSize={38}
      emojiSize={26}
      onEmojiSelect={(emoji: { native: string }) => onPick(emoji.native)}
    />
  );
}
