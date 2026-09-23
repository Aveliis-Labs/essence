'use strict';

const express = require('express');
const NodeCache = require('node-cache');

const config = require('./config');
const { FUELS, isFuelCode } = require('./fuels');
const store = require('./store');

const router = express.Router();

/**
 * Cache court des reponses HTTP : deux visiteurs au meme endroit pendant la
 * meme minute partagent le meme JSON deja serialise.
 */
const queryCache = new NodeCache({ stdTTL: config.cache.queryTtl, useClones: false });

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Lit un nombre depuis la query string, avec valeur par defaut. */
function readNumber(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Garde uniquement les stations proposant le carburant demande. */
function filterByFuel(stations, fuel) {
  if (!fuel) return stations;
  return stations.filter((s) => s.prix[fuel]);
}

/** Tri : 'distance' (defaut) ou 'prix' (necessite un carburant selectionne). */
function sortStations(stations, sort, fuel) {
  if (sort === 'prix' && fuel) {
    return stations.sort((a, b) => {
      const diff = a.prix[fuel].v - b.prix[fuel].v;
      return diff !== 0 ? diff : (a.dist ?? 0) - (b.dist ?? 0);
    });
  }
  return stations.sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0));
}

/** Metadonnees statiques utiles au front (libelles des carburants, limites). */
router.get('/meta', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    carburants: FUELS.map(({ code, label, fullLabel }) => ({ code, label, fullLabel })),
    rayonParDefautKm: config.limits.defaultRadiusKm,
    rayonMaxKm: config.limits.maxRadiusKm
  });
});

/** Sonde de sante / supervision (utilisee aussi par le healthcheck Docker). */
router.get('/health', async (req, res) => {
  try {
    const snap = await store.getSnapshot();
    res.json({
      statut: 'ok',
      stations: snap.stations.length,
      misAJourLe: snap.updatedAt,
      ageSecondes: Math.round((Date.now() - new Date(snap.updatedAt).getTime()) / 1000)
    });
  } catch (err) {
    res.status(503).json({ statut: 'indisponible', message: err.message });
  }
});

/**
 * GET /api/stations
 *
 * Deux modes, exclusifs :
 *   - rayon  : ?lat=48.85&lon=2.35&rayon=15
 *   - emprise: ?bbox=minLon,minLat,maxLon,maxLat  (fenetre visible de la carte)
 *              (+ lat/lon facultatifs pour calculer les distances)
 *
 * Parametres communs : carburant, tri (distance|prix), limite.
 * Dans les deux cas la reponse est bornee geographiquement : le navigateur ne
 * recoit jamais les ~9 800 stations de France.
 */
router.get('/stations', async (req, res, next) => {
  try {
    const fuel = isFuelCode(req.query.carburant) ? req.query.carburant : null;
    const sort = req.query.tri === 'prix' ? 'prix' : 'distance';
    const limit = clamp(
      Math.round(readNumber(req.query.limite, config.limits.maxResults)),
      1,
      config.limits.maxResults
    );

    const lat = readNumber(req.query.lat, null);
    const lon = readNumber(req.query.lon, null);
    const hasPoint = lat !== null && lon !== null;

    let bbox = null;
    if (typeof req.query.bbox === 'string') {
      const parts = req.query.bbox.split(',').map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite)) {
        bbox = [
          Math.min(parts[0], parts[2]), Math.min(parts[1], parts[3]),
          Math.max(parts[0], parts[2]), Math.max(parts[1], parts[3])
        ];
      }
    }

    if (!bbox && !hasPoint) {
      return res.status(400).json({
        erreur: 'Parametres manquants : fournissez lat & lon, ou bbox.'
      });
    }

    const radiusKm = clamp(
      readNumber(req.query.rayon, config.limits.defaultRadiusKm),
      0.5,
      config.limits.maxRadiusKm
    );

    // Cle de cache arrondie : les micro-variations de position n'engendrent pas
    // un recalcul complet.
    const cacheKey = [
      bbox ? bbox.map((v) => v.toFixed(3)).join(',') : 'r',
      hasPoint ? `${lat.toFixed(3)},${lon.toFixed(3)}` : '-',
      radiusKm, fuel || '-', sort, limit
    ].join('|');

    const cached = queryCache.get(cacheKey);
    if (cached) {
      res.set('Cache-Control', `public, max-age=${config.cache.queryTtl}`);
      return res.json(cached);
    }

    const snap = await store.getSnapshot();
    const found = bbox
      ? store.findByBbox(snap, bbox, hasPoint ? { lat, lon } : null)
      : store.findByRadius(snap, lat, lon, radiusKm);

    const filtered = filterByFuel(found, fuel);
    const sorted = sortStations(filtered, sort, fuel);

    const payload = {
      total: sorted.length,
      retournees: Math.min(sorted.length, limit),
      carburant: fuel,
      tri: sort,
      rayonKm: bbox ? null : radiusKm,
      misAJourLe: snap.updatedAt,
      stations: sorted.slice(0, limit)
    };

    queryCache.set(cacheKey, payload);
    res.set('Cache-Control', `public, max-age=${config.cache.queryTtl}`);
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
