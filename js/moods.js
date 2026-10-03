// Scala dell'umore: 7 fasce uguali da 0 a 100.
// Le etichette sono neutre rispetto al genere, così vanno bene per tutti e due.
export const MOODS = [
  { emoji: '☠️', label: 'Zona rossa', hint: 'Mantieni la distanza di sicurezza.', color: '#ff2d55' },
  { emoji: '😤', label: 'Nervi a fior di pelle', hint: 'Una parola sbagliata e salta tutto.', color: '#ff6a3d' },
  { emoji: '🪫', label: 'Batteria scarica', hint: 'Pochi stimoli, tanta comprensione.', color: '#ffa62b' },
  { emoji: '😐', label: 'Meh', hint: 'Né carne né pesce.', color: '#ffe14d' },
  { emoji: '🙂', label: 'Tutto ok', hint: 'Si può fare conversazione.', color: '#b6f24a' },
  { emoji: '😎', label: 'Good vibes', hint: 'Momento ideale per proposte.', color: '#3dff8b' },
  { emoji: '🤩', label: 'Al top', hint: 'Approfittane finché dura.', color: '#35e0ff' },
];

export function moodIndex(value) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return Math.min(MOODS.length - 1, Math.floor(v / (100 / MOODS.length)));
}

export function moodFor(value) {
  return MOODS[moodIndex(value)];
}

// "Mi serve…": bisogni rapidi da segnalare insieme all'umore.
export const NEEDS = [
  { key: 'coccole', emoji: '🫂', label: 'Coccole' },
  { key: 'spazio', emoji: '🚪', label: 'Spazio' },
  { key: 'fame', emoji: '🍕', label: 'Fame' },
  { key: 'sonno', emoji: '😴', label: 'Sonno' },
  { key: 'parlare', emoji: '💬', label: 'Parlare' },
  { key: 'silenzio', emoji: '🤫', label: 'Silenzio' },
  { key: 'divano', emoji: '🛋️', label: 'Divano & serie' },
  { key: 'uscire', emoji: '🎉', label: 'Uscire' },
  { key: 'cioccolato', emoji: '🍫', label: 'Cioccolato' },
  { key: 'stress', emoji: '💼', label: 'Stress' },
  { key: 'dolorini', emoji: '🤕', label: 'Dolorini' },
  { key: 'ciclo', emoji: '🌸', label: 'Ciclo' },
];

export const NEED_KEYS = new Set(NEEDS.map((n) => n.key));

export const AVATARS = ['🦊', '🐼', '🐸', '🦄', '🐱', '🐻', '🐧', '👾', '🌶️', '🍑', '🌙', '⚡'];

// Messaggini al volo, senza cambiare l'umore.
export const POKES = [
  { emoji: '💋', label: 'Bacio' },
  { emoji: '🫂', label: 'Abbraccio' },
  { emoji: '👀', label: 'Ti penso' },
  { emoji: '☕', label: 'Caffè?' },
  { emoji: '🍕', label: 'Pizza?' },
];
