// Lärarens sida: rita banor, starta omgångar och följa klassen live.

import { banlangd, formateraTid, formateraAvstand, punktNamn, strackor } from './geo.js';
import { $, api as grundApi, esc, visaVy, visaFel, tidSedan, klockslag } from './hjalp.js';
import { BanLager, MinPosition, skapaKarta, satKarttyp, MIN_BLA } from './kartlager.js';

const LOSEN_NYCKEL = 'stampla-lararlosen';
const KARTVY_NYCKEL = 'stampla-kartvy';
const UPPDATERA_MS = 2000;

// ---------------------------------------------------------------------------
// API med lärarlösenord (används bara om servern startats med LARARLOSEN)
// ---------------------------------------------------------------------------

function lasLokalt(nyckel) {
  try {
    return localStorage.getItem(nyckel);
  } catch {
    return null;
  }
}

function sparaLokalt(nyckel, varde) {
  try {
    localStorage.setItem(nyckel, varde);
  } catch {
    /* privat läge */
  }
}

let losenFraga = null;

function fragaLosen(felText) {
  losenFraga ??= new Promise((resolve) => {
    const dialog = $('#losen-dialog');
    visaFel($('#losen-fel'), felText);
    $('#losen').value = '';
    dialog.oncancel = (e) => e.preventDefault();
    $('#losen-form').onsubmit = (e) => {
      e.preventDefault();
      sparaLokalt(LOSEN_NYCKEL, $('#losen').value);
      dialog.close();
      resolve();
    };
    dialog.showModal();
  }).finally(() => {
    losenFraga = null;
  });
  return losenFraga;
}

async function api(metod, url, body) {
  for (;;) {
    const losen = lasLokalt(LOSEN_NYCKEL) || '';
    try {
      return await grundApi(metod, url, body, losen ? { 'x-lararlosen': losen } : {});
    } catch (fel) {
      if (fel.status !== 401) throw fel;
      await fragaLosen(losen ? 'Fel lösenord. Försök igen.' : '');
    }
  }
}

// ---------------------------------------------------------------------------
// Navigering mellan vyerna (#/, #/bana/ny, #/bana/:id, #/omgang/:id)
// ---------------------------------------------------------------------------

let aktuellVy = null;
let navigering = 0;

async function navigera() {
  aktuellVy?.lamna?.();
  aktuellVy = null;
  const mitt = ++navigering;
  const hash = location.hash || '#/';
  let traff;
  let vy;
  if ((traff = hash.match(/^#\/bana\/([\w-]+)$/))) vy = await visaRedigera(traff[1] === 'ny' ? null : traff[1], mitt);
  else if ((traff = hash.match(/^#\/omgang\/([\w-]+)$/))) vy = await visaOmgang(traff[1], mitt);
  else vy = await visaHem();
  if (mitt === navigering) aktuellVy = vy;
  else vy?.lamna?.();
}

function datumText(iso) {
  const d = new Date(iso);
  const idag = new Date().toDateString() === d.toDateString();
  return idag ? `i dag ${klockslag(d)}` : `${d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' })} ${klockslag(d)}`;
}

const formateraPin = (pin) => `${pin.slice(0, 3)} ${pin.slice(3)}`;

// ---------------------------------------------------------------------------
// Start: banor och omgångar
// ---------------------------------------------------------------------------

const IKON_START = '<svg width="18" height="18" viewBox="-9 -9 18 18"><polygon points="0,-7 6,3.5 -6,3.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const IKON_KONTROLL = '<svg width="16" height="16" viewBox="-8 -8 16 16"><circle r="6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const IKON_MAL = '<svg width="18" height="18" viewBox="-9 -9 18 18"><circle r="7.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle r="4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';

function banremsa(bana) {
  const antal = bana.kontroller.length;
  const visas = Math.min(antal, 6);
  const fler = antal > visas ? `<span class="fler">+${antal - visas}</span>` : '';
  return `<div class="banremsa" aria-hidden="true">${IKON_START}${IKON_KONTROLL.repeat(visas)}${fler}${IKON_MAL}</div>`;
}

let hemBanor = [];

async function visaHem() {
  visaVy('vy-hem');
  document.title = 'Stämpla – lärare';
  try {
    const [{ banor }, { omgangar }] = await Promise.all([api('GET', '/api/larare/banor'), api('GET', '/api/larare/omgangar')]);
    hemBanor = banor;
    ritaHem(banor, omgangar);
  } catch (fel) {
    $('#ban-lista').innerHTML = `<li><p class="felruta">${esc(fel.message)}</p></li>`;
  }
  return null;
}

function ritaHem(banor, omgangar) {
  $('#ban-lista').innerHTML = banor
    .map(
      (b) => `<li>
        ${banremsa(b)}
        <div class="info">
          <div class="namn">${esc(b.namn)}</div>
          <div class="detalj">${b.kontroller.length} ${b.kontroller.length === 1 ? 'kontroll' : 'kontroller'}, ${formateraAvstand(banlangd(b))}, ${
            b.karttyp === 'terrang' ? 'terrängkarta' : 'gatukarta'
          }, stämpling inom ${b.radie} m</div>
        </div>
        <div class="atgarder">
          <button class="knapp primar liten-knapp" type="button" data-starta="${b.id}">Starta omgång</button>
          <a class="knapp liten-knapp" href="#/bana/${b.id}">Ändra</a>
          <button class="knapp fara liten-knapp" type="button" data-ta-bort-bana="${b.id}">Ta bort</button>
        </div>
      </li>`
    )
    .join('');
  $('#ban-tomt').hidden = banor.length > 0;

  const omgangRad = (o) => {
    const aktiv = o.status === 'aktiv';
    return `<li>
      <div class="info">
        <div class="namn">${esc(o.namn)} ${o.testlage ? '<span class="chip test">Test</span>' : ''}</div>
        <div class="detalj">${esc(o.banaNamn)}. ${o.antalDeltagare} med, ${o.antalIMal} i mål. Startad ${datumText(o.startad)}.</div>
      </div>
      ${aktiv ? `<span class="pin-liten siffror" title="PIN-kod">${formateraPin(o.pin)}</span>` : ''}
      <div class="atgarder">
        <a class="knapp ${aktiv ? 'primar' : ''} liten-knapp" href="#/omgang/${o.id}">${aktiv ? 'Följ live' : 'Visa resultat'}</a>
        ${aktiv ? '' : `<button class="knapp fara liten-knapp" type="button" data-ta-bort-omgang="${o.id}">Ta bort</button>`}
      </div>
    </li>`;
  };
  const pagaende = omgangar.filter((o) => o.status === 'aktiv');
  const avslutade = omgangar.filter((o) => o.status !== 'aktiv');
  $('#pagaende-lista').innerHTML = pagaende.map(omgangRad).join('');
  $('#pagaende-sektion').hidden = pagaende.length === 0;
  $('#avslutade-lista').innerHTML = avslutade.map(omgangRad).join('');
  $('#avslutade-sektion').hidden = avslutade.length === 0;
}

$('#vy-hem').addEventListener('click', async (e) => {
  const starta = e.target.closest('[data-starta]');
  const taBortBana = e.target.closest('[data-ta-bort-bana]');
  const taBortOmgang = e.target.closest('[data-ta-bort-omgang]');
  try {
    if (starta) {
      oppnaStartDialog(hemBanor.find((b) => b.id === starta.dataset.starta));
    } else if (taBortBana) {
      const bana = hemBanor.find((b) => b.id === taBortBana.dataset.taBortBana);
      if (!confirm(`Ta bort banan "${bana.namn}"? Det går inte att ångra. Avslutade omgångar och deras resultat finns kvar.`)) return;
      await api('DELETE', `/api/larare/banor/${bana.id}`);
      visaHem();
    } else if (taBortOmgang) {
      if (!confirm('Ta bort omgången och alla elevers resultat och rutter? Det går inte att ångra.')) return;
      await api('DELETE', `/api/larare/omgangar/${taBortOmgang.dataset.taBortOmgang}`);
      visaHem();
    }
  } catch (fel) {
    alert(fel.message);
  }
});

function oppnaStartDialog(bana) {
  const dialog = $('#start-dialog');
  $('#start-bana').textContent = `${bana.namn}, ${bana.kontroller.length} kontroller.`;
  $('#start-namn').value = '';
  $('#start-test').checked = false;
  visaFel($('#start-fel'), '');
  $('#start-form').onsubmit = async (e) => {
    if (e.submitter?.value !== 'ok') return; // Avbryt stänger dialogen
    e.preventDefault();
    const knapp = $('#start-ok');
    knapp.disabled = true;
    try {
      const { omgang } = await api('POST', '/api/larare/omgangar', {
        banaId: bana.id,
        namn: $('#start-namn').value.trim() || bana.namn,
        testlage: $('#start-test').checked,
      });
      dialog.close();
      location.hash = `#/omgang/${omgang.id}`;
    } catch (fel) {
      visaFel($('#start-fel'), fel.message);
    } finally {
      knapp.disabled = false;
    }
  };
  dialog.showModal();
  $('#start-namn').focus();
}

// ---------------------------------------------------------------------------
// Rita eller ändra en bana
// ---------------------------------------------------------------------------

async function visaRedigera(id, mitt) {
  visaVy('vy-redigera');
  let bana = { namn: '', karttyp: 'gata', radie: 10, start: null, kontroller: [], mal: null };
  if (id) {
    try {
      bana = structuredClone((await api('GET', `/api/larare/banor/${id}`)).bana);
    } catch (fel) {
      alert(fel.message);
      location.hash = '#/';
      return null;
    }
  }
  if (mitt !== navigering) return null;
  document.title = `${id ? 'Ändra' : 'Ny'} bana – Stämpla`;

  $('#red-rubrik').textContent = id ? 'Ändra bana' : 'Ny bana';
  $('#red-namn').value = bana.namn;
  $(`input[name=karttyp][value=${bana.karttyp}]`).checked = true;
  const radieVal = $('#red-radie');
  if (![...radieVal.options].some((o) => Number(o.value) === bana.radie)) radieVal.add(new Option(`${bana.radie} meter`, bana.radie));
  radieVal.value = String(bana.radie);
  visaFel($('#red-fel'), '');
  $('#sok-traffar').innerHTML = '';
  $('#red-har').hidden = true;

  const karta = skapaKarta($('#red-karta'), bana.karttyp);
  const minPos = new MinPosition(karta);
  const historik = [];
  let gpsWatch = null;
  let minSenaste = null;

  const banLager = new BanLager(karta, {
    redigerbar: true,
    vidFlyttStart: () => sparaHistorik(),
    vidFlytt: (typ, index, pos) => {
      if (typ === 'start') bana.start = pos;
      else if (typ === 'mal') bana.mal = pos;
      else bana.kontroller[index] = pos;
      rita();
    },
    vidKlick: visaPunktMeny,
  });

  // Var ska kartan börja? Banans punkter, annars där läraren senast tittade, annars hela Sverige.
  if (bana.start || bana.kontroller.length || bana.mal) {
    banLager.visa(bana);
    banLager.passaIn(60);
  } else {
    let vy = null;
    try {
      vy = JSON.parse(lasLokalt(KARTVY_NYCKEL));
    } catch {
      /* ingen sparad vy */
    }
    if (vy?.lat) karta.setView([vy.lat, vy.lng], vy.zoom);
    else karta.setView([62.5, 16], 5);
  }
  karta.on('moveend', () => {
    const c = karta.getCenter();
    sparaLokalt(KARTVY_NYCKEL, JSON.stringify({ lat: c.lat, lng: c.lng, zoom: karta.getZoom() }));
  });

  // Sparar läget före en ändring så att den kan ångras. Vid drag sparas det redan när draget börjar.
  function sparaHistorik() {
    historik.push(structuredClone({ start: bana.start, kontroller: bana.kontroller, mal: bana.mal }));
    if (historik.length > 100) historik.shift();
  }

  const valtVerktyg = () => document.querySelector('input[name=verktyg]:checked')?.value || 'kontroll';
  const valjVerktyg = (typ) => {
    document.querySelector(`input[name=verktyg][value=${typ}]`).checked = true;
    ritaTips();
  };

  function ritaTips() {
    const typ = valtVerktyg();
    const text = {
      start: bana.start ? 'Klicka på kartan för att flytta starten.' : 'Klicka på kartan där starten ska vara.',
      kontroll: `Klicka på kartan för att sätta ut kontroll ${bana.kontroller.length + 1}.`,
      mal: bana.mal ? 'Klicka på kartan för att flytta målet.' : 'Klicka på kartan där målet ska vara.',
    }[typ];
    $('#red-tips').textContent = `${text} Dra i en punkt för att flytta den, eller klicka på den för att ta bort den.`;
  }

  function ritaSumma() {
    const saknas = [];
    if (!bana.start) saknas.push('start');
    if (!bana.kontroller.length) saknas.push('minst en kontroll');
    if (!bana.mal) saknas.push('mål');
    const antal = bana.kontroller.length;
    $('#red-summa').innerHTML = `<p><strong>${antal} ${antal === 1 ? 'kontroll' : 'kontroller'}</strong>${
      saknas.length ? '' : `, ${formateraAvstand(banlangd(bana))} fågelvägen`
    }</p>${saknas.length ? `<p class="hjalptext">Banan behöver ${saknas.join(', ').replace(/, ([^,]*)$/, ' och $1')}.</p>` : ''}`;
  }

  function rita() {
    banLager.visa(bana);
    ritaSumma();
    ritaTips();
    $('#red-angra').disabled = historik.length === 0;
  }

  function laggTill(typ, pos) {
    sparaHistorik();
    if (typ === 'start') {
      bana.start = pos;
      valjVerktyg('kontroll');
    } else if (typ === 'mal') {
      bana.mal = pos;
    } else {
      bana.kontroller.push(pos);
    }
    rita();
  }

  function visaPunktMeny(typ, index, markor) {
    const namn = typ === 'start' ? 'Start' : typ === 'mal' ? 'Mål' : `Kontroll ${index + 1}`;
    const innehall = document.createElement('div');
    innehall.innerHTML = `<strong>${namn}</strong><br><button class="knapp fara liten-knapp popup-knapp" type="button">Ta bort</button>`;
    innehall.querySelector('button').addEventListener('click', () => {
      karta.closePopup();
      sparaHistorik();
      if (typ === 'start') bana.start = null;
      else if (typ === 'mal') bana.mal = null;
      else bana.kontroller.splice(index, 1);
      rita();
    });
    L.popup({ offset: [0, -10] }).setLatLng(markor.getLatLng()).setContent(innehall).openOn(karta);
  }

  // Ett klick som bara stänger en öppen popup ska inte sätta ut en ny punkt.
  let popupOppen = false;
  karta.on('popupopen', () => (popupOppen = true));
  karta.on('popupclose', () => setTimeout(() => (popupOppen = false), 0));
  karta.on('click', (e) => {
    if (!popupOppen) laggTill(valtVerktyg(), { lat: e.latlng.lat, lng: e.latlng.lng });
  });

  valjVerktyg(bana.start ? 'kontroll' : 'start');
  for (const radio of document.querySelectorAll('input[name=verktyg]')) radio.onchange = ritaTips;
  for (const radio of document.querySelectorAll('input[name=karttyp]')) {
    radio.onchange = () => {
      bana.karttyp = radio.value;
      satKarttyp(karta, radio.value);
    };
  }
  radieVal.onchange = () => {
    bana.radie = Number(radieVal.value);
    rita();
  };

  $('#red-angra').onclick = () => {
    const forra = historik.pop();
    if (!forra) return;
    Object.assign(bana, forra);
    rita();
  };

  $('#red-min-pos').onclick = () => {
    if (!navigator.geolocation) return visaFel($('#red-fel'), 'Webbläsaren kan inte dela din position.');
    let forsta = true;
    if (gpsWatch !== null) navigator.geolocation.clearWatch(gpsWatch);
    gpsWatch = navigator.geolocation.watchPosition(
      (p) => {
        minSenaste = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) };
        minPos.visa(minSenaste);
        $('#red-har').hidden = false;
        if (forsta) karta.setView([minSenaste.lat, minSenaste.lng], Math.max(karta.getZoom(), 17));
        forsta = false;
      },
      (fel) =>
        visaFel(
          $('#red-fel'),
          fel.code === fel.PERMISSION_DENIED ? 'Webbläsaren fick inte använda din position.' : 'Hittade inte din position.'
        ),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
    );
  };

  $('#red-har').onclick = () => {
    if (!minSenaste) return;
    laggTill(valtVerktyg(), { lat: minSenaste.lat, lng: minSenaste.lng });
    visaFel($('#red-fel'), minSenaste.acc > 20 ? `Obs: GPS:en var bara noggrann på ±${minSenaste.acc} meter.` : '');
  };

  $('#sok-form').onsubmit = async (e) => {
    e.preventDefault();
    const fraga = $('#sok').value.trim();
    const lista = $('#sok-traffar');
    if (!fraga) return;
    lista.innerHTML = '<li class="hjalptext">Söker …</li>';
    try {
      const url =
        'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=sv' +
        `&viewbox=10.5,69.1,24.2,55.3&bounded=0&q=${encodeURIComponent(fraga)}`;
      const traffar = await (await fetch(url)).json();
      if (!traffar.length) {
        lista.innerHTML = '<li class="hjalptext">Hittade ingenting. Prova att lägga till orten, t.ex. "Bokskogen Malmö".</li>';
        return;
      }
      lista.innerHTML = traffar.map((t, i) => `<li><button type="button" data-i="${i}">${esc(t.display_name)}</button></li>`).join('');
      lista.onclick = (ev) => {
        const i = ev.target.closest('button')?.dataset.i;
        if (i === undefined) return;
        const [syd, nord, vast, ost] = traffar[i].boundingbox.map(Number);
        karta.fitBounds([[syd, vast], [nord, ost]], { maxZoom: 16 });
        lista.innerHTML = '';
      };
    } catch {
      lista.innerHTML = '<li class="hjalptext">Sökningen fungerar inte just nu. Dra och zooma i kartan i stället.</li>';
    }
  };

  $('#red-spara').onclick = async () => {
    const knapp = $('#red-spara');
    bana.namn = $('#red-namn').value.trim();
    if (!bana.namn) {
      visaFel($('#red-fel'), 'Ge banan ett namn, till exempel platsen där den ligger.');
      return $('#red-namn').focus();
    }
    knapp.disabled = true;
    try {
      if (id) await api('PUT', `/api/larare/banor/${id}`, bana);
      else await api('POST', '/api/larare/banor', bana);
      location.hash = '#/';
    } catch (fel) {
      visaFel($('#red-fel'), fel.message);
    } finally {
      knapp.disabled = false;
    }
  };

  rita();
  setTimeout(() => karta.invalidateSize(), 0);

  return {
    lamna() {
      if (gpsWatch !== null) navigator.geolocation.clearWatch(gpsWatch);
      karta.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// En omgång: PIN-kod, live-karta och resultat
// ---------------------------------------------------------------------------

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true, alt: 'QR-kod till sidan där eleverna går med' });
}

function tagnaKontroller(d, antal) {
  return d.stamplingar.filter((x) => x.index < antal).length;
}

function sorteraDeltagare(lista, antal) {
  const grupp = (d) => ({ klar: 0, springer: 1, vantar: 2 })[d.status] ?? 3;
  const tid = (d) => (d.status === 'klar' ? d.malTid - d.startTid : 0);
  return [...lista].sort(
    (a, b) =>
      grupp(a) - grupp(b) ||
      tagnaKontroller(b, antal) - tagnaKontroller(a, antal) ||
      tid(a) - tid(b) ||
      a.namn.localeCompare(b.namn, 'sv')
  );
}

async function visaOmgang(id, mitt) {
  visaVy('vy-omgang');
  let data;
  try {
    data = await api('GET', `/api/larare/omgangar/${id}`);
  } catch (fel) {
    alert(fel.message);
    location.hash = '#/';
    return null;
  }
  if (mitt !== navigering) return null;

  let omgang = data.omgang;
  let klockskillnad = data.nu - Date.now();
  let vald = null;
  let ruttLinje = null;
  const antal = omgang.bana.kontroller.length;
  const adress = `${location.origin}/?pin=${omgang.pin}`;

  const karta = skapaKarta($('#omg-karta'), omgang.bana.karttyp);
  const banLager = new BanLager(karta);
  banLager.visa(omgang.bana);
  banLager.passaIn(60);
  const markorer = new Map();

  document.title = `${omgang.namn} – Stämpla`;
  $('#omg-rubrik').textContent = omgang.namn;
  $('#omg-pin').textContent = formateraPin(omgang.pin);
  $('#omg-qr').innerHTML = qrSvg(adress);
  $('#omg-lank').href = adress;
  $('#omg-lank').textContent = location.host;
  $('#omg-localhost').hidden = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  $('#omg-detalj').hidden = true;

  $('#omg-visa-stort').onclick = () => {
    $('#stor-adress').textContent = location.host;
    $('#stor-pin').textContent = formateraPin(omgang.pin);
    $('#stor-qr').innerHTML = qrSvg(adress);
    $('#pin-dialog').showModal();
  };

  $('#omg-avsluta').onclick = async () => {
    if (!confirm('Avsluta omgången? Elever som springer får beskedet att den är slut, och PIN-koden slutar fungera.')) return;
    try {
      await api('POST', `/api/larare/omgangar/${id}/avsluta`);
      await uppdatera();
    } catch (fel) {
      alert(fel.message);
    }
  };

  $('#omg-csv').onclick = () => laddaNerCsv(omgang);

  $('#omg-resultat tbody').onclick = (e) => {
    const rad = e.target.closest('tr[data-id]');
    if (rad) valj(rad.dataset.id);
  };

  function ritaHuvud() {
    const aktiv = omgang.status === 'aktiv';
    $('#omg-bana').innerHTML = `${esc(omgang.banaNamn)}, ${antal} kontroller. ${
      aktiv ? `Startad ${datumText(omgang.startad)}.` : `Avslutad ${datumText(omgang.avslutad)}.`
    } ${omgang.testlage ? '<span class="chip test">Testomgång</span>' : ''}`;
    $('#omg-anslut').hidden = !aktiv;
    $('#omg-avsluta').hidden = !aktiv;
  }

  function tidFor(d) {
    if (d.status === 'klar') return formateraTid(d.malTid - d.startTid);
    if (d.status === 'springer' && d.startMottagen) return formateraTid(Date.now() + klockskillnad - d.startMottagen);
    return '–';
  }

  function chips(d) {
    const nu = Date.now() + klockskillnad;
    const lista = [];
    if (d.status === 'klar') lista.push('<span class="chip klar">I mål</span>');
    else if (d.status === 'springer') lista.push('<span class="chip springer">Springer</span>');
    else if (d.status === 'vantar') lista.push('<span class="chip vantar">Har inte startat</span>');
    else lista.push('<span class="chip avbrot">Avbröt</span>');
    if (d.status === 'springer' && omgang.status === 'aktiv' && nu - d.senastSedd > 30000) {
      lista.push(`<span class="chip varn">Ingen kontakt ${tidSedan(nu - d.senastSedd)}</span>`);
    }
    if (d.overhoppade.length) lista.push(`<span class="chip varn">Hoppade över ${d.overhoppade.map((i) => i + 1).join(', ')}</span>`);
    if (d.lamnatAppen) lista.push(`<span class="chip vantar">Lämnade appen ${d.lamnatAppen} ${d.lamnatAppen === 1 ? 'gång' : 'gånger'}</span>`);
    if (d.simulerad) lista.push('<span class="chip test">Simulerad GPS</span>');
    return lista.join('');
  }

  function ritaResultat() {
    const lista = sorteraDeltagare(omgang.deltagare, antal);
    let plac = 0;
    $('#omg-tomt').hidden = lista.length > 0;
    $('#omg-resultat').hidden = lista.length === 0;
    $('#omg-resultat tbody').innerHTML = lista
      .map((d) => {
        const placering = d.status === 'klar' ? ++plac : '';
        return `<tr data-id="${d.id}" class="${d.id === vald ? 'vald' : ''}">
          <td class="plac">${placering}</td>
          <td class="elevnamn">${esc(d.namn)}<span class="under">${chips(d)}</span></td>
          <td class="tal">${tagnaKontroller(d, antal)}/${antal}</td>
          <td class="tal siffror">${tidFor(d)}</td>
        </tr>`;
      })
      .join('');
  }

  function ritaMarkorer() {
    const nu = Date.now() + klockskillnad;
    for (const d of omgang.deltagare) {
      if (!d.position) continue;
      const tappad = d.status === 'springer' && nu - d.senastSedd > 30000;
      const farg = d.status === 'klar' ? '#1d6b31' : d.status === 'springer' && !tappad ? MIN_BLA : '#7a7a7a';
      let markor = markorer.get(d.id);
      if (!markor) {
        markor = L.circleMarker([d.position.lat, d.position.lng], {
          radius: 8,
          color: '#ffffff',
          weight: 2.5,
          fillColor: farg,
          fillOpacity: 1,
        })
          .bindTooltip(esc(d.namn), { permanent: true, direction: 'right', offset: [10, 0], className: 'lopar-etikett' })
          .addTo(karta);
        markor.on('click', () => valj(d.id));
        markorer.set(d.id, markor);
      } else {
        markor.setLatLng([d.position.lat, d.position.lng]);
        markor.setStyle({ fillColor: farg });
      }
    }
  }

  async function ritaDetalj() {
    const ruta = $('#omg-detalj');
    const d = omgang.deltagare.find((x) => x.id === vald);
    if (!d) {
      ruta.hidden = true;
      ruttLinje?.remove();
      ruttLinje = null;
      return;
    }
    const rader = strackor(antal, d.startTid, d.stamplingar);
    ruta.hidden = false;
    ruta.innerHTML = `<h3>${esc(d.namn)}</h3>
      <p class="hjalptext">Rutten syns som en blå linje på kartan.${
        d.position ? ` Senaste position ${tidSedan(Date.now() + klockskillnad - d.position.mottagen)}, ±${d.position.acc} m.` : ''
      }</p>
      ${
        rader.length
          ? `<table class="strack-tabell"><thead><tr><th>Sträcka</th><th class="tal">Tid</th><th class="tal">Totalt</th></tr></thead><tbody>${rader
              .map((r) => `<tr><td>${esc(r.fran)}–${esc(r.till)}</td><td class="tal">${formateraTid(r.strack)}</td><td class="tal">${formateraTid(r.total)}</td></tr>`)
              .join('')}</tbody></table>`
          : '<p class="hjalptext">Inga stämplingar än.</p>'
      }
      <button class="knapp liten-knapp" type="button" id="omg-stang-detalj">Stäng</button>`;
    $('#omg-stang-detalj').onclick = () => valj(vald);

    try {
      const { rutt } = await api('GET', `/api/larare/omgangar/${id}/rutt/${d.id}`);
      if (vald !== d.id) return;
      const punkter = rutt.map(([lat, lng]) => [lat, lng]);
      if (ruttLinje) ruttLinje.setLatLngs(punkter);
      else ruttLinje = L.polyline(punkter, { color: MIN_BLA, weight: 3, opacity: 0.8, interactive: false }).addTo(karta);
    } catch {
      /* rutten kunde inte hämtas, försök igen vid nästa uppdatering */
    }
  }

  function valj(deltagareId) {
    vald = vald === deltagareId ? null : deltagareId;
    ruttLinje?.remove();
    ruttLinje = null;
    ritaResultat();
    ritaDetalj();
  }

  async function uppdatera() {
    try {
      const svar = await api('GET', `/api/larare/omgangar/${id}`);
      klockskillnad = svar.nu - Date.now();
      omgang = svar.omgang;
      ritaHuvud();
      ritaResultat();
      ritaMarkorer();
      if (vald) ritaDetalj();
      if (omgang.status !== 'aktiv') clearInterval(timer);
    } catch {
      /* tillfälligt fel, försök igen om en stund */
    }
  }

  ritaHuvud();
  ritaResultat();
  ritaMarkorer();
  const timer = setInterval(uppdatera, UPPDATERA_MS);
  if (omgang.status !== 'aktiv') clearInterval(timer);
  setTimeout(() => karta.invalidateSize(), 0);

  return {
    lamna() {
      clearInterval(timer);
      karta.remove();
    },
  };
}

function laddaNerCsv(omgang) {
  const antal = omgang.bana.kontroller.length;
  const punkter = [...Array.from({ length: antal }, (_, i) => String(i + 1)), 'Mål'];
  const rubriker = ['Placering', 'Namn', 'Status', 'Kontroller', 'Tid', 'Överhoppade', 'Lämnade appen', 'Simulerad GPS', ...punkter.map((p) => `Sträcka till ${p}`)];
  const statusText = { klar: 'I mål', springer: 'Springer', vantar: 'Har inte startat', avbrot: 'Avbröt' };
  let plac = 0;
  const rader = sorteraDeltagare(omgang.deltagare, antal).map((d) => {
    const strack = Object.fromEntries(strackor(antal, d.startTid, d.stamplingar).map((r) => [r.till, formateraTid(r.strack)]));
    return [
      d.status === 'klar' ? ++plac : '',
      d.namn,
      statusText[d.status] || d.status,
      `${tagnaKontroller(d, antal)}/${antal}`,
      d.status === 'klar' ? formateraTid(d.malTid - d.startTid) : '',
      d.overhoppade.map((i) => punktNamn(i, antal)).join(' '),
      d.lamnatAppen || 0,
      d.simulerad ? 'ja' : '',
      ...punkter.map((p) => strack[p] || ''),
    ];
  });
  // Semikolon och BOM gör att svenska Excel öppnar filen rätt, med å, ä och ö.
  const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = '﻿' + [rubriker, ...rader].map((rad) => rad.map(cell).join(';')).join('\r\n');
  const lank = document.createElement('a');
  lank.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  lank.download = `${omgang.namn.replace(/[^\wåäöÅÄÖ-]+/g, '_')}-resultat.csv`;
  document.body.append(lank);
  lank.click();
  lank.remove();
  setTimeout(() => URL.revokeObjectURL(lank.href), 2000);
}

window.addEventListener('hashchange', navigera);
navigera();
