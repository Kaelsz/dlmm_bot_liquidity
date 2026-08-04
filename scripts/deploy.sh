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
#   --site S  nom d'hôte servi par Caddy, ex. https://radar.mondomaine.fr.
#             Par défaut, un nom sslip.io est dérivé de l'IP publique : le TLS
#             exige un nom d'hôte, une IP nue ne peut pas fonctionner.
#   --self-signed  forcer un certificat auto-signé au lieu de Let's Encrypt
#                  (machine sans port 80 joignable depuis internet).

set -euo pipefail

REPO_URL="https://github.com/Kaelsz/dlmm_bot_liquidity.git"
INSTALL_DIR="${HOME}/radar"
SITE=""
SITE_FROM_FLAG=""
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
    --site)  SITE="${2:?--site attend une adresse}"; SITE_FROM_FLAG=1; shift 2 ;;
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

ENVF="radar.env"

# Lit une clé en retirant un éventuel quotage.
read_env_key() {
  grep "^$2=" "$1" 2>/dev/null | head -1 | cut -d= -f2- | sed "s/^['\"]//; s/['\"]\$//"
}

# Écrit UNE clé sans toucher au reste du fichier.
#
# Une réécriture complète effacerait les valeurs ajoutées à la main — RPC_URL
# en particulier. Les valeurs sont entre APOSTROPHES SIMPLES : Compose
# interpole aussi les valeurs d'un env_file, et une valeur non quotée
# contenant `$` serait amputée.
set_env_key() {
  umask 077
  touch "$ENVF"
  if grep -q "^$1=" "$ENVF"; then
    tmp="$(mktemp)"
    grep -v "^$1=" "$ENVF" > "$tmp"
    printf "%s='%s'\n" "$1" "$2" >> "$tmp"
    mv "$tmp" "$ENVF"
  else
    printf "%s='%s'\n" "$1" "$2" >> "$ENVF"
  fi
  chmod 600 "$ENVF"
}

if [ ! -f "$ENVF" ]; then
  say "Création de $ENVF"
  cat > "$ENVF" <<EOF
# Généré par scripts/deploy.sh le $(date -Iseconds).
# Les apostrophes simples sont OBLIGATOIRES : Docker Compose interpole les
# valeurs d'un env_file, et une valeur contenant \$ serait tronquée sans elles.
#
# Pour la vue Positions, ajouter l'URL RPC COMPLÈTE (pas seulement la clé) :
#   RPC_URL='https://mainnet.helius-rpc.com/?api-key=xxxxxxxx'
EOF
  chmod 600 "$ENVF"
fi

# Une adresse passée en --site l'emporte sur celle enregistrée : sans ça,
# changer de domaine était silencieusement sans effet.
EXISTING_SITE="$(read_env_key "$ENVF" RADAR_SITE)"
if [ -z "$SITE_FROM_FLAG" ] && [ -n "$EXISTING_SITE" ]; then
  EXISTING_HOST="${EXISTING_SITE#https://}"; EXISTING_HOST="${EXISTING_HOST#http://}"
  EXISTING_HOST="${EXISTING_HOST%%/*}"
  if printf '%s' "$EXISTING_HOST" | grep -Eq '^[0-9]+(\.[0-9]+){3}$'; then
    warn "l'adresse enregistrée est une IP nue, que le TLS ne permet pas de servir"
    SITE="https://$(sslip_name "$EXISTING_HOST")"
  else
    SITE="$EXISTING_SITE"
  fi
fi
set_env_key RADAR_SITE "$SITE"
ok "adresse du site : $SITE"

TLS_DIRECTIVE=""
[ "$SELF_SIGNED" -eq 1 ] && TLS_DIRECTIVE="tls internal"
set_env_key RADAR_TLS_DIRECTIVE "$TLS_DIRECTIVE"

if [ -n "$(read_env_key "$ENVF" RPC_URL)" ]; then
  ok "RPC_URL présent : la vue Positions sera active"
else
  warn "RPC_URL absent de $ENVF — la vue Positions restera inactive."
  warn "Ajouter l'URL COMPLÈTE entre apostrophes, puis relancer ce script :"
  warn "  RPC_URL='https://mainnet.helius-rpc.com/?api-key=xxxxxxxx'"
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
            --resolve "${SITE_HOST}:443:127.0.0.1" "https://${SITE_HOST}/" 2>/dev/null || true; }

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
  200) ok "TLS établi, le site répond (200)" ;;
  401) warn "le frontal réclame une authentification alors que le site est public" ;;
  *)   warn "le frontal répond ${FRONT_CODE} (200 attendu) — vérifier le Caddyfile" ;;
esac

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
  Accès       public, sans mot de passe

  Les colonnes dérivées (Fees/min, Vol/min, Accél.) restent vides ~15 min :
  elles se calculent entre deux relevés successifs du compteur de fees.

  Journaux      docker compose -f ${INSTALL_DIR}/docker-compose.yml logs -f
  Mise à jour   ${INSTALL_DIR}/scripts/deploy.sh
  Domaine       ${INSTALL_DIR}/scripts/deploy.sh --site https://mondomaine.com
EOF
