# =============================================================================
# Image de production — Node 20 Alpine, build multi-etapes pour ne garder
# que les dependances runtime (image finale ~120 Mo).
# =============================================================================

# --- Etape 1 : installation des dependances -----------------------------------
FROM node:20-alpine AS deps

WORKDIR /app

# On copie d'abord les manifestes : cette couche n'est reconstruite que si
# les dependances changent, pas a chaque modification de code.
COPY package.json package-lock.json* ./

# `npm ci` si un lockfile est present (build reproductible), sinon `npm install`.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && npm cache clean --force


# --- Etape 2 : image finale ---------------------------------------------------
FROM node:20-alpine AS runtime

# tini : reaper de processus PID 1, pour un arret propre sur SIGTERM.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# Execution sans privileges (l'utilisateur `node` existe dans l'image officielle).
USER node

EXPOSE 3000

# Verifie que le cache des prix est bien alimente, pas seulement que le port ecoute.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
