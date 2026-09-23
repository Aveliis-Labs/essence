'use strict';

const NodeCache = require('node-cache');

const config = require('./config');
const { FUELS } = require('./fuels');
const { buildBrandIndex } = require('./brands');
const { haversineKm, kmPerLonDegree, KM_PER_LAT_DEGREE } = require('./geo');

/**
 * Store en memoire des stations-service.
 *
 * Strategie de performance :
 *  1. Un seul telechargement de l'export complet toutes les 20 minutes
 *     (node-cache gere le TTL) -> aucune requete amont pendant la navigation.
 *  2. Un index spatial en grille (cellules de 0,1 deg ~ 11 km) permet de
 *     repondre a une requete "autour de moi" ou "dans la fenetre carte" en
 *     n'examinant qu'une poignee de stations au lieu des ~9 800.
 *  3. "Stale-while-revalidate" : si la source amont tombe, on continue a
 *     servir le dernier instantane valide plutot que d'afficher une erreur.
 */

const CELL_SIZE_DEG = 0.1; // ~11 km : bon compromis taille d'index / selectivite

const cache = new NodeCache({ useClones: false });
const PRICES_KEY = 'prices';
const BRANDS_KEY = 'brands';

/** Dernier instantane valide, conserve meme apres expiration du TTL. */
let snapshot = null;
/** Promesse de rafraichissement en cours (evite les telechargements paralleles). */
let inflight = null;

// ---------------------------------------------------------------------------
// Telechargement des sources
// ---------------------------------------------------------------------------

async function fetchJson(url, { asText = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.cache.fetchTimeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept-Encoding': 'gzip, deflate',
        'User-Agent': 'essence/1.0 (carte des prix des carburants)'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
    return asText ? res.text() : res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Referentiel d'enseignes : optionnel, un echec ne doit jamais bloquer l'app. */
async function loadBrands() {
  const cached = cache.get(BRANDS_KEY);
  if (cached) return cached;
  try {
    const csv = await fetchJson(config.sources.brands, { asText: true });
    const index = buildBrandIndex(csv);
    cache.set(BRANDS_KEY, index, config.cache.brandsTtl);
    return index;
  } catch (err) {
    console.warn('[store] referentiel enseignes indisponible :', err.message);
    return snapshot?.brands || new Map();
  }
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function toStation(raw, brands) {
  const lat = raw.geom?.lat;
  const lon = raw.geom?.lon;
  // Quelques enregistrements du flux amont ont des coordonnees absentes ou
  // aberrantes : on les ecarte plutot que de polluer la carte.
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -25 || lat > 52 || lon < -65 || lon > 56) return null;

  const prix = {};
  let hasPrice = false;
  for (const fuel of FUELS) {
    const value = raw[`${fuel.field}_prix`];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    prix[fuel.code] = { v: Math.round(value * 1000) / 1000, maj: raw[`${fuel.field}_maj`] || null };
    hasPrice = true;
  }
  if (!hasPrice) return null; // station sans aucun prix : sans interet ici

  const ref = brands.get(Number(raw.id));

  return {
    id: String(raw.id),
    nom: ref?.nom || null,
    marque: ref?.marque || null,
    adresse: (raw.adresse || '').trim(),
    ville: (raw.ville || '').trim(),
    cp: (raw.cp || '').trim(),
    lat: Math.round(lat * 1e5) / 1e5,
    lon: Math.round(lon * 1e5) / 1e5,
    auto24: raw.horaires_automate_24_24 === 'Oui',
    prix
  };
}

/** Index spatial : Map("<cellLat>:<cellLon>" -> [station, ...]). */
function buildSpatialIndex(stations) {
  const grid = new Map();
  for (const station of stations) {
    const key = `${Math.floor(station.lat / CELL_SIZE_DEG)}:${Math.floor(station.lon / CELL_SIZE_DEG)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(station);
    else grid.set(key, [station]);
  }
  return grid;
}

// ---------------------------------------------------------------------------
// Rafraichissement
// ---------------------------------------------------------------------------

async function refresh() {
  if (inflight) return inflight; // mutualise les appels concurrents

  inflight = (async () => {
    const startedAt = Date.now();
    const [raw, brands] = await Promise.all([
      fetchJson(config.sources.prices),
      loadBrands()
    ]);
    if (!Array.isArray(raw) || !raw.length) throw new Error('export amont vide');

    const stations = [];
    for (const item of raw) {
      const station = toStation(item, brands);
      if (station) stations.push(station);
    }

    snapshot = {
      stations,
      brands,
      grid: buildSpatialIndex(stations),
      updatedAt: new Date().toISOString()
    };
    cache.set(PRICES_KEY, snapshot, config.cache.pricesTtl);
    console.log(
      `[store] ${stations.length} stations chargees en ${Date.now() - startedAt} ms ` +
      `(${brands.size} enseignes connues)`
    );
    return snapshot;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * Retourne l'instantane courant. Recharge si le TTL a expire ; en cas d'echec
 * amont, renvoie le dernier instantane valide s'il existe.
 */
async function getSnapshot() {
  const fresh = cache.get(PRICES_KEY);
  if (fresh) return fresh;
  try {
    return await refresh();
  } catch (err) {
    if (snapshot) {
      console.warn('[store] rafraichissement impossible, donnees precedentes servies :', err.message);
      return snapshot;
    }
    throw err;
  }
}

/** Precharge au demarrage puis entretient le cache en tache de fond. */
function startBackgroundRefresh() {
  const tick = () => {
    refresh().catch((err) => console.error('[store] echec du rafraichissement :', err.message));
  };
  tick();
  // On rafraichit un peu avant l'expiration pour qu'aucune requete utilisateur
  // n'ait jamais a attendre le telechargement amont.
  const interval = Math.max(60, config.cache.pricesTtl - 30) * 1000;
  const timer = setInterval(tick, interval);
  timer.unref?.();
  return timer;
}

// ---------------------------------------------------------------------------
// Requetes geographiques
// ---------------------------------------------------------------------------

/** Parcourt les cellules de la grille couvrant une emprise donnee. */
function* candidatesIn(grid, minLat, maxLat, minLon, maxLon) {
  const latStart = Math.floor(minLat / CELL_SIZE_DEG);
  const latEnd = Math.floor(maxLat / CELL_SIZE_DEG);
  const lonStart = Math.floor(minLon / CELL_SIZE_DEG);
  const lonEnd = Math.floor(maxLon / CELL_SIZE_DEG);

  for (let y = latStart; y <= latEnd; y += 1) {
    for (let x = lonStart; x <= lonEnd; x += 1) {
      const bucket = grid.get(`${y}:${x}`);
      if (bucket) yield* bucket;
    }
  }
}

/**
 * Stations dans un rayon (km) autour d'un point, triees par distance.
 * @returns {Array<station & {dist:number}>}
 */
function findByRadius(snap, lat, lon, radiusKm) {
  const latSpan = radiusKm / KM_PER_LAT_DEGREE;
  const lonSpan = radiusKm / Math.max(1, kmPerLonDegree(lat));

  const results = [];
  for (const station of candidatesIn(
    snap.grid, lat - latSpan, lat + latSpan, lon - lonSpan, lon + lonSpan
  )) {
    const dist = haversineKm(lat, lon, station.lat, station.lon);
    if (dist <= radiusKm) results.push({ ...station, dist: Math.round(dist * 100) / 100 });
  }
  results.sort((a, b) => a.dist - b.dist);
  return results;
}

/**
 * Stations contenues dans une emprise rectangulaire (fenetre de la carte).
 * Si un point de reference est fourni, la distance est calculee et le tri se
 * fait par proximite.
 */
function findByBbox(snap, bbox, reference) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const results = [];
  for (const station of candidatesIn(snap.grid, minLat, maxLat, minLon, maxLon)) {
    if (station.lat < minLat || station.lat > maxLat) continue;
    if (station.lon < minLon || station.lon > maxLon) continue;
    if (reference) {
      const dist = haversineKm(reference.lat, reference.lon, station.lat, station.lon);
      results.push({ ...station, dist: Math.round(dist * 100) / 100 });
    } else {
      results.push({ ...station });
    }
  }
  if (reference) results.sort((a, b) => a.dist - b.dist);
  return results;
}

module.exports = {
  getSnapshot,
  refresh,
  startBackgroundRefresh,
  findByRadius,
  findByBbox
};
