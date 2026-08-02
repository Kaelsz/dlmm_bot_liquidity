#!/usr/bin/env bash
#
# Installe ou met à jour Meteora Pool Radar sur un VPS Debian/Ubuntu.
#
#   curl -fsSL https://raw.githubusercontent.com/Kaelsz/dlmm_bot_liquidity/main/scripts/deploy.sh | bash
#
# ou, depuis un clone : ./scripts/deploy.sh
#
# Idempotent : un second passage met à jour le code et redémarre, sans toucher
# ni au mot de passe ni à la base.
#
#   --check   préflight seul, n'installe et ne modifie rien
#   --dir D   répertoire d'installation (défaut : ~/radar)
#   --user U  identifiant HTTP (défaut : radar)
#   --site S  nom d'hôte servi par Caddy, ex. https://radar.mondomaine.fr.
#             Par défaut, un nom sslip.io est dérivé de l'IP publique : le TLS
#             exige un nom d'hôte, une IP nue ne peut pas fonctionner.
#   --self-signed  forcer un certificat auto-signé au lieu de Let's Encrypt
#                  (machine sans port 80 joignable depuis internet).

set -euo pipefail

REPO_URL="https://github.com/Kaelsz/dlmm_bot_liquidity.git"
INSTALL_DIR="${HOME}/radar"
HTTP_USER="radar"
SITE=""
SELF_SIGNED=0
CHECK_ONLY=0
HEALTH_TIMEOUT=180

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLD=$'\033[1m'; RST=$'\033[0m'
say()  { printf '%s==>%s %s\n' "$BLD" "$RST" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%s  !!%s %s\n' "$YLW" "$RST" "$*" >&2; }
die()  { printf '\n%serreur%s %s\n' "$RED" "$RST" "$*" >&2; exit 1; }

trap 'die "échec ligne $LINENO. Rien n'\''a été laissé à moitié démarré : relancer le script est sans risque."' ERR

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    --dir)   INSTALL_DIR="${2:?--dir attend un chemin}"; shift 2 ;;
    --user)  HTTP_USER="${2:?--user attend un identifiant}"; shift 2 ;;
    --site)  SITE="${2:?--site attend une adresse}"; shift 2 ;;
    --self-signed) SELF_SIGNED=1; shift ;;
    -h|--help) sed -n '3,22p' "$0"; exit 0 ;;
    *) die "option inconnue : $1" ;;
  esac
done

# ---------------------------------------------------------------- préflight

say "Vérification de la machine"

[ "$(id -u)" -ne 0 ] || warn "lancé en root : l'installation marchera, mais un utilisateur normal avec sudo est préférable"

command -v apt-get >/dev/null 2>&1 \
  || die "ce script cible Debian/Ubuntu (apt-get introuvable). Suivre DEPLOY.md manuellement."

if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
  die "sudo est requis pour installer Docker et ouvrir le pare-feu"
fi
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"

case "$(uname -m)" in
  x86_64|aarch64) ok "architecture $(uname -m)" ;;
  *) warn "architecture $(uname -m) inhabituelle : better-sqlite3 devra se compiler, ce sera plus long" ;;
esac

MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 900 ]; then
  warn "${MEM_MB} Mo de RAM : 'next build' risque d'être tué par l'OOM killer."
  warn "Voir DEPLOY.md §5 pour construire l'image ailleurs et ne déployer que l'image."
else
  ok "${MEM_MB} Mo de RAM"
fi

FREE_MB=$(df -Pm "$(dirname "$INSTALL_DIR")" | awk 'NR==2 {print $4}')
[ "$FREE_MB" -ge 3000 ] || warn "${FREE_MB} Mo libres : compter ~2 Go pour l'image et ~200 Mo pour la base"

if [ "$CHECK_ONLY" -eq 1 ]; then
  if command -v docker >/dev/null 2>&1; then ok "docker présent"; else warn "docker absent, il serait installé"; fi
  if [ -d "$INSTALL_DIR/.git" ]; then ok "clone existant dans $INSTALL_DIR"; else say "clonerait dans $INSTALL_DIR"; fi
  if [ -f "$INSTALL_DIR/.env" ]; then ok ".env existant, il serait conservé"; else say "générerait un mot de passe"; fi
  printf '\n%spréflight terminé, rien n'\''a été modifié.%s\n' "$BLD" "$RST"
  exit 0
fi

# ------------------------------------------------------------------- docker

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "docker et compose déjà installés"
else
  say "Installation de Docker"
  curl -fsSL https://get.docker.com | $SUDO sh
  [ "$(id -u)" -eq 0 ] || $SUDO usermod -aG docker "$USER"
  ok "docker installé"
fi

# Le groupe docker n'est pris en compte qu'à la prochaine session : basculer
# sur sudo pour cette exécution plutôt que d'échouer sur un refus de socket.
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if $SUDO docker info >/dev/null 2>&1; then
    DOCKER="$SUDO docker"
    warn "socket docker inaccessible sans privilèges — utilisation de sudo pour cette exécution."
    warn "Se déconnecter/reconnecter ensuite pour que l'appartenance au groupe 'docker' prenne effet."
  else
    die "le démon Docker ne répond pas. Vérifier : systemctl status docker"
  fi
fi

# --------------------------------------------------------------------- code

if [ -d "$INSTALL_DIR/.git" ]; then
  say "Mise à jour du code dans $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  say "Clonage dans $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"
ok "code sur $(git rev-parse --short HEAD)"

# ------------------------------------------------ adresse publique du frontal

# Le SNI de TLS ne peut pas transporter une adresse IP (RFC 6066) : un
# navigateur ouvrant https://<ip>/ n'envoie aucun nom, et la poignée de main
# échoue. Il faut donc un vrai nom d'hôte. sslip.io en fournit un gratuitement
# pour n'importe quelle IP, ce qui permet en prime à Let's Encrypt d'émettre un
# certificat authentique — donc aucun avertissement de navigateur.
sslip_name() { printf '%s.sslip.io' "$(printf '%s' "$1" | tr '.' '-')"; }

if [ -z "$SITE" ]; then
  say "Détection de l'adresse publique"
  DETECTED="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
  [ -n "$DETECTED" ] || DETECTED="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "$DETECTED" ] || die "impossible de détecter l'adresse publique. La fournir : --site https://mon.domaine"
  SITE="https://$(sslip_name "$DETECTED")"
  ok "adresse : $SITE"
fi
case "$SITE" in
  https://*|http://*) : ;;
  *) SITE="https://${SITE}" ;;
esac

# Une IP nue ne peut pas servir de nom de site : la convertir en sslip.io.
CANDIDATE="${SITE#https://}"; CANDIDATE="${CANDIDATE#http://}"; CANDIDATE="${CANDIDATE%%/*}"
case "$CANDIDATE" in
  *[0-9].[0-9]*)
    if printf '%s' "$CANDIDATE" | grep -Eq '^[0-9]+(\.[0-9]+){3}$'; then
      SITE="https://$(sslip_name "$CANDIDATE")"
      warn "adresse IP nue remplacée par un nom d'hôte : le TLS l'exige."
      ok "adresse : $SITE"
    fi ;;
esac

# ------------------------------------------------------------------- secret

GENERATED_PASSWORD=""
ENVF="radar.env"

# Les valeurs sont écrites entre APOSTROPHES SIMPLES. Compose interpole les
# valeurs d'un env_file : non quotée, `$2a$14$ICFOs…` est amputée en `$2a$14`
# et l'authentification ne peut plus fonctionner. Seules les apostrophes
# simples sont littérales.
write_env() {
  umask 077
  TLS_DIRECTIVE=""
  [ "$SELF_SIGNED" -eq 1 ] && TLS_DIRECTIVE="tls internal"
  cat > "$ENVF" <<EOF
# Généré par scripts/deploy.sh le $(date -Iseconds).
# Les apostrophes simples sont OBLIGATOIRES : sans elles, Docker Compose
# interprète les \$ du hash bcrypt comme des variables et le tronque.
# Pour changer le mot de passe :
#   docker run --rm caddy:2-alpine caddy hash-password --plaintext 'nouveau'
# puis recopier la valeur ci-dessous, entre apostrophes, et relancer ce script.
RADAR_USER='$1'
RADAR_PASSWORD_HASH='$2'
# Adresse servie par Caddy. Doit contenir un hôte (IP ou domaine) : sans lui,
# aucun certificat n'est émis et le HTTPS ne répond pas.
RADAR_SITE='$3'
# Vide = Let's Encrypt (certificat authentique, port 80 requis).
# "tls internal" = certificat auto-signé, avec avertissement de navigateur.
RADAR_TLS_DIRECTIVE='${TLS_DIRECTIVE}'
EOF
}

# Lit une clé dans un fichier d'environnement en retirant un éventuel quotage.
read_env_key() {
  grep "^$2=" "$1" 2>/dev/null | head -1 | cut -d= -f2- | sed "s/^['\"]//; s/['\"]$//"
}

if [ -f "$ENVF" ] && grep -q '^RADAR_PASSWORD_HASH=' "$ENVF"; then
  ok "$ENVF existant : mot de passe conservé"
  EXISTING_SITE="$(read_env_key "$ENVF" RADAR_SITE)"
  EXISTING_HOST="${EXISTING_SITE#https://}"; EXISTING_HOST="${EXISTING_HOST#http://}"; EXISTING_HOST="${EXISTING_HOST%%/*}"
  if printf '%s' "$EXISTING_HOST" | grep -Eq '^[0-9]+(\.[0-9]+){3}$'; then
    # Installation antérieure pointant sur une IP nue : le TLS ne peut pas
    # fonctionner ainsi, on réécrit avec le nom sslip.io correspondant.
    warn "l'adresse configurée est une IP nue, que le TLS ne permet pas de servir"
    SITE="https://$(sslip_name "$EXISTING_HOST")"
    write_env "$(read_env_key "$ENVF" RADAR_USER)" "$(read_env_key "$ENVF" RADAR_PASSWORD_HASH)" "$SITE"
    ok "adresse remplacée : $SITE"
  elif [ -n "$EXISTING_SITE" ]; then
    SITE="$EXISTING_SITE"
    ok "adresse du site : $SITE"
  else
    write_env "$(read_env_key "$ENVF" RADAR_USER)" "$(read_env_key "$ENVF" RADAR_PASSWORD_HASH)" "$SITE"
    ok "RADAR_SITE ajouté : $SITE"
  fi
  HTTP_USER="$(read_env_key "$ENVF" RADAR_USER)"

elif [ -f .env ] && grep -q '^RADAR_PASSWORD_HASH=' .env; then
  # Migration depuis les installations qui utilisaient .env. Le hash y est
  # correct dans le fichier — c'est sa lecture par Compose qui le corrompait —
  # donc le mot de passe déjà noté par l'utilisateur reste valable.
  say "Migration de .env vers $ENVF (quotage du hash)"
  OLD_USER="$(read_env_key .env RADAR_USER)"
  OLD_HASH="$(read_env_key .env RADAR_PASSWORD_HASH)"
  OLD_SITE="$(read_env_key .env RADAR_SITE)"
  [ -n "$OLD_HASH" ] || die "hash illisible dans .env"
  [ -n "$OLD_SITE" ] && SITE="$OLD_SITE"
  [ -n "$OLD_USER" ] && HTTP_USER="$OLD_USER"
  write_env "$HTTP_USER" "$OLD_HASH" "$SITE"
  # Écarter l'ancien fichier : Compose charge tout .env du répertoire projet
  # comme source d'interpolation, ce qui laissait des avertissements trompeurs
  # sur un déploiement pourtant sain.
  mv .env .env.migrated
  ok "$ENVF créé (mot de passe conservé), ancien .env renommé en .env.migrated"

else
  say "Génération du mot de passe d'accès"
  GENERATED_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20)"
  # Le hash est produit par la même image que celle qui l'utilisera.
  HASH="$($DOCKER run --rm caddy:2-alpine caddy hash-password --plaintext "$GENERATED_PASSWORD")"
  [ -n "$HASH" ] || die "la génération du hash a échoué"
  write_env "$HTTP_USER" "$HASH" "$SITE"
  ok "identifiants écrits dans $ENVF (permissions 600)"
fi

# Hôte réellement servi par Caddy : c'est lui qu'il faut interroger, pas
# 127.0.0.1, sinon le SNI ne correspond à aucun site et le TLS échoue.
SITE_HOST="${SITE#https://}"; SITE_HOST="${SITE_HOST#http://}"; SITE_HOST="${SITE_HOST%%/*}"

# ----------------------------------------------------------------- démarrage

say "Construction et démarrage (3 à 5 min au premier passage)"
$DOCKER compose up -d --build

say "Attente de l'application (jusqu'à ${HEALTH_TIMEOUT}s)"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
healthy=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  if curl -fsS --max-time 3 http://127.0.0.1:3000/api/health 2>/dev/null | grep -q '"ok":true'; then
    healthy=1; break
  fi
  sleep 3
done

if [ "$healthy" -ne 1 ]; then
  printf '\n%sL'\''application n'\''a pas répondu à temps.%s Journaux :\n\n' "$RED" "$RST" >&2
  $DOCKER compose logs --tail=50 >&2 || true
  printf '\nPistes : mémoire insuffisante pendant le build, ou échec de compilation de\n' >&2
  printf 'better-sqlite3. DEPLOY.md §7 liste les causes courantes.\n' >&2
  exit 1
fi
ok "application en ligne"

# Le contrôle ci-dessus ne teste que l'app derrière le proxy. Sans ce second
# contrôle, une erreur de configuration TLS passe inaperçue et le script
# annonce un succès sur une installation injoignable — c'est précisément ce
# qui s'est produit avec une adresse de site sans hôte.
say "Vérification du frontal HTTPS"

# --resolve : on envoie le bon SNI (l'hôte du site) tout en se connectant en
# local. Interroger 127.0.0.1 directement présenterait un SNI que Caddy ne sert
# pas — aucun certificat, poignée de main échouée, et un faux diagnostic de
# frontal mort.
front() { curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \
            --resolve "${SITE_HOST}:443:127.0.0.1" "$@" "https://${SITE_HOST}/" 2>/dev/null || true; }

# L'émission Let's Encrypt prend quelques dizaines de secondes au premier
# passage : laisser de la marge avant de conclure à un échec.
FRONT_CODE=""
deadline=$(( $(date +%s) + 150 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  FRONT_CODE="$(front)"
  [ "$FRONT_CODE" = "000" ] || [ -z "$FRONT_CODE" ] || break
  sleep 3
done

if [ -z "$FRONT_CODE" ] || [ "$FRONT_CODE" = "000" ]; then
  printf '\n%sLe frontal HTTPS ne répond pas sur %s.%s Journaux de Caddy :\n\n' "$RED" "$SITE_HOST" "$RST" >&2
  $DOCKER compose logs --tail=40 caddy >&2 || true
  cat >&2 <<MSG

RADAR_SITE actuel : $(read_env_key "$ENVF" RADAR_SITE)

Causes les plus fréquentes :
  - le port 80 n'est pas joignable depuis internet, donc Let's Encrypt ne peut
    pas valider le domaine et aucun certificat n'est émis. Ouvrir 80/tcp.
  - pas d'ACME possible sur cette machine :
      ./scripts/deploy.sh --self-signed
  - autre nom d'hôte :
      ./scripts/deploy.sh --site https://mon.domaine
MSG
  exit 1
fi

case "$FRONT_CODE" in
  401) ok "TLS établi, authentification active (401 sans identifiants)" ;;
  200) warn "le frontal répond 200 sans identifiants : basic_auth ne protège rien." ;;
  *)   warn "le frontal répond ${FRONT_CODE} (401 attendu) — vérifier le Caddyfile" ;;
esac

# Contrôle décisif, possible seulement quand on vient de générer le mot de
# passe : il vérifie que le hash est arrivé INTACT jusqu'à Caddy. C'est ce qui
# manquait quand l'interpolation de Compose tronquait silencieusement le hash.
if [ -n "$GENERATED_PASSWORD" ]; then
  say "Vérification de l'authentification"
  AUTH_CODE="$(front -u "${HTTP_USER}:${GENERATED_PASSWORD}")"
  case "$AUTH_CODE" in
    200)
      ok "identifiants acceptés — le hash est intact" ;;
    401)
      printf '\n%sLe mot de passe généré est refusé.%s\n' "$RED" "$RST" >&2
      printf 'Le hash a été altéré entre %s et Caddy. Vérifier que les valeurs de\n' "$ENVF" >&2
      printf '%s sont bien entre apostrophes simples : Compose interpole sinon les $.\n' "$ENVF" >&2
      $DOCKER compose logs --tail=20 caddy >&2 || true
      exit 1 ;;
    *)
      warn "réponse ${AUTH_CODE} avec identifiants (200 attendu)" ;;
  esac
fi

# ----------------------------------------------------------------- pare-feu

if command -v ufw >/dev/null 2>&1; then
  say "Pare-feu"
  $SUDO ufw allow 22/tcp  >/dev/null 2>&1 || true
  $SUDO ufw allow 80/tcp  >/dev/null 2>&1 || true
  $SUDO ufw allow 443/tcp >/dev/null 2>&1 || true
  ok "ports 22, 80 et 443 autorisés (3000 reste fermé, et doit le rester)"
else
  warn "ufw absent : vérifier que seuls 22 et 443 sont joignables, jamais 3000"
fi

# ------------------------------------------------------------------- sortie

cat <<EOF

${GRN}${BLD}Déploiement terminé.${RST}

  Adresse     ${BLD}${SITE}/${RST}
  Identifiant ${HTTP_USER}
EOF

if [ -n "$GENERATED_PASSWORD" ]; then
  cat <<EOF
  Mot de passe ${BLD}${GENERATED_PASSWORD}${RST}

  ${YLW}Noter ce mot de passe maintenant : il n'est affiché qu'une fois${RST}
  (seul son hash est conservé, dans .env).
EOF
else
  echo "  Mot de passe  inchangé (défini lors d'une exécution précédente)"
fi

cat <<EOF

  Le navigateur affichera un ${BLD}avertissement de certificat${RST}. C'est attendu :
  sans nom de domaine, aucune autorité publique ne peut signer un certificat,
  donc Caddy en émet un lui-même. La connexion est chiffrée — ce qui protège
  le mot de passe — mais l'identité du serveur n'est pas attestée. Accepter
  une fois. Pour supprimer l'avertissement, il faut un nom de domaine
  (voir DEPLOY.md).

  Les colonnes dérivées (Fees/min, Vol/min, Accél.) restent vides ~15 min :
  elles se calculent entre deux échantillons successifs.

  Journaux      docker compose -f ${INSTALL_DIR}/docker-compose.yml logs -f
  Mise à jour   ${INSTALL_DIR}/scripts/deploy.sh
EOF
