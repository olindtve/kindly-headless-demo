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

async function geocodeAutocomplete(q) {
  if (!q || q.trim().length < 2) return [];

  const url =
    `${ENTUR_GEOCODER_URL}?text=${encodeURIComponent(q)}&lang=no&size=5` +
    `&focus.point.lat=${TRONDHEIM_CENTER.lat}&focus.point.lon=${TRONDHEIM_CENTER.lon}`;
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

async function searchTrip(from, to) {
  const query = `
    query($from: Location!, $to: Location!) {
      trip(from: $from, to: $to, numTripPatterns: 3) {
        tripPatterns {
          startTime
          endTime
          duration
          legs {
            mode
            line { publicCode name }
            fromPlace { name }
            toPlace { name }
            expectedStartTime
            expectedEndTime
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
  const { from, to } = req.body;
  if (!from || !to) {
    return res.status(400).json({ error: 'from og to er påkrevd' });
  }

  try {
    const tripPatterns = await searchTrip(from, to);
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

function formatTripReply(fromPlace, toPlace, pattern) {
  const start = new Date(pattern.startTime).toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' });
  const end = new Date(pattern.endTime).toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' });
  const minutes = Math.round(pattern.duration / 60);
  const transitLegs = pattern.legs.filter((leg) => leg.mode !== 'foot');
  const lineText = transitLegs.length
    ? transitLegs.map((leg) => (leg.line ? `${leg.line.publicCode} ${leg.line.name}` : leg.mode)).join(' → ')
    : 'gange hele veien';

  // Enkel billettanbefaling basert på AtBs sonemodell. Prisene er
  // illustrative demo-tall, ikke reelle AtB-priser.
  const sameZone = fromPlace.zone && toPlace.zone && fromPlace.zone === toPlace.zone;
  const ticketLabel = sameZone ? 'Enkeltbillett, 1 sone' : 'Enkeltbillett, 2 soner';
  const price = sameZone ? '41' : '60';

  const reply =
    `Beste reise fra ${fromPlace.name} til ${toPlace.name}: avgang ${start}, fremme ${end} ` +
    `(${minutes} min) med ${lineText}.\n\n` +
    `Basert på reisen anbefaler jeg ${ticketLabel} (ca. kr ${price},- illustrativ demo-pris).`;

  return { reply, ticketLabel, price };
}

// Kjenner igjen et enkelt "fra X til Y"-mønster i en fritekstmelding. Brukes
// som fallback i Kindly-webhooken nedenfor hvis dialogen ikke selv har
// hentet ut fra/til som egne context-variabler.
function parseTravelIntent(text) {
  const match = (text || '').match(/fra\s+(.+?)\s+til\s+(.+)/i);
  if (!match) return null;

  const from = match[1].trim().replace(/[.?!]+$/, '');
  let to = match[2].trim();

  const timeMatch = to.match(/^(.*?)\s+(?:klokka|kl\.?)\s+.+$/i);
  if (timeMatch) to = timeMatch[1];
  to = to.trim().replace(/[.?!]+$/, '');

  if (!from || !to) return null;
  return { from, to };
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

  let fromText = context && (context.from || context.fra);
  let toText = context && (context.to || context.til);

  if (!fromText || !toText) {
    const intent = parseTravelIntent(message);
    if (intent) {
      fromText = fromText || intent.from;
      toText = toText || intent.to;
    }
  }

  if (!fromText || !toText) {
    return res.json({
      reply: 'Jeg fikk ikke helt med meg hvor du skal fra og til. Kan du prøve på formen «fra STED til STED»?',
    });
  }

  try {
    const [fromCandidates, toCandidates] = await Promise.all([
      geocodeAutocomplete(fromText),
      geocodeAutocomplete(toText),
    ]);
    const fromPlace = fromCandidates[0];
    const toPlace = toCandidates[0];

    if (!fromPlace || !toPlace) {
      const missing = !fromPlace ? fromText : toText;
      return res.json({ reply: `Fant ikke stedet «${missing}». Kan du prøve å skrive det litt annerledes?` });
    }

    const tripPatterns = await searchTrip(fromPlace, toPlace);
    const pattern = pickBestPattern(tripPatterns);

    if (!pattern) {
      return res.json({ reply: `Fant ingen reiseforslag fra ${fromPlace.name} til ${toPlace.name} akkurat nå.` });
    }

    const { reply, price } = formatTripReply(fromPlace, toPlace, pattern);

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
