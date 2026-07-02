// kindly-chat-core.js
//
// Delt tilkoblingslogikk for alle demo-varianter: WebSocket-tilkobling mot vår
// egen backend (server.js), reconnect (inkl. når fanen får fokus igjen etter
// at en bakgrunnsfane ble frakoblet), og send/greet-kall. Demo-spesifikke
// sider abonnerer på hendelser herfra og står selv for all rendering/DOM.
//
// Bruk: <script src="/shared/kindly-chat-core.js"></script> før demoens egen
// chat.js. Eksponerer window.KindlyChat = { on, sendMessage, greet, getUserId }.

window.KindlyChat = (function () {
  const STORAGE_KEY = 'kindly_demo_user_id';
  let userId = localStorage.getItem(STORAGE_KEY);
  let ws;
  let hasGreeted = false;

  const listeners = { message: [], session: [], typingStart: [], typingEnd: [] };

  function on(event, callback) {
    if (!listeners[event]) throw new Error(`Ukjent KindlyChat-hendelse: ${event}`);
    listeners[event].push(callback);
  }

  function emit(event, payload) {
    listeners[event].forEach((callback) => callback(payload));
  }

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
        emit('session', userId);
        greet();
      }

      if (data.type === 'message') {
        emit('typingEnd');
        emit('message', data.payload);
      }
    });

    ws.addEventListener('close', () => {
      console.log('WebSocket frakoblet, prøver på nytt om 2s …');
      setTimeout(connectWebSocket, 2000);
    });

    ws.addEventListener('error', (err) => console.error('WS-feil', err));
  }

  // Bakgrunnsfaner får throttlet setTimeout av nettleseren, så en reconnect
  // etter tap av tilkobling (f.eks. en serverdeploy) kan bli hengende lenge
  // hvis fanen ikke er i fokus. Sjekk og koble til på nytt med det samme når
  // fanen får fokus igjen.
  document.addEventListener('visibilitychange', () => {
    if (
      document.visibilityState === 'visible' &&
      ws &&
      ws.readyState !== WebSocket.OPEN &&
      ws.readyState !== WebSocket.CONNECTING
    ) {
      connectWebSocket();
    }
  });

  async function sendMessage(text) {
    emit('typingStart');
    try {
      await fetch('/api/kindly/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, message: text }),
      });
    } catch (err) {
      emit('typingEnd');
      console.error(err);
    }
  }

  async function greet() {
    if (hasGreeted || !userId) return;
    hasGreeted = true;
    emit('typingStart');
    try {
      await fetch('/api/kindly/greet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
    } catch (err) {
      emit('typingEnd');
      console.error(err);
    }
  }

  connectWebSocket();

  return { on, sendMessage, greet, getUserId: () => userId };
})();
