// Gemensamma hjälpfunktioner för avstånd och tider.
// Filen används både i webbläsaren och av servern (server.js importerar den),
// så att elevens mobil och servern räknar exakt likadant.

const JORDRADIE_M = 6371008.8;

/** Avstånd i meter mellan två punkter {lat, lng} (haversine-formeln). */
export function avstand(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * JORDRADIE_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Banans punkter i löpordning: start, kontroller, mål. */
export function banansPunkter(bana) {
  return [bana.start, ...(bana.kontroller || []), bana.mal].filter(Boolean);
}

/** Banans längd i meter, fågelvägen mellan punkterna i ordning. */
export function banlangd(bana) {
  const p = banansPunkter(bana);
  let summa = 0;
  for (let i = 1; i < p.length; i++) summa += avstand(p[i - 1], p[i]);
  return summa;
}

/** 754000 ms -> "12:34", 4000000 ms -> "1:06:40". */
export function formateraTid(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '–';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sek = s % 60;
  const tva = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${tva(m)}:${tva(sek)}` : `${tva(m)}:${tva(sek)}`;
}

/** 840 -> "840 m", 1430 -> "1,4 km". */
export function formateraAvstand(m) {
  if (m == null || !Number.isFinite(m)) return '–';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

/** Namn på en punkt i banan utifrån index: 0..n-1 är kontroller, n är mål. */
export function punktNamn(index, antalKontroller) {
  return index >= antalKontroller ? 'Mål' : String(index + 1);
}

/**
 * Sträcktider utifrån starttid och stämplingar.
 * Returnerar [{ fran, till, strack, total }] där tider är i ms.
 * Överhoppade kontroller syns som att sträckan går direkt till nästa stämplade punkt.
 */
export function strackor(antalKontroller, startTid, stamplingar) {
  if (!startTid) return [];
  const rader = [];
  let foregaende = startTid;
  let fran = 'Start';
  const sorterade = [...(stamplingar || [])].sort((a, b) => a.tid - b.tid);
  for (const s of sorterade) {
    const till = punktNamn(s.index, antalKontroller);
    rader.push({ fran, till, strack: s.tid - foregaende, total: s.tid - startTid });
    foregaende = s.tid;
    fran = till;
  }
  return rader;
}
