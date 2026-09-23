'use strict';

const path = require('path');
const express = require('express');
const compression = require('compression');

const config = require('./config');
const routes = require('./routes');
const store = require('./store');

const app = express();

// Derriere un reverse proxy (Traefik, Nginx...), fait confiance a X-Forwarded-*.
app.set('trust proxy', true);
app.disable('x-powered-by');

// Compression gzip/brotli : le JSON des stations se compresse tres bien.
app.use(compression());

// En-tetes de securite minimaux (pas de framework lourd type helmet).
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer-when-downgrade');
  next();
});

// --- API interne ---
app.use('/api', routes);

// --- Leaflet servi depuis le conteneur (pas de CDN tiers, chargement plus sur) ---
app.use(
  '/vendor/leaflet',
  express.static(path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist'), {
    maxAge: '30d',
    immutable: true
  })
);

// --- Front statique ---
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    maxAge: '1h',
    setHeaders(res, filePath) {
      // Le HTML doit toujours etre revalide pour propager les mises a jour.
      if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
    }
  })
);

// --- 404 & erreurs ---
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ erreur: 'Ressource introuvable.' });
  }
  res.status(404).sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[http]', err);
  res.status(500).json({ erreur: 'Erreur interne du serveur.' });
});

// --- Demarrage ---
const server = app.listen(config.port, config.host, () => {
  console.log(`[http] Serveur a l ecoute sur http://${config.host}:${config.port}`);
  // Prechargement immediat + entretien periodique du cache des prix.
  store.startBackgroundRefresh();
});

// Arret propre (docker stop / Ctrl+C).
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[http] ${signal} recu, arret en cours...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
