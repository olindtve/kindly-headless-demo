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

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    addMessage(text, 'user');
    input.value = '';
    KindlyChat.sendMessage(text);
  });
})();
