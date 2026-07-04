// chat.js (AtB-demo)
//
// DOM-rendering for AtB-assistenten. All tilkoblingslogikk (WebSocket,
// reconnect, send/greet) ligger i den delte /shared/kindly-chat-core.js —
// denne filen abonnerer bare på hendelser derfra og tegner meldingene.

(function () {
  const messagesEl = document.getElementById('chat-messages');
  const typingEl = document.getElementById('chat-typing');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');

  // NB: Det eksakte formatet på Kindlys webhook-payload kan variere
  // avhengig av dialogoppsettet ditt (tekst, knapper, kort/karusell osv).
  // Denne funksjonen dekker de vanligste feltene, men logger alltid
  // rådata i konsollen slik at du enkelt kan justere rendering etter
  // hva DIN bot faktisk sender.
  function renderBotPayload(payload) {
    console.log('Bot-payload:', payload);

    const messages = payload.messages || payload.answer || [payload];
    const list = Array.isArray(messages) ? messages : [messages];

    list.forEach((m) => {
      if (!m) return;
      const text = m.text || m.message || (typeof m === 'string' ? m : null);
      if (text) addMessage(text, 'bot');

      const buttons = m.buttons || payload.buttons;
      if (Array.isArray(buttons) && buttons.length) {
        addButtons(buttons);
      }
    });

    // Fallback hvis vi ikke fant noe kjent tekstfelt
    if (!list.some((m) => m && (m.text || m.message))) {
      addMessage(JSON.stringify(payload, null, 2), 'bot');
    }
  }

  function addMessage(text, sender) {
    const div = document.createElement('div');
    div.className = `msg ${sender}`;
    // Kindly-svar kan inneholde HTML (linjeskift, lenker) fra boten. Det er
    // innhold botadministratoren selv har konfigurert, så vi rendrer det som
    // HTML. Meldinger brukeren skriver selv vises alltid som ren tekst.
    if (sender === 'bot') {
      div.innerHTML = text;
    } else {
      div.textContent = text;
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addButtons(buttons) {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg bot';
    const btnContainer = document.createElement('div');
    btnContainer.className = 'buttons';

    buttons.forEach((btn) => {
      const label = btn.title || btn.text || btn.label || 'Velg';
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => {
        addMessage(label, 'user');
        KindlyChat.sendMessage(btn.value || btn.payload || label);
      });
      btnContainer.appendChild(b);
    });

    wrapper.appendChild(btnContainer);
    messagesEl.appendChild(wrapper);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  KindlyChat.on('typingStart', () => typingEl.classList.remove('hidden'));
  KindlyChat.on('typingEnd', () => typingEl.classList.add('hidden'));
  KindlyChat.on('message', renderBotPayload);

  // --- Reiseplanlegging rett i samtalen ------------------------------------
  // Kindly-boten selv har ingen kjennskap til Entur/reiseplanlegging (det
  // krever dialogoppsett på Kindly-siden, utenfor denne kodebasen). For å
  // vise frem hva en reell integrasjon kunne gjøre, kjenner vi lokalt igjen
  // et enkelt "fra X til Y"-mønster og svarer selv med ekte Entur-data i
  // stedet for å sende meldingen videre til Kindly. Alt annet går som før
  // til den vanlige boten.
  function parseTravelIntent(text) {
    const match = text.match(/fra\s+(.+?)\s+til\s+(.+)/i);
    if (!match) return null;

    const from = match[1].trim().replace(/[.?!]+$/, '');
    let to = match[2].trim();

    // Kutt bort en eventuell tids-frase på slutten, f.eks. "Moholt klokka ni"
    const timeMatch = to.match(/^(.*?)\s+(?:klokka|kl\.?)\s+.+$/i);
    if (timeMatch) to = timeMatch[1];
    to = to.trim().replace(/[.?!]+$/, '');

    if (!from || !to) return null;
    return { from, to };
  }

  async function geocodeTop(text) {
    const response = await fetch(`/api/entur/autocomplete?q=${encodeURIComponent(text)}`);
    const data = await response.json();
    return (data.features && data.features[0]) || null;
  }

  function addVippsButton(ticketLabel, price) {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg bot';
    const btn = document.createElement('button');
    btn.className = 'vipps-button';
    btn.textContent = `Betal kr ${price} med Vipps (demo)`;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Behandler betaling …';
      setTimeout(() => {
        addMessage(`✅ (Demo) Betaling bekreftet med Vipps — ${ticketLabel} er nå aktiv i AtB Mobillett.`, 'bot');
      }, 900);
    });
    wrapper.appendChild(btn);
    messagesEl.appendChild(wrapper);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function handleTravelIntent(intent) {
    typingEl.classList.remove('hidden');
    try {
      const [fromPlace, toPlace] = await Promise.all([
        geocodeTop(intent.from),
        geocodeTop(intent.to),
      ]);

      if (!fromPlace || !toPlace) {
        typingEl.classList.add('hidden');
        const missing = !fromPlace ? intent.from : intent.to;
        addMessage(`Fant ikke stedet «${missing}». Kan du prøve å skrive det litt annerledes?`, 'bot');
        return;
      }

      const tripResponse = await fetch('/api/entur/trip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: fromPlace, to: toPlace }),
      });
      const tripData = await tripResponse.json();
      typingEl.classList.add('hidden');

      // Entur rangerer noen ganger en ren gangtur øverst hvis den er raskere
      // enn å vente på buss. Det er teknisk riktig, men et dårlig
      // utstillingsvindu for en kollektivselskap-demo — foretrekk et
      // alternativ med faktisk kollektivtransport når et slikt finnes.
      const patterns = tripData.tripPatterns || [];
      const pattern = patterns.find((p) => p.legs.some((leg) => leg.mode !== 'foot')) || patterns[0];
      if (!pattern) {
        addMessage(`Fant ingen reiseforslag fra ${fromPlace.name} til ${toPlace.name} akkurat nå.`, 'bot');
        return;
      }

      const start = new Date(pattern.startTime).toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' });
      const end = new Date(pattern.endTime).toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' });
      const minutes = Math.round(pattern.duration / 60);
      const transitLegs = pattern.legs.filter((leg) => leg.mode !== 'foot');
      const lineText = transitLegs.length
        ? transitLegs
            .map((leg) => (leg.line ? `${leg.line.publicCode} ${leg.line.name}` : leg.mode))
            .join(' → ')
        : 'gange hele veien';

      addMessage(
        `Beste reise fra ${fromPlace.name} til ${toPlace.name}: avgang ${start}, fremme ${end} (${minutes} min) med ${lineText}.`,
        'bot'
      );

      // Enkel billettanbefaling basert på AtBs sonemodell. Prisene under er
      // illustrative demo-tall, ikke reelle AtB-priser.
      const sameZone = fromPlace.zone && toPlace.zone && fromPlace.zone === toPlace.zone;
      const ticketLabel = sameZone ? 'Enkeltbillett, 1 sone' : 'Enkeltbillett, 2 soner';
      const price = sameZone ? '41' : '60';

      addMessage(
        `Basert på reisen anbefaler jeg <strong>${ticketLabel}</strong> (ca. kr ${price},- illustrativ demo-pris).`,
        'bot'
      );
      addVippsButton(ticketLabel, price);
    } catch (err) {
      typingEl.classList.add('hidden');
      addMessage('Beklager, klarte ikke å slå opp reisen akkurat nå.', 'bot');
      console.error(err);
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    addMessage(text, 'user');
    input.value = '';

    const intent = parseTravelIntent(text);
    if (intent) {
      handleTravelIntent(intent);
    } else {
      KindlyChat.sendMessage(text);
    }
  });
})();
