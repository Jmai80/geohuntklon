// Elevens sida: gå med med PIN, kolla GPS, springa och stämpla.
// Mobilen skickar sina positioner till servern, och servern avgör när en kontroll är tagen.

import { avstand, banlangd, formateraTid, formateraAvstand, strackor } from './geo.js';
import { $, esc, visaVy, visaFel } from './hjalp.js';
import { rpc } from './backend.js';
import { BanLager, MinPosition, skapaKarta } from './kartlager.js';

const SESSION_NYCKEL = 'stampla-elev';
const SKICKA_VAR_MS = 2000; // skicka köade positioner så här ofta
const LIVSTECKEN_MS = 10000; // hör av dig minst så här ofta även utan nya positioner
const GPS_REDO_M = 30; // noggrannhet som räknas som bra
const GPS_STARTGRANS_M = 50; // sämre än så här får man inte starta
const GPS_UNGEFARLIG_M = 150; // sämre än så här betyder oftast att "exakt plats" är avslaget

const s = {
  omgang: null, // { id, namn, status, testlage, bana }
  deltagareId: null,
  token: null,
  lage: null, // elevens läge enligt servern
  fix: null, // senaste position { lat, lng, acc, t, sim? }
  simulera: false,
  ko: [], // positioner som inte skickats än
  skickar: false,
  senastSkickat: 0,
  online: true,
  lamnatAppen: 0,
  watchId: null,
  karta: null,
  banLager: null,
  minPos: null,
  folj: false,
  intervaller: [],
  wakeLock: null,
  ljud: null,
  overlayTimer: null,
};

// ---------------------------------------------------------------------------
// Start och sparad session
// ---------------------------------------------------------------------------

function sparaSession() {
  try {
    localStorage.setItem(SESSION_NYCKEL, JSON.stringify({ omgangId: s.omgang.id, deltagareId: s.deltagareId, token: s.token }));
  } catch {
    /* privat läge e.d. – då går det inte att fortsätta efter omladdning */
  }
}

function lasSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_NYCKEL));
  } catch {
    return null;
  }
}

function rensaSession() {
  try {
    localStorage.removeItem(SESSION_NYCKEL);
  } catch {
    /* ingenting att göra */
  }
}

// Det som identifierar eleven i varje anrop till databasen.
const mig = () => ({ p_omgang_id: s.omgang.id, p_did: s.deltagareId, p_token: s.token });

async function init() {
  kopplaHandelser();
  const pinIUrl = new URLSearchParams(location.search).get('pin');
  if (pinIUrl) $('#pin').value = pinIUrl.replace(/\D/g, '').slice(0, 6);
  visaVy('vy-pin');

  const sparad = lasSession();
  if (!sparad?.omgangId) return;
  try {
    const svar = await rpc('elev_lage', { p_omgang_id: sparad.omgangId, p_did: sparad.deltagareId, p_token: sparad.token });
    const pagar = svar.lage.omgangStatus === 'aktiv' && ['vantar', 'springer'].includes(svar.lage.status);
    if (!pagar) return rensaSession();
    s.omgang = svar.omgang;
    s.deltagareId = sparad.deltagareId;
    s.token = sparad.token;
    s.lage = svar.lage;
    $('#fortsatt-text').textContent =
      svar.lage.status === 'springer'
        ? `${svar.omgang.bana.namn}: ${antalTagna()} av ${svar.omgang.bana.kontroller.length} kontroller tagna.`
        : `${svar.omgang.bana.namn}: du har inte startat än.`;
    $('#fortsatt').hidden = false;
  } catch (fel) {
    if (fel.status) rensaSession(); // status 0 = ingen kontakt, spara då sessionen till nästa gång
  }
}

function kopplaHandelser() {
  $('#pin-form').addEventListener('submit', vidPin);
  $('#namn-form').addEventListener('submit', vidNamn);
  $('#namn-tillbaka').addEventListener('click', () => visaVy('vy-pin'));
  $('#fortsatt-knapp').addEventListener('click', fortsatt);
  $('#slang-knapp').addEventListener('click', slangSession);
  $('#simulera').addEventListener('change', vidSimulera);
  $('#start-knapp').addEventListener('click', vidStart);
  $('#folj-knapp').addEventListener('click', () => satFolj(!s.folj));
  $('#meny-knapp').addEventListener('click', oppnaMeny);
  $('#meny-stang').addEventListener('click', () => $('#meny').close());
  $('#hoppa-knapp').addEventListener('click', hoppaOver);
  $('#avbryt-knapp').addEventListener('click', avbrytLopp);
  $('#klar-knapp').addEventListener('click', () => {
    rensaSession();
    location.href = './';
  });
  $('#pin').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  });

  document.addEventListener('visibilitychange', () => {
    if (s.lage?.status !== 'springer') return;
    if (document.visibilityState === 'hidden') {
      s.lamnatAppen += 1;
    } else {
      hallSkarmenTand();
      skicka();
    }
  });
  window.addEventListener('online', () => skicka());
}

/** Kör en knapps åtgärd och spärrar knappen under tiden, så att den inte trycks två gånger. */
async function medSparr(knapp, atgard) {
  if (knapp.disabled) return;
  knapp.disabled = true;
  try {
    await atgard();
  } finally {
    knapp.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// PIN, namn och GPS-koll
// ---------------------------------------------------------------------------

function vidPin(e) {
  e.preventDefault();
  const knapp = e.submitter || $('#pin-form button');
  medSparr(knapp, async () => {
    const pin = $('#pin').value.replace(/\D/g, '');
    if (pin.length !== 6) return visaFel($('#pin-fel'), 'PIN-koden har sex siffror.');
    visaFel($('#pin-fel'), '');
    try {
      const { omgang } = await rpc('elev_pin', { p_pin: pin });
      s.omgang = omgang;
      $('#namn-bana').textContent = `${omgang.namn}: ${omgang.bana.namn}`;
      visaVy('vy-namn');
      $('#namn').focus();
    } catch (fel) {
      visaFel($('#pin-fel'), fel.message);
    }
  });
}

function vidNamn(e) {
  e.preventDefault();
  const knapp = e.submitter || $('#namn-form button[type=submit]');
  medSparr(knapp, async () => {
    const namn = $('#namn').value.trim();
    if (!namn) return visaFel($('#namn-fel'), 'Skriv ditt namn så att läraren vet vem du är.');
    visaFel($('#namn-fel'), '');
    try {
      const svar = await rpc('elev_ga_med', { p_omgang_id: s.omgang.id, p_namn: namn });
      s.deltagareId = svar.deltagareId;
      s.token = svar.token;
      s.omgang = svar.omgang;
      s.lage = svar.lage;
      sparaSession();
      visaRedo();
    } catch (fel) {
      visaFel($('#namn-fel'), fel.message);
    }
  });
}

function fortsatt() {
  forberedLjud();
  $('#fortsatt').hidden = true;
  if (s.lage.status === 'springer') {
    s.simulera = s.lage.simulerad && s.omgang.testlage;
    startaLopp(false);
  } else {
    visaRedo();
  }
}

function slangSession() {
  const gammal = lasSession();
  if (gammal?.token) {
    // Säg till servern att loppet är avbrutet, så att läraren inte väntar på eleven.
    rpc('elev_avbryt', { p_omgang_id: gammal.omgangId, p_did: gammal.deltagareId, p_token: gammal.token }).catch(() => {});
  }
  rensaSession();
  s.omgang = s.lage = s.token = s.deltagareId = null;
  $('#fortsatt').hidden = true;
  $('#pin').focus();
}

function visaRedo() {
  const b = s.omgang.bana;
  $('#redo-bana').textContent = b.namn;
  $('#redo-fakta').textContent = `${b.kontroller.length} ${b.kontroller.length === 1 ? 'kontroll' : 'kontroller'} och mål, ${formateraAvstand(banlangd(b))} fågelvägen.`;
  $('#regel-radie').textContent = `Ta kontrollerna i nummerordning. Mobilen stämplar själv när du är inom ${b.radie} meter.`;
  $('#test-vaxel').hidden = !s.omgang.testlage;
  $('#simulera').checked = s.simulera;
  visaFel($('#start-fel'), '');
  visaVy('vy-redo');
  if (s.simulera) visaGpsLage('test');
  else {
    startaGps();
    if (s.fix) bedomGps(s.fix.acc);
  }
}

function vidSimulera(e) {
  s.simulera = e.target.checked;
  if (s.simulera) {
    stoppaGps();
    visaGpsLage('test');
  } else {
    s.fix = null;
    startaGps();
  }
}

const GPS_TEXTER = {
  soker: ['Söker din position …', 'Det kan ta upp till en halv minut. Ställ dig gärna utomhus.'],
  redo: ['GPS redo', (acc) => `Positionen är noggrann på ±${acc} meter.`],
  vantar: ['Väntar på bättre GPS-signal', (acc) => `Just nu ±${acc} meter. Stå utomhus en stund, gärna en bit från höga hus.`],
  ungefarlig: [
    'Din position är för ungefärlig',
    (acc) => `±${acc} meter. Mobilen delar bara ungefärlig plats med webbläsaren. Slå på exakt plats:`,
  ],
  nekad: ['Platsåtkomst är avstängd', 'Sidan behöver din position för att kunna stämpla. Så här slår du på den:'],
  osaker: [
    'GPS fungerar inte på den här adressen',
    'Mobiler delar bara sin position med sidor vars adress börjar med https://. Be din lärare om rätt länk.',
  ],
  saknas: ['Webbläsaren kan inte dela position', 'Prova med Safari eller Chrome.'],
  ingen: ['Hittar ingen position', 'Kolla att platstjänster är påslagna och prova igen utomhus.'],
  test: ['Testläge', 'Du börjar vid starten. Tryck på kartan för att flytta dig dit du vill.'],
};

function visaGpsLage(lage, acc) {
  const [rubrik, text] = GPS_TEXTER[lage];
  const ruta = $('#gps-ruta');
  ruta.dataset.lage = { redo: 'redo', test: 'test', vantar: 'vantar', soker: 'soker' }[lage] || 'fel';
  $('#gps-rubrik').textContent = rubrik;
  $('#gps-text').textContent = typeof text === 'function' ? text(acc) : text;
  const hjalp = $('#gps-hjalp');
  hjalp.hidden = !['ungefarlig', 'nekad'].includes(lage);
  hjalp.open = !hjalp.hidden;
  const kanStarta = lage === 'test' || lage === 'redo' || (lage === 'vantar' && acc <= GPS_STARTGRANS_M);
  $('#start-knapp').disabled = !kanStarta;
}

function bedomGps(acc) {
  if (acc <= GPS_REDO_M) visaGpsLage('redo', acc);
  else if (acc <= GPS_UNGEFARLIG_M) visaGpsLage('vantar', acc);
  else visaGpsLage('ungefarlig', acc);
}

function startaGps() {
  if (s.watchId !== null) return;
  if (!window.isSecureContext) return visaGpsLage('osaker');
  if (!('geolocation' in navigator)) return visaGpsLage('saknas');
  if (!$('#vy-redo').hidden) visaGpsLage('soker');
  s.watchId = navigator.geolocation.watchPosition(vidGps, vidGpsFel, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 30000,
  });
}

function stoppaGps() {
  if (s.watchId !== null) navigator.geolocation.clearWatch(s.watchId);
  s.watchId = null;
}

function vidGps(p) {
  if (s.simulera) return;
  const fix = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), t: Date.now() };
  if (!$('#vy-redo').hidden) bedomGps(fix.acc);
  nyPosition(fix);
}

function vidGpsFel(fel) {
  if (s.simulera) return;
  if (fel.code === fel.PERMISSION_DENIED) {
    s.watchId = null;
    if (!$('#vy-redo').hidden) visaGpsLage('nekad');
  } else if (fel.code !== fel.TIMEOUT && !s.fix && !$('#vy-redo').hidden) {
    visaGpsLage('ingen');
  }
  uppdateraBanderoll(fel.code === fel.PERMISSION_DENIED ? 'nekad' : null);
}

async function vidStart() {
  forberedLjud(); // ljud måste låsas upp av ett knapptryck, annars är iPhone tyst
  const knapp = $('#start-knapp');
  knapp.disabled = true;
  try {
    const { lage } = await rpc('elev_starta', { ...mig(), p_tid: Date.now() });
    s.lage = lage;
    startaLopp(true);
  } catch (fel) {
    if (fel.status === 409 || fel.status === 403 || fel.status === 404) return visaResultat('borta');
    visaFel($('#start-fel'), fel.message);
    knapp.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Under loppet
// ---------------------------------------------------------------------------

function startaLopp(nyStart) {
  visaVy('vy-lopp');
  const bana = s.omgang.bana;
  if (!s.karta) {
    s.karta = skapaKarta($('#lopp-karta'), bana.karttyp, { zoomControl: false });
    L.control.zoom({ position: 'topright' }).addTo(s.karta);
    s.banLager = new BanLager(s.karta);
    s.minPos = new MinPosition(s.karta);
    s.karta.on('click', (e) => {
      if (s.simulera) nyPosition({ lat: e.latlng.lat, lng: e.latlng.lng, acc: 5, t: Date.now(), sim: true });
    });
    s.karta.on('dragstart', () => satFolj(false));
  }
  s.karta.invalidateSize();
  s.banLager.visa(bana, s.lage);
  s.banLager.passaIn(50);
  ritaStampelkort();

  if (s.simulera) {
    stoppaGps();
    if (nyStart || !s.fix) nyPosition({ lat: bana.start.lat, lng: bana.start.lng, acc: 5, t: Date.now(), sim: true });
  } else {
    startaGps();
  }
  if (s.fix) s.minPos.visa(s.fix);

  rensaIntervaller();
  s.intervaller.push(setInterval(uppdateraHud, 500), setInterval(skicka, SKICKA_VAR_MS));
  hallSkarmenTand();
  uppdateraHud();
  uppdateraBanderoll();
  skicka();
}

function rensaIntervaller() {
  s.intervaller.forEach(clearInterval);
  s.intervaller = [];
}

function avslutaLokalt() {
  rensaIntervaller();
  stoppaGps();
  s.wakeLock?.release().catch(() => {});
  s.wakeLock = null;
}

function nastaMal() {
  const l = s.lage;
  if (!l || l.status !== 'springer') return null;
  const b = s.omgang.bana;
  return l.nastaIndex < b.kontroller.length ? b.kontroller[l.nastaIndex] : b.mal;
}

function nyPosition(fix) {
  s.fix = fix;
  if ($('#vy-lopp').hidden) return;
  s.minPos.visa(fix);
  if (s.folj) s.karta.panTo([fix.lat, fix.lng]);
  if (s.lage?.status === 'springer' && fix.acc <= 100) {
    s.ko.push(fix);
    if (s.ko.length > 5000) s.ko.splice(0, s.ko.length - 5000);
    // Nära nästa kontroll? Skicka direkt så att stämplingen känns omedelbar.
    const mal = nastaMal();
    if (mal && avstand(fix, mal) <= s.omgang.bana.radie + 5) skicka();
  }
  uppdateraHud();
  uppdateraBanderoll();
}

async function skicka() {
  if (s.skickar || s.lage?.status !== 'springer') return;
  if (s.ko.length === 0 && Date.now() - s.senastSkickat < LIVSTECKEN_MS) return;
  s.skickar = true;
  const parti = s.ko.slice(0, 300);
  try {
    const { lage } = await rpc('elev_positioner', { ...mig(), p_fixar: parti, p_lamnat_appen: s.lamnatAppen });
    s.ko.splice(0, parti.length);
    s.senastSkickat = Date.now();
    satOnline(true);
    hanteraLage(lage);
  } catch (fel) {
    if (fel.status === 403 || fel.status === 404) {
      avslutaLokalt();
      visaResultat('borta');
    } else {
      satOnline(false);
    }
  } finally {
    s.skickar = false;
  }
  if (s.ko.length > 0 && s.online) setTimeout(skicka, 200); // mer i kön efter en lång frånvaro
}

function satOnline(online) {
  if (s.online === online) return;
  s.online = online;
  uppdateraBanderoll();
}

function antalTagna() {
  const n = s.omgang.bana.kontroller.length;
  return s.lage.stamplingar.filter((x) => x.index < n).length;
}

function hanteraLage(nytt) {
  const gammalt = s.lage;
  const framsteg = (l) => l.stamplingar.length + l.overhoppade.length;
  if (gammalt && framsteg(nytt) < framsteg(gammalt)) return; // ett gammalt svar som kom fram sent

  s.lage = nytt;
  const nya = gammalt ? nytt.stamplingar.slice(gammalt.stamplingar.length) : [];
  s.banLager.visa(s.omgang.bana, nytt);
  ritaStampelkort(nya.map((x) => x.index));
  if (nya.length) firaStampling(nya[nya.length - 1]);
  uppdateraHud();

  if (nytt.status === 'klar') {
    avslutaLokalt();
    setTimeout(() => visaResultat(), nya.length ? 2600 : 0);
  } else if (nytt.status === 'avbrot' || nytt.omgangStatus === 'avslutad') {
    avslutaLokalt();
    visaResultat();
  }
}

function uppdateraHud() {
  const l = s.lage;
  if (!l) return;
  const bana = s.omgang.bana;
  if (l.startTid) $('#hud-tid').textContent = formateraTid((l.malTid ?? Date.now()) - l.startTid);
  const mal = nastaMal();
  if (!mal) {
    $('#hud-till').textContent = l.status === 'klar' ? 'I mål' : 'Loppet är slut';
    $('#hud-avstand').textContent = '–';
    return;
  }
  $('#hud-till').textContent = l.nastaIndex < bana.kontroller.length ? `Till kontroll ${l.nastaIndex + 1}` : 'Till mål';
  $('#hud-avstand').textContent = s.fix ? formateraAvstand(avstand(s.fix, mal)) : '–';
}

function uppdateraBanderoll(gpsFel = null) {
  let typ = null;
  let text = '';
  if (!s.online) {
    typ = 'offline';
    text = 'Ingen anslutning. Positionerna sparas och skickas när nätet är tillbaka.';
  } else if (gpsFel === 'nekad') {
    typ = 'offline';
    text = 'Platsåtkomst är avstängd. Slå på den i inställningarna och ladda om sidan.';
  } else if (s.simulera) {
    typ = 'test';
    text = 'Testläge: tryck på kartan för att flytta dig.';
  } else if (!s.fix) {
    typ = 'svag';
    text = 'Väntar på GPS-position …';
  } else if (s.fix.acc > GPS_REDO_M) {
    typ = 'svag';
    text = `Svag GPS-signal (±${s.fix.acc} m). Stämplingen väntar på bättre signal.`;
  }
  const el = $('#banderoll');
  el.hidden = !typ;
  el.dataset.typ = typ || '';
  el.textContent = text;
}

function satFolj(pa) {
  s.folj = pa;
  $('#folj-knapp').setAttribute('aria-pressed', String(pa));
  if (pa && s.fix) s.karta.setView([s.fix.lat, s.fix.lng], Math.max(s.karta.getZoom(), 17));
}

async function hallSkarmenTand() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !s.wakeLock) {
      s.wakeLock = await navigator.wakeLock.request('screen');
      s.wakeLock.addEventListener('release', () => {
        s.wakeLock = null;
      });
    }
  } catch {
    /* t.ex. strömsparläge – skärmen kan då släckas */
  }
}

// ---------------------------------------------------------------------------
// Stämpelkortet och stämpelögonblicket
// ---------------------------------------------------------------------------

/** Varje kontroll får ett eget hålmönster, som stiftstämplarna på gamla orienteringskontroller. */
function halmonster(index) {
  let x = ((index + 1) * 2654435761) >>> 0;
  const valda = new Set();
  while (valda.size < 5) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    valda.add(x % 9);
  }
  return [...valda];
}

function stansSvg(index, animera) {
  const hal = halmonster(index)
    .map((p, i) => `<circle cx="${8 + (p % 3) * 10}" cy="${8 + Math.floor(p / 3) * 10}" r="3.3" style="--i:${i}"/>`)
    .join('');
  return `<svg viewBox="0 0 36 36" class="stans${animera ? ' animera' : ''}" aria-hidden="true">${hal}</svg>`;
}

function ritaStampelkort(nyaIndex = []) {
  const l = s.lage;
  const n = s.omgang.bana.kontroller.length;
  const rutor = [];
  for (let i = 0; i <= n; i++) {
    const tagen = l.stamplingar.some((x) => x.index === i);
    const hoppad = l.overhoppade.includes(i);
    const nasta = l.status === 'springer' && l.nastaIndex === i;
    const namn = i === n ? 'Mål' : `Kontroll ${i + 1}`;
    const status = tagen ? 'stämplad' : hoppad ? 'överhoppad' : nasta ? 'nästa' : 'inte tagen';
    const klass = ['ruta', i === n && 'mal', tagen && 'tagen', hoppad && 'hoppad', nasta && 'nasta'].filter(Boolean).join(' ');
    rutor.push(
      `<li class="${klass}" aria-label="${namn}: ${status}"><span class="ruta-nr">${i === n ? 'Mål' : i + 1}</span>${
        tagen ? stansSvg(i, nyaIndex.includes(i)) : ''
      }</li>`
    );
  }
  $('#kort-rutor').innerHTML = rutor.join('');
  $('#kort-rutor .nasta')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function firaStampling(stampling) {
  const n = s.omgang.bana.kontroller.length;
  const arMal = stampling.index >= n;
  $('#stampel-ruta').innerHTML = `<div class="ruta${arMal ? ' mal' : ''}"><span class="ruta-nr">${
    arMal ? 'Mål' : stampling.index + 1
  }</span>${stansSvg(stampling.index, true)}</div>`;
  $('#stampel-rubrik').textContent = arMal ? 'I mål!' : `Kontroll ${stampling.index + 1}`;
  $('#stampel-tid').textContent = `Stämplad efter ${formateraTid(stampling.tid - s.lage.startTid)}`;
  const overlay = $('#stampel-overlay');
  overlay.hidden = false;
  const kort = overlay.firstElementChild;
  kort.style.animation = 'none';
  void kort.offsetHeight; // starta om animationen
  kort.style.animation = '';
  clearTimeout(s.overlayTimer);
  s.overlayTimer = setTimeout(() => (overlay.hidden = true), 2300);
  spelaLjud(arMal);
  navigator.vibrate?.(arMal ? [200, 80, 200, 80, 300] : [150, 60, 150]);
}

function forberedLjud() {
  try {
    s.ljud ??= new (window.AudioContext || window.webkitAudioContext)();
    s.ljud.resume?.();
  } catch {
    /* inget ljud */
  }
}

function spelaLjud(arMal) {
  const ctx = s.ljud;
  if (!ctx) return;
  const toner = arMal ? [880, 1175, 1568] : [1318, 1760];
  toner.forEach((frekvens, i) => {
    const osc = ctx.createOscillator();
    const volym = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = frekvens;
    const start = ctx.currentTime + i * 0.13;
    volym.gain.setValueAtTime(0.0001, start);
    volym.gain.exponentialRampToValueAtTime(0.2, start + 0.01);
    volym.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
    osc.connect(volym).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.12);
  });
}

// ---------------------------------------------------------------------------
// Meny: hoppa över och avsluta
// ---------------------------------------------------------------------------

function oppnaMeny() {
  const l = s.lage;
  const n = s.omgang.bana.kontroller.length;
  const knapp = $('#hoppa-knapp');
  const kanHoppa = l?.status === 'springer' && l.nastaIndex < n;
  knapp.hidden = !kanHoppa;
  knapp.nextElementSibling.hidden = !kanHoppa;
  if (kanHoppa) knapp.textContent = `Hoppa över kontroll ${l.nastaIndex + 1}`;
  $('#meny').showModal();
}

function hoppaOver() {
  const nummer = s.lage.nastaIndex + 1;
  if (!confirm(`Hoppa över kontroll ${nummer}? Du kan inte ta den senare.`)) return;
  medSparr($('#hoppa-knapp'), async () => {
    try {
      const { lage } = await rpc('elev_hoppa_over', mig());
      $('#meny').close();
      hanteraLage(lage);
    } catch (fel) {
      alert(fel.message);
    }
  });
}

function avbrytLopp() {
  if (!confirm('Vill du avsluta loppet? Du kan inte fortsätta efteråt.')) return;
  medSparr($('#avbryt-knapp'), async () => {
    try {
      await skicka(); // skicka sista positionerna först
      const { lage } = await rpc('elev_avbryt', mig());
      $('#meny').close();
      hanteraLage(lage);
    } catch (fel) {
      alert(fel.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Resultat
// ---------------------------------------------------------------------------

function visaResultat(orsak) {
  avslutaLokalt();
  $('#stampel-overlay').hidden = true;
  if ($('#meny').open) $('#meny').close();

  if (orsak === 'borta' || !s.lage) {
    $('#klar-rubrik').textContent = 'Omgången är slut';
    $('#klar-tid').hidden = true;
    $('#klar-fakta').textContent = 'Läraren har avslutat eller tagit bort omgången.';
    $('#klar-strackor').innerHTML = '';
    rensaSession();
    return visaVy('vy-klar');
  }

  const l = s.lage;
  const n = s.omgang.bana.kontroller.length;
  const tagna = antalTagna();
  const rubriker = { klar: 'I mål!', avbrot: 'Du avslutade loppet' };
  $('#klar-rubrik').textContent = rubriker[l.status] || 'Omgången är avslutad';
  $('#klar-tid').hidden = l.status !== 'klar';
  $('#klar-tid').textContent = l.status === 'klar' ? formateraTid(l.malTid - l.startTid) : '';

  const delar = [];
  if (l.status !== 'klar' && l.status !== 'avbrot') delar.push('Läraren har avslutat omgången.');
  delar.push(`Du tog ${tagna} av ${n} kontroller.`);
  if (l.overhoppade.length) delar.push(`Överhoppade: ${l.overhoppade.map((i) => i + 1).join(', ')}.`);
  $('#klar-fakta').textContent = delar.join(' ');

  const rader = strackor(n, l.startTid, l.stamplingar);
  $('#klar-strackor').innerHTML = rader.length
    ? `<caption class="hjalptext" style="text-align:left">Sträcktider</caption>
       <thead><tr><th>Sträcka</th><th class="tal">Tid</th><th class="tal">Totalt</th></tr></thead>
       <tbody>${rader
         .map((r) => `<tr><td>${esc(r.fran)}–${esc(r.till)}</td><td class="tal">${formateraTid(r.strack)}</td><td class="tal">${formateraTid(r.total)}</td></tr>`)
         .join('')}</tbody>`
    : '';
  rensaSession();
  visaVy('vy-klar');
}

init();
