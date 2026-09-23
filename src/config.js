'use strict';

/**
 * Configuration centrale de l'application.
 * Toutes les valeurs sont surchargeables par variable d'environnement
 * (voir docker-compose.yml).
 */

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

module.exports = {
  // --- Serveur ---
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',

  // --- Sources de donnees publiques ---
  sources: {
    // Flux instantane officiel des prix (data.economie.gouv.fr / Opendatasoft).
    // On telecharge l'export complet (~9 800 stations, ~1 Mo) en une seule
    // requete : c'est plus rapide et plus economique que de requeter l'API
    // amont a chaque visite.
    prices:
      'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/' +
      'prix-des-carburants-en-france-flux-instantane-v2/exports/json' +
      '?select=' +
      [
        'id', 'geom', 'cp', 'ville', 'adresse',
        'gazole_prix', 'gazole_maj',
        'sp95_prix', 'sp95_maj',
        'sp98_prix', 'sp98_maj',
        'e10_prix', 'e10_maj',
        'e85_prix', 'e85_maj',
        'gplc_prix', 'gplc_maj',
        'horaires_automate_24_24'
      ].join(','),

    // Referentiel des noms/enseignes de stations (data.gouv.fr, enrichi OSM).
    // Le flux officiel des prix ne contient pas l'enseigne : on la recupere ici.
    // URL stable pointant toujours vers la derniere version de la ressource.
    brands: 'https://www.data.gouv.fr/api/1/datasets/r/0207ded0-2d19-47af-b1a6-62915ec1b721'
  },

  // --- Cache serveur ---
  cache: {
    // Duree de vie du jeu de donnees des prix, en secondes (defaut : 20 min).
    // Le flux amont n'est de toute facon rafraichi que quelques fois par jour.
    pricesTtl: num(process.env.PRICES_TTL_SECONDS, 20 * 60),
    // Le referentiel d'enseignes bouge tres peu : 24 h.
    brandsTtl: num(process.env.BRANDS_TTL_SECONDS, 24 * 60 * 60),
    // Cache court des reponses HTTP /api/stations (secondes).
    queryTtl: num(process.env.QUERY_TTL_SECONDS, 60),
    // Delai max d'une requete vers une source amont (ms).
    fetchTimeout: num(process.env.FETCH_TIMEOUT_MS, 60_000)
  },

  // --- Garde-fous des requetes geographiques ---
  limits: {
    defaultRadiusKm: num(process.env.DEFAULT_RADIUS_KM, 15),
    maxRadiusKm: num(process.env.MAX_RADIUS_KM, 50),
    maxResults: num(process.env.MAX_RESULTS, 300)
  }
};
