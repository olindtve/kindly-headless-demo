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
      pattern.legs
        .filter((leg) => leg.mode !== 'foot')
        .forEach((leg) => {
          const tag = document.createElement('span');
          tag.className = 'trip-leg';
          tag.textContent = leg.line ? `${leg.line.publicCode} ${leg.line.name}` : leg.mode;
          legs.appendChild(tag);
        });
      if (!legs.children.length) {
        const tag = document.createElement('span');
        tag.className = 'trip-leg';
        tag.textContent = 'Gange hele veien';
        legs.appendChild(tag);
      }
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

    try {
      const response = await fetch('/api/entur/trip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: selected.from, to: selected.to }),
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
