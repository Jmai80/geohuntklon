// Karta och banritning med Leaflet. Leaflet laddas som vanligt skript (globala L).
// Banan ritas som på en orienteringskarta: lila triangel för start,
// numrerade ringar för kontroller och dubbelring för mål.

export const LILA = '#b0158c';
export const MIN_BLA = '#1a5fd0';

export const KARTTYPER = {
  gata: {
    namn: 'Gatukarta',
    skapa: () =>
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 20,
        maxNativeZoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bidragsgivare',
      }),
  },
  terrang: {
    namn: 'Terrängkarta',
    skapa: () =>
      L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        subdomains: 'abc',
        maxZoom: 20,
        maxNativeZoom: 17,
        attribution:
          'Kartdata © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bidragsgivare, SRTM. ' +
          'Kartstil © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
      }),
  },
};

const baslager = new WeakMap();

export function skapaKarta(element, karttyp = 'gata', alternativ = {}) {
  const karta = L.map(element, { zoomSnap: 0.5, ...alternativ });
  karta.attributionControl.setPrefix(false);
  satKarttyp(karta, karttyp);
  return karta;
}

export function satKarttyp(karta, karttyp) {
  const gammalt = baslager.get(karta);
  if (gammalt) karta.removeLayer(gammalt);
  const nytt = (KARTTYPER[karttyp] || KARTTYPER.gata).skapa().addTo(karta);
  nytt.bringToBack();
  baslager.set(karta, nytt);
}

// Hur långt från punktens mitt (i pixlar) linjerna mellan punkterna ska börja.
const LINJE_AVSTAND_PX = { start: 16, kontroll: 17, mal: 20 };

function startIkon(vinkel) {
  const triangel = 'points="0,-14 12.1,7 -12.1,7"';
  return `<svg width="36" height="36" viewBox="-18 -18 36 36" aria-hidden="true">
    <g transform="rotate(${vinkel})">
      <polygon ${triangel} class="bp-halo"/>
      <polygon ${triangel} class="bp-form"/>
    </g></svg>`;
}

function kontrollIkon(nummer) {
  return `<svg width="34" height="34" viewBox="-17 -17 34 34" aria-hidden="true">
      <circle r="14" class="bp-halo"/><circle r="14" class="bp-form"/>
    </svg><span class="bp-nr">${nummer}</span>`;
}

function malIkon() {
  return `<svg width="40" height="40" viewBox="-20 -20 40 40" aria-hidden="true">
      <circle r="17" class="bp-halo"/><circle r="11" class="bp-halo"/>
      <circle r="17" class="bp-form"/><circle r="11" class="bp-form"/>
    </svg>`;
}

/**
 * Ritar en bana på kartan.
 * lage (valfritt) är elevens läge från servern: vilka kontroller som är tagna och vilken som är nästa.
 * I redigeringsläge går punkterna att dra, och klick på en punkt anropar vidKlick.
 */
export class BanLager {
  constructor(karta, { redigerbar = false, vidFlyttStart, vidFlytt, vidKlick } = {}) {
    this.karta = karta;
    this.redigerbar = redigerbar;
    this.vidFlyttStart = vidFlyttStart;
    this.vidFlytt = vidFlytt;
    this.vidKlick = vidKlick;
    this.radieLager = L.layerGroup().addTo(karta);
    this.linjeLager = L.layerGroup().addTo(karta);
    this.punktLager = L.layerGroup().addTo(karta);
    this.bana = null;
    this.lage = null;
    karta.on('zoomend viewreset', () => this.ritaLinjer());
  }

  visa(bana, lage = null) {
    this.bana = bana;
    this.lage = lage;
    // Linjerna räknas fram i pixlar, så kartan måste ha en vy innan banan kan ritas.
    this.karta.whenReady(() => this.rita());
  }

  /** Punkterna i löpordning med typ och index. */
  punkter() {
    const b = this.bana;
    if (!b) return [];
    const lista = [];
    if (b.start) lista.push({ typ: 'start', index: 0, pos: b.start });
    (b.kontroller || []).forEach((pos, index) => lista.push({ typ: 'kontroll', index, pos }));
    if (b.mal) lista.push({ typ: 'mal', index: (b.kontroller || []).length, pos: b.mal });
    return lista;
  }

  tillstand(p) {
    const l = this.lage;
    if (!l) return '';
    if (p.typ === 'start') return l.startTid ? 'tagen' : 'nasta';
    if (l.stamplingar?.some((s) => s.index === p.index)) return 'tagen';
    if (l.overhoppade?.includes(p.index)) return 'hoppad';
    if (l.nastaIndex === p.index && l.status === 'springer') return 'nasta';
    return '';
  }

  rita() {
    this.punktLager.clearLayers();
    this.radieLager.clearLayers();
    const punkter = this.punkter();
    const forsta = punkter[1];

    for (const p of punkter) {
      let html;
      let storlek;
      if (p.typ === 'start') {
        html = startIkon(forsta ? this.vinkel(p.pos, forsta.pos) + 90 : 0);
        storlek = 36;
      } else if (p.typ === 'kontroll') {
        html = kontrollIkon(p.index + 1);
        storlek = 34;
      } else {
        html = malIkon();
        storlek = 40;
      }
      const tillstand = this.tillstand(p);
      const ikon = L.divIcon({
        html,
        className: `bp bp-${p.typ} ${tillstand}`,
        iconSize: [storlek, storlek],
        iconAnchor: [storlek / 2, storlek / 2],
      });
      const markor = L.marker([p.pos.lat, p.pos.lng], {
        icon: ikon,
        draggable: this.redigerbar,
        keyboard: this.redigerbar,
        interactive: this.redigerbar,
        title: p.typ === 'start' ? 'Start' : p.typ === 'mal' ? 'Mål' : `Kontroll ${p.index + 1}`,
        zIndexOffset: tillstand === 'nasta' ? 1000 : 0,
      }).addTo(this.punktLager);

      if (this.redigerbar) {
        markor.on('dragstart', () => this.vidFlyttStart?.());
        markor.on('drag', (e) => {
          p.pos.lat = e.latlng.lat;
          p.pos.lng = e.latlng.lng;
          this.ritaLinjer();
        });
        markor.on('dragend', () => {
          const ll = markor.getLatLng();
          this.vidFlytt?.(p.typ, p.index, { lat: ll.lat, lng: ll.lng });
        });
        markor.on('click', () => this.vidKlick?.(p.typ, p.index, markor));
      }

      if (p.typ !== 'start' && this.bana.radie) {
        L.circle([p.pos.lat, p.pos.lng], {
          radius: this.bana.radie,
          color: LILA,
          weight: 1,
          opacity: tillstand === 'tagen' ? 0.25 : 0.7,
          dashArray: '3 4',
          fillColor: LILA,
          fillOpacity: tillstand === 'tagen' ? 0.03 : 0.08,
          interactive: false,
        }).addTo(this.radieLager);
      }
    }
    this.ritaLinjer();
  }

  vinkel(fran, till) {
    const a = this.karta.project([fran.lat, fran.lng]);
    const b = this.karta.project([till.lat, till.lng]);
    return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  }

  /** Linjer mellan punkterna, kapade vid ringarna som på en riktig orienteringskarta. */
  ritaLinjer() {
    this.linjeLager.clearLayers();
    const punkter = this.punkter();
    for (let i = 1; i < punkter.length; i++) {
      const fran = punkter[i - 1];
      const till = punkter[i];
      const a = this.karta.latLngToLayerPoint([fran.pos.lat, fran.pos.lng]);
      const b = this.karta.latLngToLayerPoint([till.pos.lat, till.pos.lng]);
      const langd = a.distanceTo(b);
      const ka = LINJE_AVSTAND_PX[fran.typ];
      const kb = LINJE_AVSTAND_PX[till.typ];
      if (langd <= ka + kb + 4) continue;
      const ux = (b.x - a.x) / langd;
      const uy = (b.y - a.y) / langd;
      const p1 = this.karta.layerPointToLatLng(L.point(a.x + ux * ka, a.y + uy * ka));
      const p2 = this.karta.layerPointToLatLng(L.point(b.x - ux * kb, b.y - uy * kb));
      const avklarad = ['tagen', 'hoppad'].includes(this.tillstand(till));
      L.polyline([p1, p2], {
        color: LILA,
        weight: 3,
        opacity: avklarad ? 0.3 : 0.95,
        interactive: false,
        lineCap: 'butt',
      }).addTo(this.linjeLager);
    }
  }

  passaIn(padding = 40) {
    const punkter = this.punkter();
    if (punkter.length === 0) return;
    const granser = L.latLngBounds(punkter.map((p) => [p.pos.lat, p.pos.lng]));
    this.karta.fitBounds(granser, { padding: [padding, padding], maxZoom: 17 });
  }
}

/** Den blå pricken som visar var man själv är, med en ring för GPS-noggrannheten. */
export class MinPosition {
  constructor(karta) {
    this.karta = karta;
    this.ring = L.circle([0, 0], {
      radius: 1,
      color: MIN_BLA,
      weight: 1,
      opacity: 0.5,
      fillColor: MIN_BLA,
      fillOpacity: 0.12,
      interactive: false,
    });
    this.prick = L.circleMarker([0, 0], {
      radius: 8,
      color: '#ffffff',
      weight: 3,
      fillColor: MIN_BLA,
      fillOpacity: 1,
      interactive: false,
    });
    this.synlig = false;
  }

  visa(pos) {
    this.ring.setLatLng([pos.lat, pos.lng]).setRadius(Math.max(1, pos.acc || 1));
    this.prick.setLatLng([pos.lat, pos.lng]);
    if (!this.synlig) {
      this.ring.addTo(this.karta);
      this.prick.addTo(this.karta);
      this.synlig = true;
    }
  }

  dolj() {
    this.ring.remove();
    this.prick.remove();
    this.synlig = false;
  }
}
