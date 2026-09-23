# Prix des carburants en France

Carte des prix des carburants relevés dans les stations-service françaises, à
partir des données publiques officielles. Interface en français, mobile-first,
sans compte ni base de données.

## Démarrage

### Derrière un reverse proxy (Dokploy / Traefik, Caddy, Nginx…)

```bash
cp .env.example .env
docker compose up -d
```

Aucun port n'est publié sur la machine hôte : le proxy joint le conteneur par le
réseau Docker, sur le **port 3000**. C'est ce qu'il faut indiquer au proxy
(dans Dokploy : *Domains* → service `web`, port `3000`).

### En local, sans proxy

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

→ http://localhost:3000 (port réglable avec `APP_PORT` dans `.env`)

Sans Docker : `npm install && npm start`

## Fonctionnalités

- Carte OpenStreetMap (Leaflet) avec le prix affiché directement sur chaque
  marqueur, coloré du vert (moins cher de la zone) au rouge
- Carte + liste côte à côte sur ordinateur, bascule Carte/Liste sur mobile
- Géolocalisation ou recherche d'adresse avec autocomplétion
- Filtres E10, SP98, SP95, Gazole, E85, GPL
- Tri par distance ou par prix
- Boutons Google Maps et Waze sur chaque station
- Dernière position, carburant et tri mémorisés dans le navigateur

## Mise à jour des prix

Elle est entièrement automatique, à trois niveaux :

| Quoi | Fréquence | Où |
|---|---|---|
| Le serveur retélécharge le flux officiel | 20 min | `PRICES_TTL_SECONDS` dans `.env` |
| Un onglet laissé ouvert se remet à jour | 10 min | `RAFRAICHISSEMENT_MS` dans `public/js/app.js` |
| Le référentiel des enseignes | 24 h | `BRANDS_TTL_SECONDS` |

Le serveur garde tout en mémoire et recharge en tâche de fond 30 s avant
l'expiration du cache : aucune requête utilisateur n'attend jamais un
téléchargement. Si la source publique est indisponible, les dernières données
valides continuent d'être servies.

Le rafraîchissement de l'onglet est mis en pause quand la page est en
arrière-plan ou qu'une popup est ouverte, et reprend au retour sur l'onglet.

Il n'y a donc **rien à planifier** : pas de cron, pas de tâche externe. Pour
changer la cadence, modifiez `PRICES_TTL_SECONDS` dans `.env`.

## Sources

| Donnée | Source |
|---|---|
| Prix | [Flux instantané officiel](https://data.economie.gouv.fr/explore/dataset/prix-des-carburants-en-france-flux-instantane-v2/) — data.economie.gouv.fr |
| Noms et enseignes | [Référentiel enrichi par OpenStreetMap](https://www.data.gouv.fr/datasets/6a0f63071a36d728807f9026/) — data.gouv.fr |
| Adresses | [api-adresse.data.gouv.fr](https://adresse.data.gouv.fr/api-doc/adresse) |
| Fond de carte | [OpenStreetMap](https://www.openstreetmap.org/copyright) |

Le flux des prix ne contient pas le nom du point de vente : il est complété par
le référentiel d'enseignes, joint sur l'identifiant officiel de la station.

## Structure

```
src/
  server.js   Express : statiques, compression, arrêt propre
  routes.js   API /api/*
  store.js    Cache mémoire, index spatial, requêtes géographiques
  brands.js   Référentiel des enseignes (parseur CSV intégré)
  fuels.js    Les 6 carburants
  geo.js      Distances
  config.js   Configuration
public/
  index.html
  css/styles.css
  js/app.js   Application cliente (JS natif)
.env.example             Réglages à copier en .env
docker-compose.yml       Déploiement derrière un reverse proxy
docker-compose.local.yml Appoint : publie le port pour un test local
```

Le navigateur ne reçoit jamais toute la France : soit un rayon de 15 km, soit
l'emprise visible de la carte. Environ 17 Ko gzip pour 300 stations.

## API

```
# Autour d'un point
/api/stations?lat=48.8566&lon=2.3522&rayon=15&carburant=gazole&tri=prix

# Emprise de la carte
/api/stations?bbox=2.30,48.83,2.40,48.89&lat=48.8566&lon=2.3522&carburant=e10
```

| Paramètre | Valeurs | Défaut |
|---|---|---|
| `lat`, `lon` | point de référence | — |
| `rayon` | 0,5 → 50 km | 15 |
| `bbox` | `minLon,minLat,maxLon,maxLat` | — |
| `carburant` | `e10` `sp98` `sp95` `gazole` `e85` `gplc` | tous |
| `tri` | `distance` `prix` | `distance` |
| `limite` | 1 → 300 | 300 |

Aussi : `/api/meta` (libellés) et `/api/health` (supervision, utilisé par le
healthcheck Docker).

## Configuration

Tout se règle dans le fichier `.env`, à copier depuis `.env.example` :

```bash
cp .env.example .env
```

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | 3000 | Port d'écoute de l'application — celui à donner au reverse proxy |
| `APP_PORT` | 3000 | Port publié sur l'hôte, **uniquement** avec `docker-compose.local.yml` |
| `PRICES_TTL_SECONDS` | 1200 | Cache des prix |
| `BRANDS_TTL_SECONDS` | 86400 | Cache du référentiel d'enseignes |
| `QUERY_TTL_SECONDS` | 60 | Cache des réponses `/api/stations` |
| `FETCH_TIMEOUT_MS` | 60000 | Délai max d'appel à une source |
| `DEFAULT_RADIUS_KM` | 15 | Rayon par défaut |
| `MAX_RADIUS_KM` | 50 | Rayon maximal |
| `MAX_RESULTS` | 300 | Stations renvoyées au maximum |

`.env` n'est pas versionné. Il est lu par Docker Compose et, en lancement
direct (`npm start`), par le serveur. Une variable déjà définie dans
l'environnement l'emporte toujours sur le fichier.

## À savoir

**La géolocalisation du navigateur exige HTTPS.** En `localhost` elle
fonctionne, mais dès que l'application est exposée sur un nom de domaine il faut
du TLS, sinon les navigateurs refusent la position et « Autour de moi » invite à
saisir une adresse. Le certificat géré par Traefik suffit ; le serveur est déjà
configuré avec `trust proxy`.

Les prix sont déclarés par les gérants : leur fraîcheur varie d'une station à
l'autre. L'ancienneté de chaque relevé est affichée sur la fiche.

Le conteneur tourne en utilisateur non privilégié, système de fichiers en
lecture seule, ~50 Mo de RAM.

## Données

Les données restent soumises à leurs licences d'origine : Licence Ouverte pour
les jeux de données publics, ODbL pour OpenStreetMap.
