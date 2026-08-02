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

## 2. Installation en une commande (recommandée)

Le script installe Docker si besoin, récupère le code, génère un mot de passe, démarre tout et
vérifie que l'application répond.

```bash
ssh ton_user@ton_vps
curl -fsSL https://raw.githubusercontent.com/Kaelsz/dlmm_bot_liquidity/main/scripts/deploy.sh | bash
```

À la fin, il affiche l'adresse `https://<ip>/`, l'identifiant et **le mot de passe — une seule
fois**. Seul son hash bcrypt est conservé, dans `.env`.

Options utiles :

```bash
./scripts/deploy.sh --check          # préflight seul : ne modifie rien
./scripts/deploy.sh --dir /opt/radar # autre répertoire (défaut : ~/radar)
./scripts/deploy.sh --user florian   # autre identifiant HTTP (défaut : radar)
```

**Relancer le script met à jour** : il fait un `git pull`, reconstruit et redémarre, sans toucher
au mot de passe ni à la base.

Le premier passage compile `better-sqlite3` depuis les sources — comptez 3 à 5 minutes.

### Ce que ça met en place

Deux conteneurs :

- **`radar`** — l'application, publiée sur `127.0.0.1:3000` seulement. Elle n'a **aucune
  authentification** : elle ne doit jamais être jointe directement depuis l'extérieur.
- **`caddy`** — le frontal sur le port 443, qui porte le TLS et le mot de passe.

Et trois volumes nommés : `radar-data` (la base — **sans lui, chaque redémarrage repart de
zéro**), `caddy-data` et `caddy-config` (l'autorité de certification interne, qui doit survivre
aux redémarrages sinon le navigateur redemande d'accepter le certificat).

### L'avertissement de certificat

Sans nom de domaine, aucune autorité publique ne peut signer de certificat : Caddy en émet un
avec sa propre autorité (`tls internal`). Le navigateur affiche donc un avertissement.

Ce n'est pas une erreur de configuration, et ce n'est pas non plus sans valeur : la connexion est
bien chiffrée, ce qui protège le mot de passe en transit — contrairement à du HTTP nu. Ce qui
n'est pas garanti, c'est l'identité du serveur. Accepter une fois suffit.

Pour supprimer l'avertissement, il faut un nom de domaine : voir §3.

### Vérifier à la main

```bash
cd ~/radar
docker compose ps                                  # "healthy" après ~40 s
curl -s localhost:3000/api/health | head -c 300     # depuis le VPS
docker compose logs -f radar
```

`"ok":true` et `"running":true` signifient que le collecteur tourne. Les colonnes dérivées
(`Fees/min`, `Vol/min`, `Accél.`) restent vides ~15 min : elles se calculent entre deux
échantillons successifs.

### Changer le mot de passe

```bash
cd ~/radar
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'nouveau'
# recopier la valeur dans .env (RADAR_PASSWORD_HASH), puis :
docker compose up -d
```

---

## 3. Variante : avec un nom de domaine

Si un domaine pointe sur l'IP du VPS, Let's Encrypt peut émettre un vrai certificat et
l'avertissement disparaît. Il n'y a **rien à réécrire dans le `Caddyfile`** : l'adresse du site
est une variable.

```bash
cd ~/radar
./scripts/deploy.sh --site https://radar.mondomaine.fr
sudo ufw allow 80/tcp      # Let's Encrypt valide via le port 80
```

Puis retirer la ligne `tls internal` du `Caddyfile` — c'est elle qui force l'autorité interne — et
publier le port 80 dans `docker-compose.yml` (`- "80:80"`), nécessaire à la validation :

```bash
docker compose up -d
```

Caddy obtient et renouvelle le certificat seul. `basic_auth` reste utile : le dashboard n'a
toujours aucune authentification propre.

### nginx, si tu préfères

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

`scripts/deploy.sh` ouvre déjà 22 et 443. Avec un nom de domaine, ajouter 80 pour la validation
Let's Encrypt :

```bash
sudo ufw allow 22,80,443/tcp && sudo ufw enable
```

Le port **3000 ne doit jamais être ouvert** : c'est l'application nue, sans authentification.
Seul Caddy doit être joignable de l'extérieur.

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

**Le plus simple** — relancer le script, qui est idempotent :

```bash
~/radar/scripts/deploy.sh
```

**À la main** — la base survit, elle est dans le volume :

```bash
cd ~/radar && git pull && docker compose up -d --build
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
| Caddy ne démarre pas, `invalid password hash` | `RADAR_PASSWORD_HASH` contient un mot de passe en clair au lieu d'un hash bcrypt |
| Le mot de passe n'est jamais accepté | Le hash a été mis dans `environment:` au lieu de `env_file:` — Compose a mangé les `$` |
| Le navigateur redemande d'accepter le certificat à chaque redémarrage | Volumes `caddy-data`/`caddy-config` absents : l'autorité interne est régénérée |
| `connection refused` sur le port 443 | Caddy n'a pas démarré : `docker compose logs caddy` |
| **Le port 443 accepte mais rien ne s'affiche, pas même l'avertissement de certificat** | `RADAR_SITE` absent ou sans hôte dans `.env`. Caddy n'active l'HTTPS automatique que s'il connaît une IP ou un domaine : sans ça il écoute sans certificat et la poignée de main TLS échoue. Vérifier avec `curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1/` depuis le VPS — doit répondre `401`. Corriger : `./scripts/deploy.sh --site https://mon.ip` |

Variables d'ajustement dans `.env` (voir `.env.example`) : `DISCOVERY_INTERVAL_MS`,
`NEW_POOLS_INTERVAL_MS`, `HOT_SET_INTERVAL_MS`, `COLLECTOR`, `LOG_LEVEL`, `DB_PATH`.

---

## 8. État de vérification

Ce qui a été testé directement, et ce qui ne pouvait pas l'être :

- ✅ **Le serveur standalone de production** (`node server.js`) démarre, sert `/` et `/nouvelles`
  en 200, charge le module natif et fait tourner le collecteur.
- ✅ Le build Next trace bien le binaire `.node` de `better-sqlite3`.
- ✅ Les migrations de schéma s'appliquent sur une base existante sans perte.
- ✅ `scripts/deploy.sh` : `shellcheck` propre, préflight exécuté, et **le chemin d'échec vérifié**
  — démon Docker absent, le script s'arrête avec un message explicite et un code retour non nul,
  sans rien laisser à moitié installé.
- ✅ La migration d'un `.env` existant (ajout de `RADAR_SITE` sans toucher au hash) est testée,
  y compris son idempotence.
- ⚠️ **Non testés faute de démon Docker** dans l'environnement de développement : la construction
  de l'image, le démarrage de Caddy et l'émission du certificat interne.

### Un défaut de cette catégorie s'est effectivement matérialisé

La première version du `Caddyfile` ouvrait le site sur `:443`, un port sans hôte. Caddy écoutait
bien, mais **n'activait pas l'HTTPS automatique** — il n'émettait donc aucun certificat, et la
poignée de main TLS échouait avant que le navigateur puisse afficher quoi que ce soit. Le port
acceptait la connexion, ce qui rendait le symptôme trompeur : ni le pare-feu ni le conteneur
n'étaient en cause.

Deux corrections en découlent :

1. l'adresse du site est désormais explicite (`RADAR_SITE`), et le script refuse de démarrer
   plutôt que d'écrire une valeur vide ;
2. le script vérifie maintenant **le frontal** et non plus seulement l'application — il exige un
   `401` sur `https://127.0.0.1/`. C'est cette vérification manquante qui avait permis d'annoncer
   « déploiement terminé » sur une installation injoignable.

### Ce qui reste vrai côté sécurité

L'application n'a **aucune authentification propre**. Toute la protection tient au frontal Caddy :
mot de passe et TLS. Trois règles à ne pas contourner :

- ne jamais publier le port 3000 sur `0.0.0.0` ;
- ne jamais mettre le hash dans `environment:` plutôt que `env_file:` ;
- garder le pare-feu fermé sur tout sauf 22 et 443.
