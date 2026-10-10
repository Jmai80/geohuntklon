// Små hjälpfunktioner som både elev- och lärarsidan använder.

export const $ = (selektor, rot = document) => rot.querySelector(selektor);
export const $$ = (selektor, rot = document) => [...rot.querySelectorAll(selektor)];

/** Gör text säker att stoppa in i HTML (skyddar mot att någon skriver <script> som namn). */
export function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (t) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[t]);
}

export class ApiFel extends Error {
  constructor(status, meddelande) {
    super(meddelande);
    this.status = status;
  }
}

/** Visar en vy (ett element med data-vy) och döljer de andra. */
export function visaVy(id) {
  for (const el of $$('[data-vy]')) el.hidden = el.id !== id;
  window.scrollTo(0, 0);
}

export function visaFel(element, meddelande) {
  element.textContent = meddelande || '';
  element.hidden = !meddelande;
}

/** "nyss", "12 s sedan", "3 min sedan". */
export function tidSedan(ms) {
  if (ms == null || !Number.isFinite(ms)) return '–';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'nyss';
  if (s < 60) return `${s} s sedan`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min sedan`;
  return `${Math.round(m / 60)} h sedan`;
}

/** Klockslag, t.ex. "14:05". */
export function klockslag(tid) {
  return new Date(tid).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
}
