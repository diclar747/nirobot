function renderWelcome(settings) {
  const lines = [settings.welcomeMessage || '¡Hola! Soy NIRO, tu asistente virtual. ¿En qué podemos ayudarte hoy?'];
  const options = Array.isArray(settings.menuOptions) ? settings.menuOptions : [];
  if (options.length > 0) {
    lines.push('');
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const key = opt.key || String(i + 1);
      lines.push(`Para ${opt.label}, escribí ${key}`);
    }
  }
  return lines.join('\n');
}

function matchMenuOption(settings, content) {
  const options = Array.isArray(settings.menuOptions) ? settings.menuOptions : [];
  const trimmed = (content || '').trim().toLowerCase();
  return (
    options.find((opt, idx) => {
      const key = String(opt.key || (idx + 1)).trim().toLowerCase();
      return key === trimmed;
    }) || null
  );
}

module.exports = { renderWelcome, matchMenuOption };

