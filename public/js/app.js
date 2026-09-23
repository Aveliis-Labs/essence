/* =========================================================================
   Application cliente (JavaScript natif, aucune dependance
   hors Leaflet). Tout tient dans un seul fichier volontairement lineaire :
   etat -> rendu -> evenements.
   ========================================================================= */
'use strict';

(function () {

  // -----------------------------------------------------------------------
  // Constantes
  // -----------------------------------------------------------------------

  const STOCKAGE = 'essence.prefs.v1';
  const API_ADRESSE = 'https://api-adresse.data.gouv.fr/search/';
  const CENTRE_FRANCE = { lat: 46.6, lon: 2.4, zoom: 6 };
  const RAYON_KM = 15;          // rayon par defaut d'une recherche « autour de moi »
  const MAX_STATIONS = 200;     // borne haute cote client
  const RAFRAICHISSEMENT_MS = 10 * 60 * 1000;   // re-interrogation d'un onglet laisse ouvert

  // Libelles par defaut, remplaces par /api/meta au chargement.
  let CARBURANTS = [
    { code: 'gazole', label: 'Gazole', fullLabel: 'Gazole (Diesel)' },
    { code: 'e10',    label: 'E10',    fullLabel: 'SP95-E10' },
    { code: 'sp98',   label: 'SP98',   fullLabel: 'Sans plomb 98' },
    { code: 'sp95',   label: 'SP95',   fullLabel: 'Sans plomb 95' },
    { code: 'e85',    label: 'E85',    fullLabel: 'Superethanol E85' },
    { code: 'gplc',   label: 'GPL',    fullLabel: 'GPL carburant' }
  ];

  // -----------------------------------------------------------------------
  // Etat applicatif
  // -----------------------------------------------------------------------

  const etat = {
    position: null,      // { lat, lon, label } — point de reference
    carburant: 'gazole',
    tri: 'distance',     // 'distance' | 'prix'
    vue: 'carte',        // 'carte' | 'liste' (mobile uniquement)
    stations: [],
    selection: null,     // id de la station mise en avant
    majDonnees: null,
    mode: 'rayon'        // derniere requete : 'rayon' | 'emprise'
  };

  let carte, coucheMarqueurs, marqueurMoi, cercleRayon;
  const marqueurs = new Map();   // id station -> marqueur Leaflet
  let instantDeplacementProgramme = 0;   // horodatage du dernier recadrage automatique
  let requeteEnCours = null;     // AbortController de la requete stations
  let popupOuverte = false;      // ne pas rafraichir sous les doigts de l'utilisateur
  let dernierChargement = 0;

  // -----------------------------------------------------------------------
  // Raccourcis DOM
  // -----------------------------------------------------------------------

  const $ = (sel) => document.querySelector(sel);
  const el = {
    recherche:    $('#recherche'),
    effacer:      $('#btn-effacer'),
    suggestions:  $('#suggestions'),
    geoloc:       $('#btn-geoloc'),
    filtres:      $('#filtres-carburant'),
    tris:         document.querySelectorAll('.tri__btn'),
    contenu:      $('.contenu'),
    liste:        $('#liste'),
    resume:       $('#resume'),
    maj:          $('#maj'),
    compte:       $('#bascule-compte'),
    bascules:     document.querySelectorAll('.bascule__btn'),
    toast:        $('#toast')
  };

  // -----------------------------------------------------------------------
  // Utilitaires
  // -----------------------------------------------------------------------

  const echappe = (str) => String(str ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** 2.469 -> « 2,469 » (nombre seul, virgule decimale) */
  const formateNombre = (v) => v.toFixed(3).replace('.', ',');
  /** 2.469 -> « 2,469 € » */
  const formatePrix = (v) => `${formateNombre(v)} €`;

  /** 0.85 -> « 850 m » ; 2.43 -> « 2,4 km » */
  function formateDistance(km) {
    if (km == null) return '';
    if (km < 1) return `${Math.round(km * 1000)} m`;
    return `${km.toFixed(1).replace('.', ',')} km`;
  }

  /** Date ISO -> « aujourd'hui », « hier », « il y a 4 j », sinon date courte. */
  function formateAnciennete(iso) {
    if (!iso) return 'date inconnue';
    const jours = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
    if (Number.isNaN(jours)) return 'date inconnue';
    if (jours <= 0) return "maj aujourd'hui";
    if (jours === 1) return 'maj hier';
    if (jours < 30) return `maj il y a ${jours} j`;
    return `maj le ${new Date(iso).toLocaleDateString('fr-FR')}`;
  }

  /** Nom affichable d'une station (le flux officiel n'en fournit pas toujours). */
  const nomStation = (s) => s.nom || s.marque || 'Station-service';

  let minuterieToast;
  function toast(message, duree = 3200) {
    clearTimeout(minuterieToast);
    el.toast.textContent = message;
    el.toast.hidden = false;
    minuterieToast = setTimeout(() => { el.toast.hidden = true; }, duree);
  }

  function anti_rebond(fn, delai) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delai); };
  }

  // --- Preferences persistantes (derniere position, carburant, tri) --------

  function chargePrefs() {
    try {
      const brut = localStorage.getItem(STOCKAGE);
      if (!brut) return;
      const p = JSON.parse(brut);
      if (p.position && Number.isFinite(p.position.lat) && Number.isFinite(p.position.lon)) {
        etat.position = p.position;
      }
      if (CARBURANTS.some((c) => c.code === p.carburant)) etat.carburant = p.carburant;
      if (p.tri === 'prix' || p.tri === 'distance') etat.tri = p.tri;
    } catch { /* stockage indisponible (navigation privee) : on ignore */ }
  }

  function sauvePrefs() {
    try {
      localStorage.setItem(STOCKAGE, JSON.stringify({
        position: etat.position, carburant: etat.carburant, tri: etat.tri
      }));
    } catch { /* quota ou mode prive : sans consequence */ }
  }

  // -----------------------------------------------------------------------
  // Carte
  // -----------------------------------------------------------------------

  function initCarte() {
    carte = L.map('carte', {
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true
    }).setView([CENTRE_FRANCE.lat, CENTRE_FRANCE.lon], CENTRE_FRANCE.zoom);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      minZoom: 5,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> — prix : <a href="https://data.economie.gouv.fr">data.economie.gouv.fr</a>'
    }).addTo(carte);

    L.control.zoom({ position: 'bottomright' }).addTo(carte);
    coucheMarqueurs = L.layerGroup().addTo(carte);

    carte.on('popupopen', () => { popupOuverte = true; });
    carte.on('popupclose', () => { popupOuverte = false; });

    // Re-interrogation bornee a la fenetre visible apres un deplacement manuel.
    carte.on('moveend', anti_rebond(() => {
      // Un recadrage declenche par l'app (selection, nouvelle adresse) ne doit
      // pas relancer de requete : on ignore les moveend qui le suivent de pres.
      if (Date.now() - instantDeplacementProgramme < 1000) return;
      if (!etat.position) return;
      if (carte.getZoom() < 9) return;   // trop dezoomee : requete inutile
      charge({ mode: 'emprise' });
    }, 450));
  }

  /** Deplace la carte sans declencher de rechargement. */
  function vaVers(lat, lon, zoom) {
    instantDeplacementProgramme = Date.now();
    carte.setView([lat, lon], zoom ?? carte.getZoom());
  }

  /** Marqueur bleu « vous etes ici » + cercle du rayon de recherche. */
  function dessinePosition() {
    if (!etat.position) return;
    const { lat, lon } = etat.position;

    if (marqueurMoi) marqueurMoi.setLatLng([lat, lon]);
    else marqueurMoi = L.marker([lat, lon], {
      icon: L.divIcon({ className: '', html: '<div class="marqueur-moi"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
      interactive: false,
      zIndexOffset: 500
    }).addTo(carte);

    if (cercleRayon) cercleRayon.setLatLng([lat, lon]);
    else cercleRayon = L.circle([lat, lon], {
      radius: RAYON_KM * 1000,
      color: '#0f7b4f', weight: 1, opacity: .35, fillOpacity: .04, interactive: false
    }).addTo(carte);
  }

  // -----------------------------------------------------------------------
  // Chargement des stations
  // -----------------------------------------------------------------------

  /**
   * @param {{mode?: 'rayon'|'emprise'}} options
   *   - 'rayon'   : cercle de RAYON_KM autour du point de reference
   *   - 'emprise' : uniquement les stations de la fenetre carte visible
   * @param {boolean} options.silencieux  true pour un rafraichissement de fond
   */
  async function charge({ mode = 'rayon', silencieux = false } = {}) {
    if (!etat.position) return;
    etat.mode = mode;

    requeteEnCours?.abort();
    requeteEnCours = new AbortController();

    const params = new URLSearchParams({
      lat: etat.position.lat.toFixed(5),
      lon: etat.position.lon.toFixed(5),
      carburant: etat.carburant,
      tri: etat.tri,
      limite: String(MAX_STATIONS)
    });

    if (mode === 'emprise') {
      const b = carte.getBounds();
      params.set('bbox', [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
        .map((v) => v.toFixed(4)).join(','));
    } else {
      params.set('rayon', String(RAYON_KM));
    }

    if (!silencieux) el.resume.textContent = 'Recherche des stations…';

    try {
      const res = await fetch(`/api/stations?${params}`, { signal: requeteEnCours.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      etat.stations = data.stations || [];
      etat.majDonnees = data.misAJourLe;
      dernierChargement = Date.now();
      rend();
    } catch (err) {
      if (err.name === 'AbortError') return;   // requete remplacee : normal
      console.error(err);
      if (silencieux) return;                  // echec de fond : on garde l'affichage courant
      el.resume.textContent = 'Données momentanément indisponibles.';
      toast('Impossible de récupérer les prix. Réessayez dans un instant.');
    }
  }

  // -----------------------------------------------------------------------
  // Rendu
  // -----------------------------------------------------------------------

  /**
   * Classe de couleur d'un prix, relative aux stations affichees :
   * tiers bas = vert, tiers median = ambre, tiers haut = rouge.
   */
  function echellePrix(stations, carburant) {
    const prix = stations.map((s) => s.prix[carburant]?.v).filter(Number.isFinite).sort((a, b) => a - b);
    if (prix.length < 3) return () => 'p-bas';
    const q1 = prix[Math.floor(prix.length / 3)];
    const q2 = prix[Math.floor((prix.length * 2) / 3)];
    return (v) => (v <= q1 ? 'p-bas' : v <= q2 ? 'p-moyen' : 'p-haut');
  }

  function lienGoogleMaps(s) {
    return `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}`;
  }
  function lienWaze(s) {
    return `https://waze.com/ul?ll=${s.lat},${s.lon}&navigate=yes`;
  }

  function actionsHtml(s) {
    return `<a class="action" href="${lienGoogleMaps(s)}" target="_blank" rel="noopener noreferrer">Google&nbsp;Maps</a>` +
           `<a class="action" href="${lienWaze(s)}" target="_blank" rel="noopener noreferrer">Waze</a>`;
  }

  function rend() {
    rendListe();
    rendMarqueurs();

    const n = etat.stations.length;
    const nomCarburant = CARBURANTS.find((c) => c.code === etat.carburant)?.label || etat.carburant;
    el.resume.textContent = n
      ? `${n} station${n > 1 ? 's' : ''} • ${nomCarburant} • ${etat.tri === 'prix' ? 'moins cher d’abord' : 'plus proche d’abord'}`
      : 'Aucune station trouvée ici.';
    el.compte.textContent = n || '';
    el.maj.textContent = etat.majDonnees
      ? `Données du ${new Date(etat.majDonnees).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
      : '';
  }

  function rendListe() {
    if (!etat.stations.length) {
      el.liste.innerHTML = `<li class="vide">Aucune station ne propose ce carburant dans cette zone.<br>Essayez un autre carburant ou élargissez la carte.</li>`;
      return;
    }

    const couleur = echellePrix(etat.stations, etat.carburant);
    const fragments = etat.stations.map((s) => {
      const p = s.prix[etat.carburant];
      const adresse = [s.adresse, [s.cp, s.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      return `
      <li class="station${s.id === etat.selection ? ' is-actif' : ''}" data-id="${s.id}" tabindex="0">
        <h3 class="station__nom">${echappe(nomStation(s))}${
          s.marque && s.marque !== s.nom ? `<span class="station__marque">${echappe(s.marque)}</span>` : ''
        }</h3>
        <p class="station__adresse">${echappe(adresse)}</p>
        <div class="station__prix ${couleur(p.v)}">
          <b>${formatePrix(p.v)}</b>
          <span>${echappe(CARBURANTS.find((c) => c.code === etat.carburant)?.label || '')}</span>
        </div>
        <div class="station__meta">
          ${s.dist != null ? `<span class="station__dist">${formateDistance(s.dist)}</span>` : ''}
          <span>${formateAnciennete(p.maj)}</span>
          ${s.auto24 ? '<span>24h/24</span>' : ''}
        </div>
        <div class="station__actions">${actionsHtml(s)}</div>
      </li>`;
    });

    el.liste.innerHTML = fragments.join('');
  }

  function rendMarqueurs() {
    coucheMarqueurs.clearLayers();
    marqueurs.clear();

    const couleur = echellePrix(etat.stations, etat.carburant);

    for (const s of etat.stations) {
      const p = s.prix[etat.carburant];
      if (!p) continue;

      const marqueur = L.marker([s.lat, s.lon], {
        icon: L.divIcon({
          className: '',
          html: `<div class="marqueur ${couleur(p.v)}${s.id === etat.selection ? ' is-actif' : ''}">${p.v.toFixed(2).replace('.', ',')}</div>`,
          iconSize: [46, 26],
          iconAnchor: [23, 13]
        }),
        title: nomStation(s)
      });

      marqueur.bindPopup(() => popupHtml(s), { closeButton: true, autoPanPadding: [30, 30] });
      marqueur.on('click', () => selectionne(s.id, { centre: false, defile: true }));
      marqueur.addTo(coucheMarqueurs);
      marqueurs.set(s.id, marqueur);
    }

    dessinePosition();
  }

  function popupHtml(s) {
    const prixListe = CARBURANTS
      .filter((c) => s.prix[c.code])
      .map((c) => `<li>${echappe(c.label)} <b>${formateNombre(s.prix[c.code].v)}</b> €/L</li>`)
      .join('');
    const adresse = [s.adresse, [s.cp, s.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ');

    return `
      <p class="popup__nom">${echappe(nomStation(s))}</p>
      <p class="popup__adresse">${echappe(adresse)}${s.dist != null ? ` • ${formateDistance(s.dist)}` : ''}</p>
      <ul class="popup__prix">${prixListe}</ul>
      <div class="popup__actions">${actionsHtml(s)}</div>`;
  }

  /** Met en avant une station : carte centree, popup ouverte, carte-liste active. */
  function selectionne(id, { centre = true, defile = false } = {}) {
    etat.selection = id;
    const station = etat.stations.find((s) => s.id === id);
    if (!station) return;

    if (centre) vaVers(station.lat, station.lon, Math.max(carte.getZoom(), 14));
    marqueurs.get(id)?.openPopup();

    // Mise a jour visuelle sans re-rendre toute la liste.
    el.liste.querySelectorAll('.station').forEach((li) => {
      li.classList.toggle('is-actif', li.dataset.id === id);
    });
    document.querySelectorAll('.marqueur').forEach((m) => m.classList.remove('is-actif'));
    marqueurs.get(id)?.getElement()?.querySelector('.marqueur')?.classList.add('is-actif');

    if (defile) {
      el.liste.querySelector(`.station[data-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // -----------------------------------------------------------------------
  // Definition du point de reference
  // -----------------------------------------------------------------------

  function definitPosition(lat, lon, label, { zoom = 12 } = {}) {
    etat.position = { lat, lon, label: label || null };
    sauvePrefs();
    if (label) el.recherche.value = label;
    el.effacer.hidden = !el.recherche.value;
    vaVers(lat, lon, zoom);
    dessinePosition();
    charge({ mode: 'rayon' });
  }

  function geolocalise() {
    if (!navigator.geolocation) {
      toast("La géolocalisation n'est pas disponible sur cet appareil.");
      return;
    }
    el.geoloc.classList.add('is-charge');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        el.geoloc.classList.remove('is-charge');
        definitPosition(pos.coords.latitude, pos.coords.longitude, 'Ma position');
      },
      (err) => {
        el.geoloc.classList.remove('is-charge');
        toast(err.code === err.PERMISSION_DENIED
          ? 'Position refusée. Saisissez une adresse à la place.'
          : 'Position indisponible. Saisissez une adresse.');
        el.recherche.focus();
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000 }
    );
  }

  // -----------------------------------------------------------------------
  // Autocompletion d'adresse (api-adresse.data.gouv.fr — Base Adresse Nationale)
  // -----------------------------------------------------------------------

  let requeteAdresse = null;
  let suggestions = [];
  let indexSurvol = -1;

  const chercheAdresse = anti_rebond(async (texte) => {
    if (texte.trim().length < 3) { fermeSuggestions(); return; }

    requeteAdresse?.abort();
    requeteAdresse = new AbortController();

    try {
      const url = `${API_ADRESSE}?q=${encodeURIComponent(texte)}&limit=6&autocomplete=1`;
      const res = await fetch(url, { signal: requeteAdresse.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      suggestions = (data.features || []).map((f) => ({
        label: f.properties.label,
        contexte: f.properties.context,
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
        type: f.properties.type
      }));
      rendSuggestions();
    } catch (err) {
      if (err.name !== 'AbortError') fermeSuggestions();
    }
  }, 220);

  function rendSuggestions() {
    if (!suggestions.length) { fermeSuggestions(); return; }
    indexSurvol = -1;
    el.suggestions.innerHTML = suggestions.map((s, i) => `
      <li role="option" id="sugg-${i}" aria-selected="false" data-index="${i}">
        <strong>${echappe(s.label)}</strong>
        <small>${echappe(s.contexte || '')}</small>
      </li>`).join('');
    el.suggestions.hidden = false;
    el.recherche.setAttribute('aria-expanded', 'true');
  }

  function fermeSuggestions() {
    el.suggestions.hidden = true;
    el.suggestions.innerHTML = '';
    el.recherche.setAttribute('aria-expanded', 'false');
    indexSurvol = -1;
  }

  function choisitSuggestion(i) {
    const s = suggestions[i];
    if (!s) return;
    fermeSuggestions();
    el.recherche.blur();
    // Une commune est plus large qu'une adresse : on dezoome legerement.
    definitPosition(s.lat, s.lon, s.label, { zoom: s.type === 'municipality' ? 12 : 14 });
  }

  function survole(delta) {
    if (el.suggestions.hidden || !suggestions.length) return;
    indexSurvol = (indexSurvol + delta + suggestions.length) % suggestions.length;
    el.suggestions.querySelectorAll('li').forEach((li, i) => {
      li.setAttribute('aria-selected', String(i === indexSurvol));
    });
    el.suggestions.children[indexSurvol]?.scrollIntoView({ block: 'nearest' });
  }

  // -----------------------------------------------------------------------
  // Interface : filtres, tri, bascule de vue
  // -----------------------------------------------------------------------

  function rendFiltres() {
    el.filtres.innerHTML = CARBURANTS.map((c) => `
      <button class="puce${c.code === etat.carburant ? ' is-actif' : ''}"
              type="button" role="radio"
              aria-checked="${c.code === etat.carburant}"
              title="${echappe(c.fullLabel)}"
              data-carburant="${c.code}">${echappe(c.label)}</button>`).join('');

    el.filtres.querySelector('.puce.is-actif')
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  function changeVue(vue) {
    etat.vue = vue;
    el.contenu.dataset.vue = vue;
    el.bascules.forEach((b) => {
      const actif = b.dataset.vue === vue;
      b.classList.toggle('is-actif', actif);
      b.setAttribute('aria-pressed', String(actif));
    });
    // Leaflet doit recalculer ses dimensions quand la carte redevient visible.
    if (vue === 'carte') setTimeout(() => carte.invalidateSize(), 60);
  }

  function brancheEvenements() {
    // --- Recherche d'adresse ---
    el.recherche.addEventListener('input', () => {
      el.effacer.hidden = !el.recherche.value;
      chercheAdresse(el.recherche.value);
    });

    el.recherche.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); survole(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); survole(-1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        choisitSuggestion(indexSurvol >= 0 ? indexSurvol : 0);
      } else if (e.key === 'Escape') { fermeSuggestions(); }
    });

    el.suggestions.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li[data-index]');
      if (li) { e.preventDefault(); choisitSuggestion(Number(li.dataset.index)); }
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.recherche')) fermeSuggestions();
    });

    el.effacer.addEventListener('click', () => {
      el.recherche.value = '';
      el.effacer.hidden = true;
      fermeSuggestions();
      el.recherche.focus();
    });

    // --- Geolocalisation ---
    el.geoloc.addEventListener('click', geolocalise);

    // --- Filtre carburant ---
    el.filtres.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-carburant]');
      if (!btn || btn.dataset.carburant === etat.carburant) return;
      etat.carburant = btn.dataset.carburant;
      etat.selection = null;
      sauvePrefs();
      rendFiltres();
      charge({ mode: etat.mode });
    });

    // --- Tri ---
    el.tris.forEach((btn) => btn.addEventListener('click', () => {
      if (btn.dataset.tri === etat.tri) return;
      etat.tri = btn.dataset.tri;
      sauvePrefs();
      el.tris.forEach((b) => {
        const actif = b === btn;
        b.classList.toggle('is-actif', actif);
        b.setAttribute('aria-checked', String(actif));
      });
      // Le tri se fait cote serveur : on relance la requete courante.
      charge({ mode: etat.mode });
    }));

    // --- Liste : clic / clavier sur une carte station ---
    el.liste.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;   // laisse passer Google Maps / Waze
      const li = e.target.closest('.station');
      if (!li) return;
      selectionne(li.dataset.id);
      if (window.matchMedia('(max-width: 899px)').matches) changeVue('carte');
    });

    el.liste.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const li = e.target.closest('.station');
      if (!li) return;
      e.preventDefault();
      selectionne(li.dataset.id);
      if (window.matchMedia('(max-width: 899px)').matches) changeVue('carte');
    });

    // --- Bascule carte / liste (mobile) ---
    el.bascules.forEach((b) => b.addEventListener('click', () => changeVue(b.dataset.vue)));
  }

  /**
   * Rafraichissement automatique des prix d'un onglet laisse ouvert.
   *
   * Le serveur recharge deja le flux officiel toutes les 20 min ; ici on se
   * contente de redemander les stations toutes les 10 min pour que l'affichage
   * suive, sans jamais interrompre l'utilisateur :
   *   - rien si l'onglet est en arriere-plan (economie de batterie et de requetes) ;
   *   - rien si une popup est ouverte ;
   *   - en cas d'echec, l'affichage courant est conserve.
   */
  function demarreRafraichissement() {
    const peutRafraichir = () =>
      etat.position && !document.hidden && !popupOuverte &&
      Date.now() - dernierChargement >= RAFRAICHISSEMENT_MS;

    setInterval(() => {
      if (peutRafraichir()) charge({ mode: etat.mode, silencieux: true });
    }, 60_000);

    // Retour sur l'onglet apres une longue absence : on remet a jour tout de suite.
    document.addEventListener('visibilitychange', () => {
      if (peutRafraichir()) charge({ mode: etat.mode, silencieux: true });
    });
  }

  // -----------------------------------------------------------------------
  // Demarrage
  // -----------------------------------------------------------------------

  async function chargeMeta() {
    try {
      const res = await fetch('/api/meta');
      if (!res.ok) return;
      const meta = await res.json();
      if (Array.isArray(meta.carburants) && meta.carburants.length) CARBURANTS = meta.carburants;
    } catch { /* les libelles par defaut suffisent */ }
  }

  async function demarre() {
    await chargeMeta();
    chargePrefs();

    initCarte();
    rendFiltres();
    brancheEvenements();
    demarreRafraichissement();

    el.tris.forEach((b) => {
      const actif = b.dataset.tri === etat.tri;
      b.classList.toggle('is-actif', actif);
      b.setAttribute('aria-checked', String(actif));
    });

    if (etat.position) {
      // Reprise de la derniere position connue : affichage immediat.
      definitPosition(etat.position.lat, etat.position.lon, etat.position.label);
    } else {
      el.resume.textContent = 'Autorisez la géolocalisation ou saisissez une adresse.';
      // Demande de position au chargement, comme attendu d'une app « autour de moi ».
      geolocalise();
    }
  }

  demarre();
})();
