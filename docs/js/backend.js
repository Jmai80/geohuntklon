// Kopplingen till Supabase: databasfunktionerna i supabase.sql och lärarnas inloggning.
// Adressen och nyckeln står i config.js.

import { SUPABASE_URL, SUPABASE_NYCKEL } from '../config.js';
import { ApiFel } from './hjalp.js';

const URL_BAS = String(SUPABASE_URL || '').trim().replace(/\/+$/, '');
const NYCKEL = String(SUPABASE_NYCKEL || '').trim();
const SESSION_NYCKEL = 'stampla-inloggning';

/** Falskt tills någon fyllt i config.js. */
export const konfigurerad = /^https?:\/\/.+/.test(URL_BAS) && NYCKEL.length > 20;

export const EJ_KONFIGURERAD_TEXT =
  'Sidan är inte kopplad till någon databas än. Fyll i SUPABASE_URL och SUPABASE_NYCKEL i config.js (se README.md).';

// ---------------------------------------------------------------------------
// Inloggning (bara för lärare)
// ---------------------------------------------------------------------------

function lasSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_NYCKEL));
  } catch {
    return null;
  }
}

/** Läser e-postadressen ur inloggningsnyckeln (en JWT) om den inte följde med på annat sätt. */
function epostIToken(token) {
  try {
    const del = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(escape(atob(del)));
    return JSON.parse(json).email || '';
  } catch {
    return '';
  }
}

function sparaSession(svar, epost) {
  const session = {
    access_token: svar.access_token,
    refresh_token: svar.refresh_token,
    expires_at: Number(svar.expires_at) || Math.floor(Date.now() / 1000) + (Number(svar.expires_in) || 3600),
    epost: svar.user?.email || epost || epostIToken(svar.access_token) || lasSession()?.epost || '',
  };
  try {
    localStorage.setItem(SESSION_NYCKEL, JSON.stringify(session));
  } catch {
    /* privat läge: inloggningen gäller tills sidan laddas om */
  }
  minnesSession = session;
  return session;
}

let minnesSession = null;
const aktuellSession = () => lasSession() || minnesSession;

function rensaSession() {
  minnesSession = null;
  try {
    localStorage.removeItem(SESSION_NYCKEL);
  } catch {
    /* ingenting att göra */
  }
}

export const arInloggad = () => Boolean(aktuellSession()?.access_token);
export const inloggadEpost = () => aktuellSession()?.epost || '';

async function anropa(sokvag, { metod = 'POST', body, token } = {}) {
  if (!konfigurerad) throw new ApiFel(503, EJ_KONFIGURERAD_TEXT);
  const huvuden = { apikey: NYCKEL, 'Content-Type': 'application/json' };
  if (token) huvuden.Authorization = `Bearer ${token}`;
  let svar;
  try {
    svar = await fetch(URL_BAS + sokvag, {
      method: metod,
      headers: huvuden,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiFel(0, 'Ingen kontakt med servern. Kolla internetanslutningen.');
  }
  let data = null;
  try {
    data = await svar.json();
  } catch {
    /* tomt svar */
  }
  if (!svar.ok) {
    const text = data?.message || data?.msg || data?.error_description || data?.error || `Servern svarade med fel ${svar.status}.`;
    const fel = new ApiFel(svar.status, text);
    fel.kod = data?.code || data?.error_code || null;
    throw fel;
  }
  return data;
}

const AUTH_TEXTER = {
  invalid_credentials: 'Fel e-post eller lösenord.',
  'Invalid login credentials': 'Fel e-post eller lösenord.',
  email_not_confirmed: 'Du behöver bekräfta din e-post först. Klicka på länken i mejlet och logga sedan in.',
  'Email not confirmed': 'Du behöver bekräfta din e-post först. Klicka på länken i mejlet och logga sedan in.',
  user_already_exists: 'Det finns redan ett konto med den e-posten. Logga in i stället.',
  'User already registered': 'Det finns redan ett konto med den e-posten. Logga in i stället.',
  weak_password: 'Lösenordet är för svagt. Använd minst 8 tecken.',
  signup_disabled: 'Det går inte att skapa nya konton just nu.',
  over_email_send_rate_limit: 'För många mejl har skickats. Vänta en stund och försök igen.',
  validation_failed: 'Kolla att e-postadressen är rätt skriven.',
};

function oversattAuthFel(fel) {
  const text = AUTH_TEXTER[fel.kod] || AUTH_TEXTER[fel.message];
  if (text) fel.message = text;
  else if (/password/i.test(fel.message)) fel.message = 'Lösenordet godtogs inte. Använd minst 8 tecken.';
  return fel;
}

export async function loggaIn(epost, losenord) {
  try {
    const svar = await anropa('/auth/v1/token?grant_type=password', { body: { email: epost, password: losenord } });
    sparaSession(svar, epost);
  } catch (fel) {
    throw oversattAuthFel(fel);
  }
}

/** Skapar ett lärarkonto. Svarar { inloggad: true } eller { maste_bekrafta: true } om Supabase skickar ett mejl först. */
export async function skapaKonto(epost, losenord) {
  const tillbaka = encodeURIComponent(new URL('larare.html', location.href).href);
  let svar;
  try {
    svar = await anropa(`/auth/v1/signup?redirect_to=${tillbaka}`, { body: { email: epost, password: losenord } });
  } catch (fel) {
    throw oversattAuthFel(fel);
  }
  if (svar?.access_token) {
    sparaSession(svar, epost);
    return { inloggad: true };
  }
  return { maste_bekrafta: true };
}

export async function loggaUt() {
  const session = aktuellSession();
  rensaSession();
  if (session?.access_token) {
    await anropa('/auth/v1/logout', { token: session.access_token }).catch(() => {});
  }
}

/**
 * När läraren klickar på länken i bekräftelsemejlet kommer hen tillbaka med inloggningen
 * i adressen (#access_token=...). Den sparas och tas bort ur adressfältet.
 */
export function hamtaInloggningFranAdress() {
  const hash = location.hash.replace(/^#/, '');
  if (!/(^|&)(access_token|error)=/.test(hash)) return null;
  const p = new URLSearchParams(hash);
  history.replaceState(null, '', location.pathname + location.search + '#/');
  if (p.get('access_token')) {
    sparaSession({
      access_token: p.get('access_token'),
      refresh_token: p.get('refresh_token'),
      expires_at: p.get('expires_at'),
      expires_in: p.get('expires_in'),
    });
    return { ok: true };
  }
  const utgangen = p.get('error_code') === 'otp_expired';
  return {
    fel: utgangen
      ? 'Länken i mejlet har gått ut eller redan använts. Logga in med e-post och lösenord.'
      : `Länken fungerade inte (${p.get('error_description') || p.get('error')}). Logga in med e-post och lösenord.`,
  };
}

let fornyar = null;

async function fornyaSession() {
  fornyar ??= (async () => {
    const session = aktuellSession();
    if (!session?.refresh_token) return null;
    try {
      const svar = await anropa('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: session.refresh_token } });
      return sparaSession(svar, session.epost);
    } catch (fel) {
      if (fel.status === 0) throw fel; // inget nät: behåll inloggningen och försök igen senare
      rensaSession();
      return null;
    }
  })().finally(() => {
    fornyar = null;
  });
  return fornyar;
}

async function giltigToken() {
  let session = aktuellSession();
  if (!session) return null;
  if (session.expires_at * 1000 - Date.now() < 60_000) session = await fornyaSession();
  return session?.access_token || null;
}

// ---------------------------------------------------------------------------
// Databasfunktionerna
// ---------------------------------------------------------------------------

/**
 * Anropar en funktion i supabase.sql, t.ex. rpc('elev_pin', { p_pin: '123456' }).
 * Elevfunktionerna anropas utan inloggning. Lärarfunktionerna kräver inloggning
 * och kastar ApiFel med status 401 om läraren inte är inloggad.
 */
export async function rpc(funktion, argument = {}) {
  const arLarare = funktion.startsWith('larare_');
  let token = null;
  if (arLarare) {
    token = await giltigToken();
    if (!token) throw new ApiFel(401, 'Du är inte inloggad.');
  }
  try {
    return await anropa(`/rest/v1/rpc/${funktion}`, { body: argument, token });
  } catch (fel) {
    if (!arLarare || fel.status !== 401) throw fel;
    // Inloggningen kan ha gått ut. Förnya den och försök en gång till.
    const nyttToken = (await fornyaSession())?.access_token;
    if (!nyttToken) throw new ApiFel(401, 'Du är inte inloggad.');
    return anropa(`/rest/v1/rpc/${funktion}`, { body: argument, token: nyttToken });
  }
}
