# Kindly Headless – demo-oppsett

Dette er et komplett, kjørbart oppsett:
- **Dummy nettside** (`public/`) med egendesignet chat-widget (ren HTML/CSS/JS, ingen rammeverk).
- **Backend** (`server.js`, Node/Express + WebSocket) som bygger bro mellom frontend og din bot på Kindly via **Application API** (headless).

## Hvorfor en backend i midten?

Kindlys Application API svarer **asynkront via webhook** – ikke som direkte svar på meldingen du sender. Webhooken må gå til en offentlig URL på en server, ikke rett til nettleseren. Backend-en her:
1. Tar imot meldinger fra frontend og sender dem videre til Kindly (med API-nøkkelen skjult server-side).
2. Tar imot Kindlys webhook-svar og pusher dem videre til riktig nettleser via WebSocket.

## 1. Installer avhengigheter

```bash
cd kindly-headless-demo
npm install
```

## 2. Opprett en "Application" i Kindly

1. Gå til [app.kindly.ai](https://app.kindly.ai) → velg boten din.
2. Connect → Application → New application.
3. Gi den et navn.
4. Legg inn webhook-URL (se steg 4 under for hvordan du får en offentlig URL lokalt).
5. Trykk Create – du får en **API-nøkkel** (bearer token).

## 3. Konfigurer miljøvariabler

```bash
cp .env.example .env
```

Åpne `.env` og lim inn API-nøkkelen din:

```
KINDLY_API_KEY=din-nøkkel-her
```

## 4. Eksponer webhooken offentlig (kun for lokal utvikling)

Kindly må kunne nå `/api/kindly/webhook` på internett. Lokalt kan du bruke f.eks. [ngrok](https://ngrok.com/):

```bash
npx ngrok http 3000
```

Kopier `https://xxxx.ngrok.app`-URLen og sett webhook-URL i Kindly-applikasjonen til:

```
https://xxxx.ngrok.app/api/kindly/webhook
```

I produksjon bruker du selvfølgelig ditt faktiske domene i stedet.

## 5. Start serveren

```bash
npm start
```

Åpne [http://localhost:3000](http://localhost:3000) – klikk på chat-ikonet nederst til høyre.

## Viktig: sjekk faktisk payload-format

Kindlys webhook-payload kan variere litt avhengig av hvordan boten din er satt opp (rene tekstsvar, knapper, kort/karusell, skjema, osv.). `chat.js` har en `renderBotPayload()`-funksjon som dekker de vanligste feltene (`text`, `message`, `buttons`), men **logger alltid rådata i konsollen** (`console.log('Bot-payload:', payload)`). Åpne dev-tools første gang du tester, se hva boten din faktisk sender, og juster rendering-funksjonen etter behov.

## Filstruktur

```
kindly-headless-demo/
├── server.js          # Backend: /api/kindly/send, /api/kindly/greet, /api/kindly/webhook, WS-server
├── package.json
├── .env.example
└── public/
    ├── index.html      # Dummy-nettside
    ├── style.css        # Styling for side + chat-widget
    └── chat.js          # All chat-logikk (WebSocket + fetch mot egen backend)
```

## Neste steg / produksjonshensyn

- **Skalering:** `connections`-mappet i `server.js` er in-memory. Kjører du flere server-instanser, må du bytte til Redis pub/sub (eller lignende) slik at webhook-svar finner riktig node.
- **Sikkerhet:** Vurder å aktivere HMAC-signering av webhooken i Kindly og verifisere signaturen i `/api/kindly/webhook` (se `docs.kindly.ai` → "Webhook signature (HMAC)").
- **Persistens:** Hvis en bruker laster siden på nytt midt i en samtale, hentes ikke historikk automatisk her – vurder å hente chat-transcript via Kindlys Chat Transcript API (`GET /api/v1/chats/{chatId}`) ved reconnect.
- **Autentisering av brukere:** Hvis du vil identifisere innloggede brukere i Kindly Inbox, se Kindlys guide for JWT-basert brukerautentisering.
