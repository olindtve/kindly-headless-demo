// server.js
//
// Enkel backend som bygger bro mellom en frontend-chat og Kindlys
// "Application API" (headless). Kindly svarer asynkront via webhook,
// så vi må holde styr på hvilken bruker (user_id) som hører til
// hvilken åpen WebSocket-tilkobling, slik at svaret kan rutes videre
// til riktig nettleser i sanntid.
//
// Flyt:
//   1. Frontend kobler til via WebSocket og får (eller sender) en user_id.
//   2. Bruker skriver melding -> frontend POSTer til /api/kindly/send.
//   3. Vi videresender meldingen til Kindly sin /api/v1/send.
//   4. Kindly prosesserer og POSTer svaret til vår webhook: /api/kindly/webhook.
//   5. Vi finner riktig WebSocket for user_id og pusher svaret til nettleseren.

require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fetch = require('node-fetch');
const { nanoid } = require('nanoid');
const path = require('path');

const {
  KINDLY_API_KEY,
  KINDLY_BASE_URL = 'https://bot.kindly.ai',
  PORT = 3000,
  WEBHOOK_SHARED_SECRET, // valgfritt: hvis du later til HMAC-signatur fra Kindly
  ENTUR_CLIENT_NAME = 'kindly-headless-demo - atb-demo', // Entur krever "organisasjon - applikasjon"
} = process.env;

if (!KINDLY_API_KEY) {
  console.warn(
    '⚠️  KINDLY_API_KEY mangler i .env. Sett den før du sender meldinger til Kindly.'
  );
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// user_id -> WebSocket. I produksjon: bytt ut med Redis/pubsub
// hvis du kjører flere server-instanser (så webhooken finner riktig node).
const connections = new Map();

wss.on('connection', (ws, req) => {
  // Frontend sender user_id som query-param: /ws?user_id=xxxx
  const url = new URL(req.url, `http://${req.headers.host}`);
  let userId = url.searchParams.get('user_id');

  if (!userId) {
    userId = nanoid();
    ws.send(JSON.stringify({ type: 'session', userId }));
  }

  connections.set(userId, ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  console.log(`🔌 WebSocket tilkoblet for user_id=${userId}`);

  ws.on('close', () => {
    connections.delete(userId);
    console.log(`❌ WebSocket frakoblet for user_id=${userId}`);
  });
});

// Plattformer som Render kan stille kutte inaktive WebSocket-tilkoblinger
// (proxy-idle-timeout). Uten en heartbeat tror serveren forbindelsen
// fortsatt er åpen, og et webhook-svar som kommer inn mens tilkoblingen
// egentlig er død, forsvinner sporløst. Ping hvert 25. sekund holder
// forbindelsen varm og rydder raskt opp tilkoblinger som faktisk er døde,
// slik at klienten kobler til på nytt i stedet for å stå fast på "skriver …".
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

wss.on('close', () => clearInterval(heartbeat));

// --- 1. Frontend -> Kindly: send brukermelding ---------------------------
app.post('/api/kindly/send', async (req, res) => {
  const { userId, message, languageCode = 'en' } = req.body;

  if (!userId || !message) {
    return res.status(400).json({ error: 'userId og message er påkrevd' });
  }

  try {
    const response = await fetch(`${KINDLY_BASE_URL}/api/v1/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KINDLY_API_KEY}`,
      },
      body: JSON.stringify({
        user_id: userId,
        message,
        language_code: languageCode,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('Kindly /send feilet:', response.status, text);
      return res.status(502).json({ error: 'Kindly avviste forespørselen', detail: text });
    }

    // Selve svaret fra boten kommer asynkront på webhooken under,
    // så her bekrefter vi bare at meldingen ble mottatt av Kindly.
    res.json({ ok: true });
  } catch (err) {
    console.error('Feil ved sending til Kindly:', err);
    res.status(500).json({ error: 'Klarte ikke å nå Kindly' });
  }
});

// Valgfritt: trigg en velkomstmelding når chatten åpnes første gang
app.post('/api/kindly/greet', async (req, res) => {
  const { userId, languageCode = 'en' } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId er påkrevd' });

  try {
    const response = await fetch(`${KINDLY_BASE_URL}/api/v1/greet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KINDLY_API_KEY}`,
      },
      body: JSON.stringify({ user_id: userId, language_code: languageCode }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({ error: 'Kindly avviste greet', detail: text });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Feil ved greet mot Kindly:', err);
    res.status(500).json({ error: 'Klarte ikke å nå Kindly' });
  }
});

// --- Entur: reiseplanlegging til AtB-demoen -------------------------------
// Åpne, gratis API-er fra Entur (nasjonalt reisedata-aggregat). Krever ingen
// nøkkel, bare en ET-Client-Name-header for identifikasjon. Kalles fra
// backend (ikke direkte fra nettleseren) for å holde et samlet mønster med
// resten av integrasjonene og gjøre det enkelt å bytte ut/cache senere.
const ENTUR_GEOCODER_URL = 'https://api.entur.io/geocoder/v2/autocomplete';
const ENTUR_JOURNEY_PLANNER_URL = 'https://api.entur.io/journey-planner/v3/graphql';

// Sentrum av Trondheim, brukt til å vekte autocomplete-treff mot AtBs
// dekningsområde (Entur er nasjonal, uten dette kan f.eks. "Moholt" i en
// annen landsdel rangeres høyere enn Moholt i Trondheim).
const TRONDHEIM_CENTER = { lat: 63.4305, lon: 10.3951 };

async function geocodeAutocomplete(q, focus = TRONDHEIM_CENTER) {
  if (!q || q.trim().length < 2) return [];

  const url =
    `${ENTUR_GEOCODER_URL}?text=${encodeURIComponent(q)}&lang=no&size=5` +
    `&focus.point.lat=${focus.lat}&focus.point.lon=${focus.lon}`;
  const response = await fetch(url, {
    headers: { 'ET-Client-Name': ENTUR_CLIENT_NAME },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Entur geocoder feilet: ${response.status} ${text}`);
  }

  const data = await response.json();
  return (data.features || []).map((f) => {
    const zones = (f.properties.tariff_zones || [])
      .filter((z) => z.startsWith('ATB:FareZone:'))
      .map((z) => z.replace('ATB:FareZone:', ''));

    return {
      id: f.properties.id,
      name: f.properties.label,
      // GeoJSON bruker [lon, lat]-rekkefølge. Adresser (i motsetning til
      // registrerte stoppesteder) har ingen NSR-ID reiseplanleggeren
      // kjenner igjen, så vi sender med koordinater som fallback.
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      zone: zones[0] || null,
    };
  });
}

app.get('/api/entur/autocomplete', async (req, res) => {
  try {
    const features = await geocodeAutocomplete(req.query.q);
    res.json({ features });
  } catch (err) {
    console.error('Feil ved Entur geocoder-kall:', err.message);
    res.status(502).json({ error: 'Klarte ikke å hente stedsforslag' });
  }
});

// Registrerte stoppesteder har en NSR-ID reiseplanleggeren kan slå opp
// direkte (place-argumentet). Adresser og andre geocoder-treff har det ikke,
// og må i stedet sendes inn som koordinater.
function toLocationInput({ id, lat, lon }) {
  if (id && id.startsWith('NSR:')) return { place: id };
  return { coordinates: { latitude: lat, longitude: lon } };
}

async function searchTrip(from, to, { dateTime, arriveBy } = {}) {
  const query = `
    query($from: Location!, $to: Location!, $dateTime: DateTime, $arriveBy: Boolean) {
      trip(from: $from, to: $to, dateTime: $dateTime, arriveBy: $arriveBy, numTripPatterns: 3) {
        tripPatterns {
          startTime
          endTime
          duration
          legs {
            mode
            line { publicCode name }
            fromPlace { name quay { name publicCode } }
            toPlace { name quay { name publicCode } }
            expectedStartTime
            expectedEndTime
            distance
            intermediateEstimatedCalls {
              quay { name }
              expectedArrivalTime
            }
            steps {
              distance
              streetName
              relativeDirection
            }
          }
        }
      }
    }
  `;

  const response = await fetch(ENTUR_JOURNEY_PLANNER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'ET-Client-Name': ENTUR_CLIENT_NAME,
    },
    body: JSON.stringify({
      query,
      variables: {
        from: toLocationInput(from),
        to: toLocationInput(to),
        // Uten dateTime søker Entur fra "nå". arriveBy avgjør om dateTime
        // tolkes som ønsket avreise- eller ankomsttidspunkt.
        dateTime: dateTime || undefined,
        arriveBy: Boolean(arriveBy),
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Entur reiseplanlegger feilet: ${response.status} ${text}`);
  }

  const data = await response.json();
  if (data.errors) {
    throw new Error(`Entur GraphQL-feil: ${JSON.stringify(data.errors)}`);
  }

  return data.data.trip.tripPatterns;
}

app.post('/api/entur/trip', async (req, res) => {
  const { from, to, dateTime, arriveBy } = req.body;
  if (!from || !to) {
    return res.status(400).json({ error: 'from og to er påkrevd' });
  }

  try {
    const tripPatterns = await searchTrip(from, to, { dateTime, arriveBy });
    res.json({ tripPatterns });
  } catch (err) {
    console.error('Feil ved Entur reiseplanlegger-kall:', err.message);
    res.status(502).json({ error: 'Klarte ikke å hente reiseforslag' });
  }
});

// Entur rangerer noen ganger en ren gangtur øverst hvis den er raskere enn
// å vente på buss. Teknisk riktig, men et dårlig utstillingsvindu for en
// kollektivselskap-demo — foretrekk et alternativ med faktisk kollektiv-
// transport når et slikt finnes.
function pickBestPattern(tripPatterns) {
  return tripPatterns.find((p) => p.legs.some((leg) => leg.mode !== 'foot')) || tripPatterns[0];
}

// Linjens offisielle navn ("Stabekk-Oslo S-Ski") lister linjens ytterpunkter,
// ikke retningen for DENNE avgangen — det har tidligere blitt lest som "feil
// retning" siden f.eks. "Kolbotn" ikke engang står i linjenavnet. Vis derfor
// alltid faktisk fra/til (+ spor når det finnes) for hver etappe i stedet.
function formatPlaceWithPlatform(place) {
  const code = place.quay && place.quay.publicCode;
  return code ? `${place.name} (spor ${code})` : place.name;
}

function formatTripReply(fromPlace, toPlace, pattern, timeExpr) {
  const start = new Date(pattern.startTime).toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' });
  const end = new Date(pattern.endTime).toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' });
  const minutes = Math.round(pattern.duration / 60);
  const transitLegs = pattern.legs.filter((leg) => leg.mode !== 'foot');
  const lineText = transitLegs.length
    ? transitLegs
        .map((leg) => {
          const label = leg.line ? leg.line.publicCode : leg.mode;
          return `${label} ${formatPlaceWithPlatform(leg.fromPlace)} → ${formatPlaceWithPlatform(leg.toPlace)}`;
        })
        .join(', deretter ')
    : 'gange hele veien';

  // Enkel billettanbefaling basert på AtBs sonemodell. Prisene er
  // illustrative demo-tall, ikke reelle AtB-priser.
  const sameZone = fromPlace.zone && toPlace.zone && fromPlace.zone === toPlace.zone;
  const ticketLabel = sameZone ? 'Enkeltbillett, 1 sone' : 'Enkeltbillett, 2 soner';
  const price = sameZone ? '41' : '60';

  // Bekreft hvilket tidsuttrykk vi faktisk tolket meldingen som, så det er
  // synlig for brukeren om vi f.eks. skjønte "innen kl. ni i morgen" riktig.
  const timeNote = timeExpr
    ? ` (søkt med ønsket ${timeExpr.arriveBy ? 'ankomst innen' : 'avreise ca.'} ${new Date(
        timeExpr.dateTime
      ).toLocaleString('no-NO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })})`
    : '';

  const reply =
    `Beste reise fra ${fromPlace.name} til ${toPlace.name}: avgang ${start}, fremme ${end} ` +
    `(${minutes} min) med ${lineText}.${timeNote}\n\n` +
    `Basert på reisen anbefaler jeg ${ticketLabel} (ca. kr ${price},- illustrativ demo-pris).`;

  return { reply, ticketLabel, price };
}

// Kjenner igjen tidsuttrykk i fritekst ("innen kl. 0900 i morgen", "klokka
// ni", "på lørdag") og oversetter til dateTime/arriveBy for Entur — samme
// mekanikk som Nå/Avreise/Ankomst-feltet i reiseplanleggeren, bare hentet
// fra selve meldingsteksten i stedet for et eget skjemafelt.
const NORWEGIAN_HOUR_WORDS = {
  null: 0, en: 1, to: 2, tre: 3, fire: 4, fem: 5, seks: 6, sju: 7, syv: 7,
  åtte: 8, ni: 9, ti: 10, elleve: 11, tolv: 12, tretten: 13, fjorten: 14,
  femten: 15, seksten: 16, sytten: 17, atten: 18, nitten: 19, tjue: 20,
  tjueen: 21, tjueto: 22, tjuetre: 23, tjuefire: 24,
};

function extractTimeOfDay(text) {
  // "innen"/"senest"/"etter" fungerer også som tidsprefiks på egen hånd
  // ("senest 0900", "etter kl 16"), ikke bare sammen med "kl."/"klokka".
  let match = text.match(/\b(?:kl\.?|klokka|klokken|innen|senest|etter)\s*(\d{1,2})[:.]?(\d{2})?\b/i);
  if (match) {
    const hour = parseInt(match[1], 10);
    const minute = match[2] ? parseInt(match[2], 10) : 0;
    if (hour <= 24 && minute < 60) return { hour: hour % 24, minute };
  }

  match = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (match) return { hour: parseInt(match[1], 10), minute: parseInt(match[2], 10) };

  match = text.match(/\b(?:kl\.?|klokka|klokken)\s+([a-zæøå]+)\b/i);
  if (match && match[1].toLowerCase() in NORWEGIAN_HOUR_WORDS) {
    return { hour: NORWEGIAN_HOUR_WORDS[match[1].toLowerCase()], minute: 0 };
  }

  return null;
}

const WEEKDAYS = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'];

function extractDate(text, referenceDate) {
  const lower = text.toLowerCase();
  const base = new Date(referenceDate);

  if (/\bi\s+overmorgen\b/.test(lower)) {
    base.setDate(base.getDate() + 2);
    return base;
  }
  if (/\bi\s+morgen\b/.test(lower)) {
    base.setDate(base.getDate() + 1);
    return base;
  }
  if (/\bi\s+dag\b/.test(lower)) return base;

  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (new RegExp(`\\b(?:på\\s+)?${WEEKDAYS[i]}\\b`).test(lower)) {
      let diff = (i - base.getDay() + 7) % 7;
      if (diff === 0) diff = 7; // "på lørdag" en lørdag betyr neste lørdag
      base.setDate(base.getDate() + diff);
      return base;
    }
  }

  return null;
}

function parseTimeExpression(text, now = new Date()) {
  const source = text || '';
  const timeOfDay = extractTimeOfDay(source);
  if (!timeOfDay) return null;

  const explicitDate = extractDate(source, now);
  const arriveBy = /\b(?:innen|senest|før)\b/i.test(source);

  const result = new Date(explicitDate || now);
  result.setHours(timeOfDay.hour, timeOfDay.minute, 0, 0);

  // Ingen eksplisitt dato oppgitt, og klokkeslettet er allerede passert i
  // dag: anta i morgen fremfor et tidspunkt bakover i tid.
  if (!explicitDate && result.getTime() < now.getTime()) {
    result.setDate(result.getDate() + 1);
  }

  return { dateTime: result.toISOString(), arriveBy };
}

// Fallback for når Kindly-dialogen ikke selv har fanget fra/til som
// context-variabler: i stedet for å stole på et rigid "fra X til Y"-mønster
// (som bare dekker den ene bokstavelige formuleringen), lar vi Entur selv
// bekrefte hvilke ord i meldingen som faktisk er ekte steder.

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Norske stedsnavn skrives med stor forbokstav, så vi plukker ut løp av
// store forbokstaver (1-3 ord) som kandidater. Vanlige pronomen/spørreord
// filtreres bort før vi i det hele tatt bruker et API-kall på dem.
const PLACE_CANDIDATE_STOPWORDS = new Set([
  'jeg', 'vi', 'du', 'han', 'hun', 'det', 'den', 'de', 'dere', 'neste',
  'gang', 'når', 'hvor', 'hvordan', 'hvorfor', 'kan', 'skal', 'vil', 'må', 'er',
]);

function extractPlaceCandidates(text) {
  const source = text || '';
  const matches = source.match(/\b[A-ZÆØÅ][\wæøåÆØÅ'-]*(?:\s+[A-ZÆØÅ][\wæøåÆØÅ'-]*){0,2}\b/g) || [];

  const seen = new Set();
  const candidates = [];
  for (const raw of matches) {
    const candidate = raw.trim();
    const key = candidate.toLowerCase();
    if (seen.has(key) || PLACE_CANDIDATE_STOPWORDS.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

// Enturs autocomplete oppgir ingen brukbar treffsikkerhets-score (feltet
// er alltid tomt i praksis), så et fuzzy-treff som "Jeg" → "Jegtvolden
// Fjordhotell" ville ellers blitt godtatt som et gyldig sted. Krev i stedet
// at kandidatordet faktisk finnes som et helt ord i navnet Entur returnerer.
function candidateMatchesFeature(candidate, feature) {
  const pattern = new RegExp(`\\b${escapeRegExp(candidate.toLowerCase())}\\b`);
  return pattern.test((feature.name || '').toLowerCase());
}

async function resolvePlaceCandidates(text) {
  const candidates = extractPlaceCandidates(text).slice(0, 6); // begrens antall API-kall
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      const features = await geocodeAutocomplete(candidate).catch(() => []);
      const best = features.find((f) => candidateMatchesFeature(candidate, f));
      if (!best) return null;
      return { candidate, place: best };
    })
  );
  return results.filter(Boolean);
}

// Folk skriver sjelden stedsnavn med stor forbokstav i en chat ("jeg skal
// fra kolbotn til fred.olsens gate 1"), så den ordvise kandidat-metoden
// over (som krever stor bokstav) bommer fullstendig på slikt. Når meldingen
// har eksplisitte "fra"/"til"-markører, er det mye mer treffsikkert å hente
// ut hele frasen som følger markøren — uavhengig av store/små bokstaver —
// og la Entur geokode frasen direkte. Dette fanger også flerords-adresser
// som "fred.olsens gate 1", som ordvis gjenkjenning ville delt opp feil.
// NB: bevisst ingen \b etter alternativ-gruppen — JS sin \b bygger på \w,
// som ikke regner æ/ø/å som ordtegn, så "på\b" ville aldri truffet. \s+
// foran garanterer allerede at vi står ved en frisk ordstart, og lookahead
// på slutten sjekker at hele ordet er ferdig (ikke midt inni et lengre ord).
// "på" er bevisst IKKE en generell stoppgrense — den brukes også som del av
// selve stedsbeskrivelsen ("Fjellveien 1c på Kolbotn"), så et blankt "på"
// ville kappet bort nødvendig kontekst. Den fungerer kun som stoppord når
// den innleder en ukedag ("på lørdag").
const PHRASE_BOUNDARY = new RegExp(
  `\\s+(?:fra|til|innen|senest|før|etter|klokka|klokken|kl\\.?|på\\s+(?:${WEEKDAYS.join('|')})|i\\s+morgen|i\\s+overmorgen|i\\s+dag|og|${WEEKDAYS.join('|')})(?=\\s|$|[.,!?]).*$`,
  'i'
);

function extractMarkerPhrase(text, markers) {
  const markerPattern = Array.isArray(markers) ? markers.join('|') : markers;
  // "til å <verb>" er en infinitiv-konstruksjon ("nødt til å komme"), ikke
  // et reisemål — ekskluder den, ellers vinner den ofte over det faktiske
  // "til STED" lenger ute i samme setning siden den kommer først.
  const match = (text || '').match(new RegExp(`\\b(?:${markerPattern})(?!\\s+å\\s)\\s+(.+)`, 'i'));
  if (!match) return null;
  let phrase = match[1].replace(PHRASE_BOUNDARY, '').trim();
  // Sikkerhetsnett: ikke dra med resten av en lang setning uten noe tydelig stoppord.
  const words = phrase.split(/\s+/);
  if (words.length > 6) phrase = words.slice(0, 6).join(' ');
  return phrase || null;
}

async function resolvePhrase(phrase, focus) {
  if (!phrase) return null;
  const features = await geocodeAutocomplete(phrase, focus).catch(() => []);
  // Del på både mellomrom OG punktum ("fred.olsens" er ellers ett
  // sammenhengende token som aldri matcher "Fred. Olsens" i Entur-svaret),
  // og hopp over for korte fragmenter (bindestreker, forkortelser).
  const significantWord = phrase.split(/[\s.]+/).find((w) => w.length > 2) || phrase;
  // NB: ingen fallback til "beste fuzzy-treff" her — har vi ingen kandidat
  // som faktisk inneholder ordet vi lette etter, er det bedre å si at vi
  // ikke forsto enn å gjette et sted som bare klang likt (f.eks. "å komme
  // frem" -> "Kommeren, Vennesla").
  return features.find((f) => candidateMatchesFeature(significantWord, f)) || null;
}

async function inferTripFromMessage(text) {
  const fromPhrase = extractMarkerPhrase(text, ['fra']);
  // "til" er vanligst, men folk sier ofte "må ankomme X" / "kommer til X"
  // i stedet når reisen er tidsstyrt av noe (fly, kamp, møte) fremfor et
  // rent "til"-mål.
  const toPhrase = extractMarkerPhrase(text, ['til', 'ankomme', 'kommer til']);

  // Vår faste Trondheim-vekting kan la likt-navngitte steder andre steder i
  // landet ("Kolbotn, Lesja") rangeres foran det brukeren faktisk mener
  // ("Kolbotn, Nordre Follo") når reisen egentlig foregår et helt annet sted
  // i landet. Løs derfor det mest presise endepunktet først (en adresse med
  // gatenummer er sjelden tvetydig), og bruk det til å vekte søket etter det
  // andre — to steder i samme reise ligger typisk nær hverandre.
  const looksLikeAddress = (phrase) => Boolean(phrase && /\d/.test(phrase));
  const phrases = { from: fromPhrase, to: toPhrase };
  const firstKey = looksLikeAddress(toPhrase) || !looksLikeAddress(fromPhrase) ? 'to' : 'from';
  const secondKey = firstKey === 'to' ? 'from' : 'to';

  const resolvedFirst = await resolvePhrase(phrases[firstKey]);
  const resolvedSecond = await resolvePhrase(
    phrases[secondKey],
    resolvedFirst ? { lat: resolvedFirst.lat, lon: resolvedFirst.lon } : undefined
  );

  const fromByMarker = firstKey === 'from' ? resolvedFirst : resolvedSecond;
  const toByMarker = firstKey === 'to' ? resolvedFirst : resolvedSecond;

  if (fromByMarker && toByMarker) {
    return { from: fromByMarker, to: toByMarker };
  }

  // Delvis markørtreff (eller ingen i det hele tatt): la ordvis
  // stedsgjenkjenning (som også dekker underforståtte destinasjoner uten
  // "til") fylle inn resten.
  const resolved = await resolvePlaceCandidates(text);
  const others = resolved.filter((r) => r.place !== fromByMarker && r.place !== toByMarker);

  if (fromByMarker && !toByMarker && others.length === 1) {
    return { from: fromByMarker, to: others[0].place };
  }
  if (!fromByMarker && toByMarker && others.length === 1) {
    return { from: others[0].place, to: toByMarker };
  }
  if (fromByMarker || toByMarker) {
    // Fant nøyaktig ett av stedene sikkert, men usikkert på det andre —
    // for tvetydig til å gjette, be heller om avklaring.
    return null;
  }

  if (!resolved.length) return null;

  const fromMatch = resolved.find((r) => new RegExp(`\\bfra\\s+${escapeRegExp(r.candidate)}`, 'i').test(text));
  const toMatch = resolved.find((r) => new RegExp(`\\btil\\s+${escapeRegExp(r.candidate)}`, 'i').test(text));

  if (fromMatch && toMatch && fromMatch !== toMatch) {
    return { from: fromMatch.place, to: toMatch.place };
  }

  const remaining = resolved.filter((r) => r !== fromMatch && r !== toMatch);

  // "Fra"/"til" er entydige signaler når vi har dem. Uten et av dem gjetter
  // vi kun når det er nøyaktig ett annet bekreftet sted å velge mellom —
  // er det flere kandidater (som i "Vålerenga - Rosenborg på Lerkendal",
  // der alle tre faktisk er ekte stedsnavn) er det for tvetydig, og vi ber
  // heller om avklaring enn å gjette feil.
  if (fromMatch && !toMatch && remaining.length === 1) {
    return { from: fromMatch.place, to: remaining[0].place };
  }
  if (!fromMatch && toMatch && remaining.length === 1) {
    return { from: remaining[0].place, to: toMatch.place };
  }
  if (!fromMatch && !toMatch && resolved.length === 2) {
    return { from: resolved[0].place, to: resolved[1].place };
  }

  return null;
}

// --- Kindly webhook-action: reiseplanlegging for AtB-boten ---------------
// Sett opp en dialog i Kindly (Build > din dialog > Output > Advanced >
// Webhook) med treningsfraser for reiseplanlegging (f.eks. "jeg skal fra X
// til Y", "hvordan kommer jeg meg til X"), og pek webhook-URL-en hit:
//   https://<ditt-domene>/api/kindly/actions/atb-trip-planner
// Kindly sin egen NLU avgjør NÅR denne dialogen trigges og trenger ikke
// forstå Entur/reiseplanlegging selv — den sender med brukerens
// opprinnelige melding (og ev. egne context-variabler for fra/til hvis du
// setter opp entitetsfangst), og vi svarer med reply-teksten Kindly viser
// frem. Se docs.kindly.ai/webhooks for hele kontrakten.
app.post('/api/kindly/actions/atb-trip-planner', async (req, res) => {
  const { message, context } = req.body || {};

  try {
    let fromPlace;
    let toPlace;

    const contextFrom = context && (context.from || context.fra);
    const contextTo = context && (context.to || context.til);

    if (contextFrom && contextTo) {
      const [fromCandidates, toCandidates] = await Promise.all([
        geocodeAutocomplete(contextFrom),
        geocodeAutocomplete(contextTo),
      ]);
      fromPlace = fromCandidates[0];
      toPlace = toCandidates[0];
    } else {
      const inferred = await inferTripFromMessage(message);
      if (inferred) {
        fromPlace = inferred.from;
        toPlace = inferred.to;
      }
    }

    if (!fromPlace || !toPlace) {
      return res.json({
        reply: 'Jeg fikk ikke helt med meg hvor du skal fra og til. Kan du si det litt tydeligere, f.eks. «fra STED til STED»?',
      });
    }

    const timeExpr = parseTimeExpression(message);
    const tripPatterns = await searchTrip(fromPlace, toPlace, timeExpr || {});
    const pattern = pickBestPattern(tripPatterns);

    if (!pattern) {
      return res.json({ reply: `Fant ingen reiseforslag fra ${fromPlace.name} til ${toPlace.name} akkurat nå.` });
    }

    const { reply, price } = formatTripReply(fromPlace, toPlace, pattern, timeExpr);

    res.json({
      reply,
      buttons: [{ button_type: 'quick_reply', label: `Betal kr ${price} med Vipps (demo)`, value: 'betal med vipps' }],
    });
  } catch (err) {
    console.error('Feil i AtB trip-planner-webhook:', err.message);
    res.json({ reply: 'Beklager, jeg klarte ikke å slå opp reisen akkurat nå.' });
  }
});

// --- 2. Kindly -> Backend: webhook med svar -------------------------------
// Denne URL-en (f.eks. https://ditt-domene.no/api/kindly/webhook) setter du
// opp under Connect > Application i Kindly-plattformen.
app.post('/api/kindly/webhook', (req, res) => {
  // Hvis du har satt opp HMAC-signering av webhooken i Kindly, bør du
  // verifisere signaturen her før du stoler på innholdet. Se
  // docs.kindly.ai "Webhook signature (HMAC)" for detaljer.
  if (WEBHOOK_SHARED_SECRET) {
    const signature = req.get('x-kindly-signature');
    // TODO: valider signature mot req.rawBody + WEBHOOK_SHARED_SECRET
    // (krever at du fanger raw body – se kommentar nederst i filen)
  }

  const payload = req.body;
  const userId = payload.user_id || payload.userId;

  console.log('📩 Webhook fra Kindly:', JSON.stringify(payload).slice(0, 300));

  if (!userId) {
    console.warn('Webhook uten user_id, kan ikke rute svaret');
    return res.sendStatus(200); // svar alltid 200 raskt, ellers retryer Kindly
  }

  const ws = connections.get(userId);
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: 'message', payload }));
  } else {
    console.warn(`Ingen aktiv WebSocket for user_id=${userId} – svaret gikk tapt for sanntid`);
    // Her kan du evt. mellomlagre svaret (DB/cache) og hente det ved neste poll/reconnect.
  }

  res.sendStatus(200);
});

server.listen(PORT, () => {
  console.log(`🚀 Server kjører på http://localhost:${PORT}`);
  console.log(`   Webhook-endepunkt (må eksponeres offentlig): /api/kindly/webhook`);
});
