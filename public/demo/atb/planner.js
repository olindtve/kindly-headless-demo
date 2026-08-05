// planner.js (AtB-demo)
//
// Reiseplanlegger-widget koblet mot ekte Entur-data via vår egen backend
// (/api/entur/autocomplete og /api/entur/trip — se server.js). Entur er det
// nasjonale reisedata-aggregatet alle norske transportselskaper (inkl. AtB)
// leverer rutedata til, så dette gir reelle Trondheims-reiser, ikke dummy-data.

(function () {
  const fromInput = document.getElementById('planner-from');
  const toInput = document.getElementById('planner-to');
  const fromSuggestions = document.getElementById('planner-from-suggestions');
  const toSuggestions = document.getElementById('planner-to-suggestions');
  const swapBtn = document.querySelector('.planner-swap');
  const submitBtn = document.getElementById('planner-submit');
  const resultsEl = document.getElementById('planner-results');
  const whenModeSelect = document.getElementById('planner-when-mode');
  const datetimeField = document.getElementById('planner-datetime-field');
  const datetimeInput = document.getElementById('planner-datetime');

  function formatForDatetimeLocal(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  whenModeSelect.addEventListener('change', () => {
    const isNow = whenModeSelect.value === 'now';
    datetimeField.classList.toggle('hidden', isNow);
    if (!isNow && !datetimeInput.value) {
      datetimeInput.value = formatForDatetimeLocal(new Date());
    }
  });

  let selected = { from: null, to: null };
  let debounceTimer;

  function setupAutocomplete(input, suggestionsEl, key) {
    input.addEventListener('input', () => {
      selected[key] = null;
      const query = input.value.trim();
      clearTimeout(debounceTimer);

      if (query.length < 2) {
        suggestionsEl.classList.add('hidden');
        suggestionsEl.innerHTML = '';
        return;
      }

      debounceTimer = setTimeout(async () => {
        try {
          const response = await fetch(`/api/entur/autocomplete?q=${encodeURIComponent(query)}`);
          const data = await response.json();
          renderSuggestions(data.features || [], suggestionsEl, input, key);
        } catch (err) {
          console.error('Autocomplete-feil:', err);
        }
      }, 250);
    });

    input.addEventListener('blur', () => {
      // Liten forsinkelse så et klikk på et forslag rekker å registreres først
      setTimeout(() => suggestionsEl.classList.add('hidden'), 150);
    });
  }

  function renderSuggestions(features, suggestionsEl, input, key) {
    suggestionsEl.innerHTML = '';

    if (!features.length) {
      suggestionsEl.classList.add('hidden');
      return;
    }

    features.forEach((feature) => {
      const li = document.createElement('li');
      li.textContent = feature.name;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // hindre blur før klikket når frem
        input.value = feature.name;
        selected[key] = { id: feature.id, name: feature.name, lat: feature.lat, lon: feature.lon };
        suggestionsEl.classList.add('hidden');
      });
      suggestionsEl.appendChild(li);
    });

    suggestionsEl.classList.remove('hidden');
  }

  setupAutocomplete(fromInput, fromSuggestions, 'from');
  setupAutocomplete(toInput, toSuggestions, 'to');

  swapBtn.addEventListener('click', () => {
    const fromValue = fromInput.value;
    const toValue = toInput.value;
    fromInput.value = toValue;
    toInput.value = fromValue;
    const tmp = selected.from;
    selected.from = selected.to;
    selected.to = tmp;
  });

  function formatTime(iso) {
    return new Date(iso).toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' });
  }

  function formatPlace(place) {
    const code = place.quay && place.quay.publicCode;
    return code ? `${place.name} (spor ${code})` : place.name;
  }

  // Entur bruker linjens offisielle navn ("Stabekk-Oslo S-Ski") som lister
  // linjens ytterpunkter, ikke retningen for DENNE avgangen — vis derfor
  // alltid faktisk fra/til istedenfor (eller i tillegg til) linjenavnet.
  const DIRECTION_LABELS = {
    depart: 'Start',
    continue: 'Fortsett',
    left: 'Sving venstre',
    right: 'Sving høyre',
    slightly_left: 'Ta til venstre',
    slightly_right: 'Ta til høyre',
    hard_left: 'Sving skarpt til venstre',
    hard_right: 'Sving skarpt til høyre',
    uturn_left: 'Snu',
    uturn_right: 'Snu',
    elevator: 'Ta heisen',
    circle_clockwise: 'Følg rundkjøringen',
    circle_counterclockwise: 'Følg rundkjøringen',
  };

  function renderLegDetails(leg) {
    const wrap = document.createElement('div');
    wrap.className = 'trip-leg-details hidden';

    if (leg.mode === 'foot') {
      const meters = Math.round(leg.distance);
      const minutes = Math.max(1, Math.round((new Date(leg.expectedEndTime) - new Date(leg.expectedStartTime)) / 60000));
      const summary = document.createElement('p');
      summary.className = 'trip-detail-summary';
      summary.textContent = `Gå ca. ${meters} m (${minutes} min)`;
      wrap.appendChild(summary);

      if (leg.steps && leg.steps.length) {
        const list = document.createElement('ol');
        list.className = 'trip-steps';
        leg.steps.forEach((step) => {
          const li = document.createElement('li');
          const direction = DIRECTION_LABELS[(step.relativeDirection || '').toLowerCase()] || 'Fortsett';
          const street = step.streetName && step.streetName !== 'gangvei' ? ` (${step.streetName})` : '';
          li.textContent = `${direction}${street} – ${Math.round(step.distance)} m`;
          list.appendChild(li);
        });
        wrap.appendChild(list);
      }
    } else if (leg.intermediateEstimatedCalls && leg.intermediateEstimatedCalls.length) {
      const list = document.createElement('ol');
      list.className = 'trip-stops';
      leg.intermediateEstimatedCalls.forEach((call) => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${formatTime(call.expectedArrivalTime)}</span> ${call.quay.name}`;
        list.appendChild(li);
      });
      wrap.appendChild(list);
    } else {
      const summary = document.createElement('p');
      summary.className = 'trip-detail-summary';
      summary.textContent = 'Ingen mellomstopp registrert for denne etappen.';
      wrap.appendChild(summary);
    }

    return wrap;
  }

  function renderResults(tripPatterns) {
    resultsEl.innerHTML = '';

    if (!tripPatterns.length) {
      resultsEl.innerHTML = '<p class="planner-results-empty">Fant ingen reiseforslag akkurat nå.</p>';
      return;
    }

    tripPatterns.forEach((pattern) => {
      const card = document.createElement('div');
      card.className = 'trip-card';

      const summary = document.createElement('div');
      summary.className = 'trip-summary';
      const minutes = Math.round(pattern.duration / 60);
      summary.innerHTML = `<strong>${formatTime(pattern.startTime)} – ${formatTime(pattern.endTime)}</strong><span>${minutes} min</span>`;
      card.appendChild(summary);

      const legs = document.createElement('div');
      legs.className = 'trip-legs';

      pattern.legs.forEach((leg) => {
        const block = document.createElement('div');
        block.className = 'trip-leg-block';

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'trip-leg';

        if (leg.mode === 'foot') {
          const meters = Math.round(leg.distance);
          toggle.textContent = `${formatTime(leg.expectedStartTime)} Gange · ${formatPlace(leg.fromPlace)} → ${formatPlace(leg.toPlace)} (${meters} m)`;
        } else {
          const code = leg.line ? leg.line.publicCode : leg.mode;
          toggle.textContent = `${formatTime(leg.expectedStartTime)} ${code} · ${formatPlace(leg.fromPlace)} → ${formatPlace(leg.toPlace)}`;
        }

        const details = renderLegDetails(leg);
        toggle.setAttribute('aria-expanded', 'false');
        toggle.addEventListener('click', () => {
          const isHidden = details.classList.toggle('hidden');
          toggle.setAttribute('aria-expanded', String(!isHidden));
        });

        block.appendChild(toggle);
        block.appendChild(details);
        legs.appendChild(block);
      });

      card.appendChild(legs);
      resultsEl.appendChild(card);
    });
  }

  submitBtn.addEventListener('click', async () => {
    if (!selected.from || !selected.to) {
      resultsEl.innerHTML = '<p class="planner-results-empty">Velg et sted fra listen i både Fra- og Til-feltet.</p>';
      return;
    }

    resultsEl.innerHTML = '<p class="planner-results-empty">Søker …</p>';

    const whenMode = whenModeSelect.value;
    const body = { from: selected.from, to: selected.to };
    if (whenMode !== 'now' && datetimeInput.value) {
      // <input type="datetime-local"> gir lokal tid uten tidssone-suffiks;
      // Entur forventer en fullverdig ISO 8601-dato.
      body.dateTime = new Date(datetimeInput.value).toISOString();
      body.arriveBy = whenMode === 'arrive';
    }

    try {
      const response = await fetch('/api/entur/trip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();

      if (!response.ok) {
        resultsEl.innerHTML = '<p class="planner-results-empty">Klarte ikke å hente reiseforslag akkurat nå.</p>';
        console.error('Trip-søk feilet:', data);
        return;
      }

      renderResults(data.tripPatterns || []);
    } catch (err) {
      resultsEl.innerHTML = '<p class="planner-results-empty">Klarte ikke å nå reiseplanleggeren.</p>';
      console.error('Feil ved reisesøk:', err);
    }
  });
})();
