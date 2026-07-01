// chat.js
//
// All logikk for chat-widgeten. Vi styrer 100 % av UI selv – dette skriptet
// snakker kun med VÅR EGEN backend (server.js), aldri direkte med Kindly
// (det er nettopp poenget med headless/Application API: Kindly-nøkkelen skal
// aldri eksponeres i nettleseren).

(function () {
  const STORAGE_KEY = 'kindly_demo_user_id';
  let userId = localStorage.getItem(STORAGE_KEY);

  const messagesEl = document.getElementById('chat-messages');
  const typingEl = document.getElementById('chat-typing');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');

  let ws;
  let hasGreeted = false;

  function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = new URL(`${protocol}://${location.host}/ws`);
    if (userId) url.searchParams.set('user_id', userId);

    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      console.log('WebSocket tilkoblet');
      if (userId) greet();
    });

    ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'session') {
        // Backend genererte en ny user_id til oss – husk den.
        userId = data.userId;
        localStorage.setItem(STORAGE_KEY, userId);
        greet();
      }

      if (data.type === 'message') {
        typingEl.classList.add('hidden');
        renderBotPayload(data.payload);
      }
    });

    ws.addEventListener('close', () => {
      console.log('WebSocket frakoblet, prøver på nytt om 2s …');
      setTimeout(connectWebSocket, 2000);
    });

    ws.addEventListener('error', (err) => console.error('WS-feil', err));
  }

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
    div.textContent = text;
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
        sendMessage(btn.value || btn.payload || label);
      });
      btnContainer.appendChild(b);
    });

    wrapper.appendChild(btnContainer);
    messagesEl.appendChild(wrapper);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function sendMessage(text) {
    typingEl.classList.remove('hidden');
    try {
      await fetch('/api/kindly/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, message: text }),
      });
    } catch (err) {
      typingEl.classList.add('hidden');
      addMessage('Beklager, noe gikk galt. Prøv igjen.', 'bot');
      console.error(err);
    }
  }

  async function greet() {
    if (hasGreeted || !userId) return;
    hasGreeted = true;
    typingEl.classList.remove('hidden');
    try {
      await fetch('/api/kindly/greet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
    } catch (err) {
      typingEl.classList.add('hidden');
      console.error(err);
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    addMessage(text, 'user');
    input.value = '';
    sendMessage(text);
  });

  connectWebSocket();
})();
