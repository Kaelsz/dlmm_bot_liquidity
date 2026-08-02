# syntax=docker/dockerfile:1

# Meteora Pool Radar — image de production.
#
# Trois étages : dépendances (compilation du module natif), build Next, puis
# une image d'exécution qui ne contient ni compilateur ni sources.
#
# Le point sensible est better-sqlite3 : c'est un addon natif compilé pour la
# plateforme, et son chargeur résout le .node à l'exécution d'une façon que le
# bundler ne peut pas suivre (cf. next.config.ts). L'étage runner recopie donc
# node_modules tel quel plutôt que de s'en remettre au tracing de Next.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# node-gyp a besoin d'un compilateur C++ et de Python pour better-sqlite3.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
# node-linker=hoisted : le store symlinké de pnpm ne survit pas à la copie
# entre étages, et le résolveur du module natif suit les liens.
RUN pnpm config set node-linker hoisted \
    && pnpm install --frozen-lockfile

FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Le collecteur ne doit jamais démarrer pendant le build : instrumentation.ts
# se déclenche au runtime Node, pas ici, mais la garde est explicite.
ENV NEXT_TELEMETRY_DISABLED=1 COLLECTOR=off
RUN pnpm build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DB_PATH=/data/radar.db

# Utilisateur non privilégié, propriétaire du volume de données.
RUN groupadd -g 1001 radar && useradd -u 1001 -g radar -m radar \
    && mkdir -p /data && chown radar:radar /data

COPY --from=builder --chown=radar:radar /app/.next/standalone ./
# Le serveur standalone ne sert pas les assets statiques tout seul.
COPY --from=builder --chown=radar:radar /app/.next/static ./.next/static
# Filet de sécurité : le tracing de Next inclut normalement le binaire .node de
# better-sqlite3 (vérifié sur ce projet), mais il le résout via `bindings` à
# l'exécution, hors de portée du bundler. Recopier les trois modules coûte
# quelques Mo et évite un « Could not locate the bindings file » en production.
COPY --from=builder --chown=radar:radar /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=builder --chown=radar:radar /app/node_modules/bindings ./node_modules/bindings
COPY --from=builder --chown=radar:radar /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path

USER radar
EXPOSE 3000
VOLUME ["/data"]

# /api/health répond dès que le process sert ; il expose aussi l'état du
# collecteur et les débits par protocole.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
