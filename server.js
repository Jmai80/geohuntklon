// Stämpla – prototypserver för digital orientering.
// Kör med:  npm start   (eller: node server.js)
// Inga beroenden behövs, bara Node.js 18 eller nyare.

import http from 'node:http';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { avstand } from './public/js/geo.js';

// ---------------------------------------------------------------------------
// Inställningar
// ---------------------------------------------------------------------------

const ROT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROT, 'public');
const DATAMAPP = process.env.DATAMAPP || path.join(ROT, 'data');
const DBFIL = path.join(DATAMAPP, 'db.json');
const PORT = Number(process.env.PORT) || 3000;

// Sätt t.ex. LARARLOSEN=hemligt för att skydda lärarsidan med ett lösenord.
const LARARLOSEN = process.env.LARARLOSEN || '';

// En GPS-position med sämre noggrannhet än så här får inte stämpla.
const MAX_NOGGRANNHET_STAMPLING_M = 30;
// Positioner sämre än så här sparas inte i elevens rutt.
const MAX_NOGGRANNHET_RUTT_M = 50;
// Spara högst en ruttpunkt per så här många millisekunder.
const RUTT_INTERVALL_MS = 2000;

// ---------------------------------------------------------------------------
// Lagring: allt hålls i minnet och sparas till data/db.json
// ---------------------------------------------------------------------------

let db = { banor: {}, omgangar: {} };

async function laddaDb() {
  try {
    db = JSON.parse(await readFile(DBFIL, 'utf8'));
    db.banor ??= {};
    db.omgangar ??= {};
  } catch (fel) {
    if (fel.code !== 'ENOENT') {
      console.error(`Kunde inte läsa ${DBFIL}: ${fel.message}`);
      process.exit(1);
    }
  }
}

let sparTimer = null;
let skrivko = Promise.resolve();

/** Sparar inom en sekund. Flera ändringar i rad blir en enda skrivning. */
function sparaSnart() {
  if (!sparTimer) sparTimer = setTimeout(sparaNu, 1000);
}

function sparaNu() {
  clearTimeout(sparTimer);
  sparTimer = null;
  skrivko = skrivko
    .then(async () => {
      await mkdir(DATAMAPP, { recursive: true });
      const tmp = `${DBFIL}.tmp`;
      await writeFile(tmp, JSON.stringify(db));
      await rename(tmp, DBFIL); // byt fil i ett steg så att den aldrig blir halvskriven
    })
    .catch((fel) => console.error('Kunde inte spara data:', fel.message));
  return skrivko;
}

// ---------------------------------------------------------------------------
// Hjälpfunktioner
// ---------------------------------------------------------------------------

class Fel extends Error {
  constructor(status, meddelande) {
    super(meddelande);
    this.status = status;
  }
}

const nyttId = (prefix) => prefix + crypto.randomBytes(6).toString('hex');
const nuIso = () => new Date().toISOString();

function nyPin() {
  for (;;) {
    const pin = String(crypto.randomInt(100000, 1000000));
    const upptagen = Object.values(db.omgangar).some((o) => o.pin === pin && o.status === 'aktiv');
    if (!upptagen) return pin;
  }
}

function text(varde, maxLangd, falt) {
  const s = String(varde ?? '').trim().replace(/\s+/g, ' ');
  if (!s) throw new Fel(400, `${falt} saknas.`);
  return s.slice(0, maxLangd);
}

function punkt(p, falt) {
  const lat = Number(p?.lat);
  const lng = Number(p?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Fel(400, `${falt} har ogiltiga koordinater.`);
  }
  return { lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)) };
}

function tolkaBana(b) {
  if (!b.start) throw new Fel(400, 'Banan behöver en start.');
  if (!Array.isArray(b.kontroller) || b.kontroller.length === 0) {
    throw new Fel(400, 'Banan behöver minst en kontroll.');
  }
  if (b.kontroller.length > 60) throw new Fel(400, 'En bana kan ha högst 60 kontroller.');
  if (!b.mal) throw new Fel(400, 'Banan behöver ett mål.');
  return {
    namn: text(b.namn, 60, 'Banans namn'),
    karttyp: b.karttyp === 'terrang' ? 'terrang' : 'gata',
    radie: Math.min(50, Math.max(5, Math.round(Number(b.radie) || 10))),
    start: punkt(b.start, 'Starten'),
    kontroller: b.kontroller.map((k, i) => punkt(k, `Kontroll ${i + 1}`)),
    mal: punkt(b.mal, 'Målet'),
  };
}

function hamtaBana(id) {
  const bana = db.banor[id];
  if (!bana) throw new Fel(404, 'Banan finns inte.');
  return bana;
}

function hamtaOmgang(id) {
  const omgang = db.omgangar[id];
  if (!omgang) throw new Fel(404, 'Omgången finns inte.');
  return omgang;
}

function hamtaDeltagare(params, token) {
  const omgang = hamtaOmgang(params.id);
  const d = omgang.deltagare[params.did];
  if (!d || typeof token !== 'string' || token !== d.token) throw new Fel(403, 'Okänd deltagare.');
  return { omgang, d };
}

// Det eleven får veta om omgången. Lärarens uppgifter och andras data skickas inte.
function elevOmgang(o) {
  const { namn, karttyp, radie, start, kontroller, mal } = o.bana;
  return {
    id: o.id,
    namn: o.namn,
    status: o.status,
    testlage: o.testlage,
    bana: { namn, karttyp, radie, start, kontroller, mal },
  };
}

function elevLage(o, d) {
  return {
    status: d.status,
    omgangStatus: o.status,
    nastaIndex: d.nastaIndex,
    stamplingar: d.stamplingar.map(({ index, tid }) => ({ index, tid })),
    overhoppade: d.overhoppade,
    startTid: d.startTid,
    malTid: d.malTid,
    simulerad: d.simulerad,
  };
}

function omgangSammanfattning(o) {
  const alla = Object.values(o.deltagare);
  return {
    id: o.id,
    pin: o.pin,
    namn: o.namn,
    banaId: o.banaId,
    banaNamn: o.bana.namn,
    antalKontroller: o.bana.kontroller.length,
    testlage: o.testlage,
    status: o.status,
    startad: o.startad,
    avslutad: o.avslutad,
    antalDeltagare: alla.length,
    antalIMal: alla.filter((d) => d.status === 'klar').length,
  };
}

function lararDeltagare(d) {
  const { token, spar, ...synligt } = d; // token och hela rutten skickas inte här
  return { ...synligt, antalRuttpunkter: spar.length };
}

// ---------------------------------------------------------------------------
// Stämpling – servern bestämmer när en kontroll är tagen, inte mobilen
// ---------------------------------------------------------------------------

function behandlaPosition(omgang, d, fix) {
  const lat = Number(fix?.lat);
  const lng = Number(fix?.lng);
  const acc = Number(fix?.acc);
  const t = Number(fix?.t);
  if (![lat, lng, acc, t].every(Number.isFinite)) return;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || acc < 0) return;
  if (t <= d.senasteFixTid || t < d.startTid) return; // dubblett eller före start

  const simulerad = fix.sim === true;
  if (simulerad && !omgang.testlage) return; // simulerad GPS bara i testomgångar
  if (simulerad) d.simulerad = true;

  d.senasteFixTid = t;
  d.position = { lat, lng, acc: Math.round(acc), t, mottagen: Date.now() };

  const sista = d.spar[d.spar.length - 1];
  if (acc <= MAX_NOGGRANNHET_RUTT_M && (!sista || t - sista[2] >= RUTT_INTERVALL_MS)) {
    d.spar.push([Number(lat.toFixed(6)), Number(lng.toFixed(6)), t]);
  }

  if (d.status !== 'springer' || acc > MAX_NOGGRANNHET_STAMPLING_M) return;

  const bana = omgang.bana;
  const malIndex = bana.kontroller.length;
  const mal = d.nastaIndex < malIndex ? bana.kontroller[d.nastaIndex] : bana.mal;
  const avstandTillMal = avstand({ lat, lng }, mal);
  if (avstandTillMal > bana.radie) return;

  d.stamplingar.push({ index: d.nastaIndex, tid: t, avstand: Math.round(avstandTillMal), noggrannhet: Math.round(acc) });
  if (d.nastaIndex >= malIndex) {
    d.status = 'klar';
    d.malTid = t;
  } else {
    d.nastaIndex += 1;
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const rutter = [];

function rutt(metod, monster, hanterare) {
  const nycklar = [];
  const re = new RegExp(
    '^' + monster.replace(/:(\w+)/g, (_, nyckel) => (nycklar.push(nyckel), '([^/]+)')) + '$'
  );
  rutter.push({ metod, re, nycklar, hanterare });
}

// ----- Lärare -----

rutt('GET', '/api/larare/kontroll', () => ({ ok: true }));

rutt('GET', '/api/larare/banor', () => ({
  banor: Object.values(db.banor).sort((a, b) => b.andrad.localeCompare(a.andrad)),
}));

rutt('GET', '/api/larare/banor/:id', ({ params }) => ({ bana: hamtaBana(params.id) }));

rutt('POST', '/api/larare/banor', ({ body }) => {
  const bana = { id: nyttId('b'), ...tolkaBana(body), skapad: nuIso(), andrad: nuIso() };
  db.banor[bana.id] = bana;
  sparaSnart();
  return { bana };
});

rutt('PUT', '/api/larare/banor/:id', ({ params, body }) => {
  const bana = { ...hamtaBana(params.id), ...tolkaBana(body), andrad: nuIso() };
  db.banor[bana.id] = bana;
  sparaSnart();
  return { bana };
});

rutt('DELETE', '/api/larare/banor/:id', ({ params }) => {
  hamtaBana(params.id);
  delete db.banor[params.id];
  sparaSnart();
  return { ok: true };
});

rutt('GET', '/api/larare/omgangar', () => ({
  omgangar: Object.values(db.omgangar)
    .map(omgangSammanfattning)
    .sort((a, b) => b.startad.localeCompare(a.startad)),
}));

rutt('POST', '/api/larare/omgangar', ({ body }) => {
  const bana = hamtaBana(body.banaId);
  const omgang = {
    id: nyttId('o'),
    pin: nyPin(),
    namn: text(body.namn || bana.namn, 40, 'Omgångens namn'),
    banaId: bana.id,
    bana: structuredClone(bana), // kopia: ändringar i banan påverkar inte en pågående omgång
    testlage: body.testlage === true,
    status: 'aktiv',
    startad: nuIso(),
    avslutad: null,
    deltagare: {},
  };
  db.omgangar[omgang.id] = omgang;
  sparaSnart();
  return { omgang: omgangSammanfattning(omgang) };
});

rutt('GET', '/api/larare/omgangar/:id', ({ params }) => {
  const o = hamtaOmgang(params.id);
  return {
    nu: Date.now(),
    omgang: {
      ...omgangSammanfattning(o),
      bana: o.bana,
      deltagare: Object.values(o.deltagare).map(lararDeltagare),
    },
  };
});

rutt('GET', '/api/larare/omgangar/:id/rutt/:did', ({ params }) => {
  const d = hamtaOmgang(params.id).deltagare[params.did];
  if (!d) throw new Fel(404, 'Eleven finns inte i omgången.');
  return { rutt: d.spar };
});

rutt('POST', '/api/larare/omgangar/:id/avsluta', ({ params }) => {
  const o = hamtaOmgang(params.id);
  if (o.status === 'aktiv') {
    o.status = 'avslutad';
    o.avslutad = nuIso();
    sparaSnart();
  }
  return { omgang: omgangSammanfattning(o) };
});

rutt('DELETE', '/api/larare/omgangar/:id', ({ params }) => {
  hamtaOmgang(params.id);
  delete db.omgangar[params.id];
  sparaSnart();
  return { ok: true };
});

// ----- Elev -----

rutt('GET', '/api/elev/pin/:pin', ({ params }) => {
  const o = Object.values(db.omgangar).find((x) => x.pin === params.pin && x.status === 'aktiv');
  if (!o) throw new Fel(404, 'Det finns ingen pågående omgång med den PIN-koden. Kolla siffrorna med din lärare.');
  return { omgang: elevOmgang(o) };
});

rutt('POST', '/api/elev/omgangar/:id/deltagare', ({ params, body }) => {
  const o = hamtaOmgang(params.id);
  if (o.status !== 'aktiv') throw new Fel(409, 'Omgången är avslutad.');
  if (Object.keys(o.deltagare).length >= 500) throw new Fel(429, 'Omgången är full.');
  const d = {
    id: nyttId('d'),
    token: crypto.randomBytes(16).toString('hex'),
    namn: text(body.namn, 40, 'Namn'),
    status: 'vantar', // vantar -> springer -> klar / avbrot
    simulerad: false,
    startTid: null, // elevens klocka (ms) när hen tryckte Starta
    startMottagen: null, // serverns klocka när starten kom fram
    malTid: null,
    nastaIndex: 0, // nästa kontroll att ta; lika med antalet kontroller betyder mål
    stamplingar: [],
    overhoppade: [],
    position: null,
    senasteFixTid: 0,
    spar: [],
    senastSedd: Date.now(),
  };
  o.deltagare[d.id] = d;
  sparaSnart();
  return { deltagareId: d.id, token: d.token, omgang: elevOmgang(o), lage: elevLage(o, d) };
});

rutt('GET', '/api/elev/omgangar/:id/deltagare/:did', ({ params, query }) => {
  const { omgang, d } = hamtaDeltagare(params, query.get('token'));
  d.senastSedd = Date.now();
  return { omgang: elevOmgang(omgang), lage: elevLage(omgang, d) };
});

rutt('POST', '/api/elev/omgangar/:id/deltagare/:did/start', ({ params, body }) => {
  const { omgang, d } = hamtaDeltagare(params, body.token);
  if (omgang.status !== 'aktiv') throw new Fel(409, 'Omgången är avslutad.');
  if (d.status === 'vantar') {
    const tid = Number(body.tid);
    d.status = 'springer';
    d.startTid = Number.isFinite(tid) ? tid : Date.now();
    d.startMottagen = Date.now();
    d.senastSedd = Date.now();
    sparaSnart();
  }
  return { lage: elevLage(omgang, d) };
});

rutt('POST', '/api/elev/omgangar/:id/deltagare/:did/positioner', ({ params, body }) => {
  const { omgang, d } = hamtaDeltagare(params, body.token);
  d.senastSedd = Date.now();
  if (Number.isFinite(body.lamnatAppen)) d.lamnatAppen = Math.max(0, Math.min(9999, Math.round(body.lamnatAppen)));
  if (omgang.status === 'aktiv' && d.status === 'springer' && Array.isArray(body.fixar)) {
    for (const fix of body.fixar.slice(0, 500)) behandlaPosition(omgang, d, fix);
  }
  sparaSnart();
  return { lage: elevLage(omgang, d) };
});

rutt('POST', '/api/elev/omgangar/:id/deltagare/:did/hoppa-over', ({ params, body }) => {
  const { omgang, d } = hamtaDeltagare(params, body.token);
  if (omgang.status === 'aktiv' && d.status === 'springer' && d.nastaIndex < omgang.bana.kontroller.length) {
    d.overhoppade.push(d.nastaIndex);
    d.nastaIndex += 1;
    sparaSnart();
  }
  return { lage: elevLage(omgang, d) };
});

rutt('POST', '/api/elev/omgangar/:id/deltagare/:did/avbryt', ({ params, body }) => {
  const { omgang, d } = hamtaDeltagare(params, body.token);
  if (d.status === 'springer' || d.status === 'vantar') {
    d.status = 'avbrot';
    sparaSnart();
  }
  return { lage: elevLage(omgang, d) };
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function kravLararlosen(req) {
  if (!LARARLOSEN) return;
  const givet = Buffer.from(String(req.headers['x-lararlosen'] || ''));
  const ratt = Buffer.from(LARARLOSEN);
  if (givet.length !== ratt.length || !crypto.timingSafeEqual(givet, ratt)) {
    throw new Fel(401, 'Fel lärarlösenord.');
  }
}

async function lasJson(req) {
  const delar = [];
  let storlek = 0;
  for await (const del of req) {
    storlek += del.length;
    if (storlek > 2_000_000) throw new Fel(413, 'Förfrågan är för stor.');
    delar.push(del);
  }
  if (delar.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(delar).toString('utf8')) ?? {};
  } catch {
    throw new Fel(400, 'Ogiltig JSON.');
  }
}

function skickaJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

async function hanteraApi(req, res, url) {
  for (const r of rutter) {
    if (r.metod !== req.method) continue;
    const traff = url.pathname.match(r.re);
    if (!traff) continue;
    const params = Object.fromEntries(r.nycklar.map((k, i) => [k, decodeURIComponent(traff[i + 1])]));
    if (url.pathname.startsWith('/api/larare/')) kravLararlosen(req);
    const body = req.method === 'POST' || req.method === 'PUT' ? await lasJson(req) : {};
    const svar = await r.hanterare({ params, body, query: url.searchParams, req });
    return skickaJson(res, 200, svar);
  }
  throw new Fel(404, 'Det finns inget sådant API-anrop.');
}

const FILTYPER = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveraFil(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new Fel(405, 'Metoden stöds inte.');
  let relativ = decodeURIComponent(url.pathname);
  if (relativ.endsWith('/')) relativ += 'index.html';
  const fil = path.normalize(path.join(PUBLIC, relativ));
  if (!fil.startsWith(PUBLIC + path.sep)) throw new Fel(403, 'Förbjudet.');

  let info;
  try {
    info = await stat(fil);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Sidan finns inte.');
  }
  if (info.isDirectory()) {
    res.writeHead(301, { Location: url.pathname + '/' });
    return res.end();
  }
  const langCache = relativ.startsWith('/vendor/') || relativ.startsWith('/fonts/');
  res.writeHead(200, {
    'Content-Type': FILTYPER[path.extname(fil).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': langCache ? 'public, max-age=604800' : 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(fil).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await hanteraApi(req, res, url);
    else await serveraFil(req, res, url);
  } catch (fel) {
    const status = fel instanceof Fel ? fel.status : fel instanceof URIError ? 400 : 500;
    if (status === 500) console.error(fel);
    if (!res.headersSent) {
      skickaJson(res, status, { fel: status === 500 ? 'Något gick fel på servern.' : fel.message });
    } else {
      res.end();
    }
  }
});

function lokalaAdresser() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

server.on('error', (fel) => {
  if (fel.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} används redan. Stäng den andra servern, eller starta på en annan port:`);
    console.error(`  PORT=3001 npm start\n`);
    process.exit(1);
  }
  throw fel;
});

async function stang() {
  console.log('\nSparar och stänger …');
  await sparaNu();
  process.exit(0);
}
process.on('SIGINT', stang);
process.on('SIGTERM', stang);

await laddaDb();
server.listen(PORT, () => {
  const rad = (etikett, adress) => console.log(`  ${etikett.padEnd(10)} ${adress}`);
  console.log('\nStämpla är igång.\n');
  rad('Elev:', `http://localhost:${PORT}`);
  rad('Lärare:', `http://localhost:${PORT}/larare.html`);
  for (const ip of lokalaAdresser()) rad('Nätverk:', `http://${ip}:${PORT}`);
  console.log('\n  Mobiler får bara använda GPS via https. Se README.md, avsnittet om att testa ute.');
  if (LARARLOSEN) console.log('  Lärarsidan är skyddad med lösenord (LARARLOSEN).');
  console.log('  Stoppa servern med Ctrl+C.\n');
});
