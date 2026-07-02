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
