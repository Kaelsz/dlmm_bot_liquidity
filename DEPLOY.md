# Déployer Meteora Pool Radar sur un VPS

Le projet est une seule application Next.js : un process Node qui sert l'UI **et** fait tourner
le collecteur, avec SQLite sur disque. Pas de base externe, pas de file d'attente, pas de cron.

**Aucune clé d'API n'est nécessaire** — les données Meteora et RugCheck sont publiques. Il n'y a
donc aucun secret à gérer, et aucune clé privée Solana n'est impliquée.

---

## 1. Dimensionner la machine

| Ressource | Recommandation | Pourquoi |
|---|---|---|
| CPU | 1 vCPU suffit, 2 confortable | Le collecteur est en attente réseau la plupart du temps |
| RAM | 1 Go minimum, **2 Go recommandé** | Le build Next est le pic ; le runtime tient sous 400 Mo |
| Disque | 10 Go | Voir ci-dessous |
| Réseau sortant | HTTPS vers `*.datapi.meteora.ag` et `api.rugcheck.xyz` | ~5 req/s en pointe |
| Réseau entrant | 80/443 seulement | L'app écoute sur la boucle locale |

**Disque, mesuré en conditions réelles** : ~100 000 échantillons par heure pour ~1 500 pools
suivies, soit **~600 000 lignes et ~200 Mo** en régime permanent avec la rétention de 6 h
(`collector.sampleRetentionMs`). La taille se stabilise, elle ne croît pas indéfiniment. Compter
10 Go laisse la place à l'image Docker et aux sauvegardes.

Si la RAM est juste à 1 Go, faire le build ailleurs (voir §5) plutôt que d'ajouter du swap.

---

## 2. Option A — Docker (recommandée)

### Installation

```bash
# Docker, si absent
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # puis se reconnecter

git clone https://github.com/Kaelsz/dlmm_bot_liquidity.git radar
cd radar
docker compose up -d --build
```

Le premier build compile `better-sqlite3` depuis les sources : comptez 3 à 5 minutes.

### Vérifier

```bash
docker compose ps                    # doit afficher "healthy" après ~40 s
curl -s localhost:3000/api/health | head -c 300
```

La réponse doit montrer `"ok":true`, `"running":true`, et des débits sous les limites
(`dlmmReqPerSec` < 20, `dammV2ReqPerSec` < 6). Si `errors` grimpe, voir §7.

Les sparklines et les colonnes dérivées (`Fees/min`, `Vol/min`, `Accél.`) restent **vides
pendant les premières minutes** : elles se calculent entre deux échantillons successifs. Comptez
~15 min pour que le tableau soit pleinement lisible.

### Ce que fait `docker-compose.yml`

- publie sur `127.0.0.1:3000` seulement — le reverse proxy s'occupe du TLS ;
- monte un volume nommé `radar-data` sur `/data`, où vit la base. **Sans ce volume, chaque
  redémarrage repart de zéro** et l'historique dérivé est perdu ;
- `stop_grace_period: 30s` : SQLite en WAL n'aime pas être tué pendant un checkpoint.

---

## 3. Reverse proxy et TLS

### Caddy (le plus court — certificat automatique)

```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile` :

```
radar.mondomaine.fr {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

C'est tout : Caddy obtient et renouvelle le certificat Let's Encrypt seul.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name radar.mondomaine.fr;

    ssl_certificate     /etc/letsencrypt/live/radar.mondomaine.fr/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/radar.mondomaine.fr/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Indispensable pour le flux SSE de /api/stream : sans ça nginx
        # bufferise et le tableau ne se met plus à jour tout seul.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

Le point sur `proxy_buffering off` n'est pas cosmétique : le temps réel du dashboard passe
entièrement par `/api/stream`.

### Pare-feu

```bash
sudo ufw allow 22,80,443/tcp && sudo ufw enable
```

Le port 3000 ne doit **pas** être ouvert : l'app n'a aucune authentification. Si le dashboard doit
rester privé, ajouter un `basic_auth` Caddy ou une règle de restriction par IP.

---

## 4. Option B — sans Docker (systemd)

C'est le chemin que j'ai vérifié directement dans cet environnement.

```bash
# Node 22 + pnpm
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3   # build-essential : better-sqlite3
sudo corepack enable

sudo useradd -r -m -d /opt/radar radar
sudo -u radar git clone https://github.com/Kaelsz/dlmm_bot_liquidity.git /opt/radar/app
cd /opt/radar/app

sudo -u radar pnpm install --frozen-lockfile
sudo -u radar env COLLECTOR=off pnpm build

# Le serveur standalone n'embarque pas les assets statiques : sans cette copie,
# les pages se chargent sans style.
sudo -u radar cp -r .next/static .next/standalone/.next/static
sudo -u radar mkdir -p /opt/radar/data
```

> **Piège** : ne jamais lancer `pnpm build` pendant qu'un `pnpm dev` tourne dans le même dossier.
> Les deux écrivent dans `.next/` et le serveur de production échoue ensuite sur
> `TypeError: a[d] is not a function`. Ça m'est arrivé pendant la mise au point.

`/etc/systemd/system/radar.service` :

```ini
[Unit]
Description=Meteora Pool Radar
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=radar
WorkingDirectory=/opt/radar/app/.next/standalone
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOSTNAME=127.0.0.1
Environment=DB_PATH=/opt/radar/data/radar.db
Environment=COLLECTOR=on
Environment=LOG_LEVEL=info
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
# Laisse le temps au checkpoint WAL de se terminer.
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now radar
journalctl -u radar -f
```

---

## 5. Mettre à jour

**Docker** — la base survit, elle est dans le volume :

```bash
cd radar && git pull && docker compose up -d --build
```

**systemd** :

```bash
cd /opt/radar/app
sudo -u radar git pull
sudo -u radar pnpm install --frozen-lockfile
sudo -u radar env COLLECTOR=off pnpm build
sudo -u radar cp -r .next/static .next/standalone/.next/static
sudo systemctl restart radar
```

Les changements de schéma sont appliqués automatiquement au démarrage (`ALTER TABLE` idempotents
dans `src/db/schema.sql.ts`) — aucune migration manuelle, aucune perte de données.

**Si le VPS a 1 Go de RAM**, `next build` peut être serré. Construire l'image ailleurs et la
pousser :

```bash
docker build -t monregistre/radar:latest . && docker push monregistre/radar:latest
```

puis remplacer `build: .` par `image: monregistre/radar:latest` dans `docker-compose.yml`.

---

## 6. Sauvegarder

Ne **pas** copier `radar.db` à chaud : le WAL n'y est pas encore intégré et la copie serait
incohérente. Utiliser l'API de sauvegarde de SQLite :

```bash
# Docker
docker compose exec radar node -e "
const D=require('better-sqlite3');
new D('/data/radar.db').backup('/data/backup-'+Date.now()+'.db').then(()=>process.exit(0));
"

# systemd
sudo -u radar sqlite3 /opt/radar/data/radar.db ".backup /opt/radar/data/backup.db"
```

Cela dit, la base est entièrement reconstructible : elle ne contient que des données de marché
publiques. Une sauvegarde ne sert qu'à conserver l'historique dérivé, pas à protéger un état
irremplaçable.

---

## 7. Dépannage

| Symptôme | Cause probable |
|---|---|
| Le tableau ne se met plus à jour seul, `hors ligne` en haut à droite | Le proxy bufferise SSE — `proxy_buffering off` (§3) |
| Toutes les routes en 500, mais le collecteur tourne | `.next` corrompu par un `pnpm dev` concurrent — rebuild propre |
| `Could not locate the bindings file` | `better-sqlite3` pas recompilé : `pnpm rebuild better-sqlite3` |
| `errors` grimpe dans `/api/health` | Rate limit atteint. Augmenter `DISCOVERY_INTERVAL_MS` / `HOT_SET_INTERVAL_MS` |
| Colonnes dérivées vides | Normal avant ~2 échantillons par pool. Attendre 15 min |
| Base qui grossit sans fin | Ne devrait pas : la purge suit `sampleRetentionMs`. Vérifier les logs du collecteur |

Variables d'ajustement dans `.env` (voir `.env.example`) : `DISCOVERY_INTERVAL_MS`,
`NEW_POOLS_INTERVAL_MS`, `HOT_SET_INTERVAL_MS`, `COLLECTOR`, `LOG_LEVEL`, `DB_PATH`.

---

## 8. État de vérification

Pour être précis sur ce qui a été testé et ce qui ne l'a pas été :

- ✅ **Le serveur standalone de production** (`node server.js`) démarre, sert `/` et `/nouvelles`
  en 200, charge le module natif, fait tourner le collecteur — vérifié directement.
- ✅ Le build Next produit bien `.next/standalone` avec le `.node` de `better-sqlite3` tracé.
- ✅ Les migrations de schéma s'appliquent sur une base existante sans perte.
- ⚠️ **Le `Dockerfile` et le `docker-compose.yml` n'ont pas pu être construits** : l'environnement
  de développement a le client Docker mais pas de démon. Ils suivent la même séquence que
  l'option B, qui est vérifiée, mais le premier `docker compose up --build` sur le VPS est le
  premier essai réel. En cas d'échec, l'option systemd est un repli immédiat.
- ⚠️ L'application n'a **aucune authentification**. Ne pas l'exposer publiquement sans
  `basic_auth` ou restriction par IP.
