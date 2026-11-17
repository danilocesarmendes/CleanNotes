#!/usr/bin/env bash
# Instalador do CleanNotes para Ubuntu/Debian.
#
# Uso:
#   ./install.sh              instala dependências, compila e instala o .deb
#   ./install.sh --uninstall  remove o CleanNotes (mantém suas notas)
#   ./install.sh --purge      remove o CleanNotes e apaga as notas
#   ./install.sh --help
#
# Rode como usuário normal (não use sudo): o script pede sudo só quando precisa.

set -euo pipefail

APP_PKG="clean-notes"   # nome do pacote .deb (o Tauri converte "CleanNotes" para kebab-case)
APP_BIN="cleannotes"    # comando que abre o app
APP_ID="dev.cleandev.cleannotes"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/$APP_ID"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -t 1 ]; then
  B=$'\e[1m'; G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; N=$'\e[0m'
else
  B=""; G=""; R=""; Y=""; N=""
fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok()   { printf '%s%s%s\n' "$G" "$*" "$N"; }
warn() { printf '%s%s%s\n' "$Y" "$*" "$N" >&2; }
die()  { printf '%sErro: %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

usage() { sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

need_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    die "não rode como root/sudo. Rode ./install.sh como usuário normal; o sudo é chamado quando necessário."
  fi
  command -v sudo >/dev/null || die "sudo não encontrado."
}

check_os() {
  [ -r /etc/os-release ] || die "não consegui identificar o sistema."
  # shellcheck disable=SC1091
  . /etc/os-release
  case " ${ID:-} ${ID_LIKE:-} " in
    *" ubuntu "*|*" debian "*) ;;
    *) die "este instalador é para Ubuntu/Debian (detectado: ${PRETTY_NAME:-desconhecido})." ;;
  esac
  [ "$(uname -m)" = "x86_64" ] || [ "$(uname -m)" = "aarch64" ] \
    || warn "arquitetura $(uname -m) não testada."
  echo "Sistema: ${PRETTY_NAME:-$ID}"
}

uninstall() {
  need_sudo
  step "Removendo $APP_PKG"
  if dpkg -s "$APP_PKG" >/dev/null 2>&1; then
    sudo apt-get remove -y "$APP_PKG"
    ok "CleanNotes removido."
  else
    warn "$APP_PKG não está instalado."
  fi
  if [ "${1:-}" = "purge" ]; then
    step "Apagando notas em $DATA_DIR"
    rm -rf "$DATA_DIR"
    ok "Notas apagadas."
  else
    echo "Suas notas foram mantidas em: $DATA_DIR"
    echo "(use ./install.sh --purge para apagá-las)"
  fi
}

install_system_deps() {
  step "Instalando dependências do sistema (apt)"
  local pkgs=(
    build-essential curl wget file pkg-config
    libwebkit2gtk-4.1-dev libxdo-dev libssl-dev
    libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev
  )
  sudo apt-get update
  sudo apt-get install -y "${pkgs[@]}"
}

version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

ensure_rust() {
  step "Verificando Rust (mínimo 1.77)"
  # shellcheck disable=SC1091
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
  if command -v rustc >/dev/null; then
    local v; v="$(rustc --version | awk '{print $2}')"
    if version_ge "$v" "1.77.0"; then
      echo "Rust $v OK"
      return
    fi
    warn "Rust $v é antigo demais."
    if command -v rustup >/dev/null; then
      rustup update stable
      return
    fi
    die "atualize o Rust (https://rustup.rs) e rode novamente."
  fi
  echo "Rust não encontrado; instalando via rustup (https://rustup.rs)..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
}

ensure_node() {
  step "Verificando Node.js (mínimo 20.19; recomendado 22 LTS)"
  if command -v node >/dev/null && command -v npm >/dev/null; then
    if node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit((a>=23||a===22&&b>=12||a===20&&b>=19)?0:1)'; then
      echo "Node $(node --version) OK"
      return
    fi
    warn "Node $(node --version) é antigo demais."
  fi
  echo "Instalando Node.js via apt..."
  sudo apt-get install -y nodejs npm
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit((a>=23||a===22&&b>=12||a===20&&b>=19)?0:1)' \
    || die "o apt instalou Node $(node --version), mas é preciso 20.19+ (recomendado 22 LTS). Instale via https://nodejs.org ou nvm e rode novamente."
}

build_app() {
  step "Instalando dependências npm"
  cd "$PROJECT_DIR"
  if [ -f package-lock.json ]; then npm ci; else npm install; fi

  step "Compilando (a primeira vez demora alguns minutos)"
  npm run build -- --bundles deb
}

install_deb() {
  step "Instalando o pacote .deb"
  local deb
  deb="$(find "$PROJECT_DIR/src-tauri/target/release/bundle/deb" -maxdepth 1 -name '*.deb' -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | head -n1 | cut -d' ' -f2-)"
  [ -n "$deb" ] && [ -f "$deb" ] || die "nenhum .deb encontrado em src-tauri/target/release/bundle/deb/."
  echo "Pacote: $deb"
  sudo apt-get install -y --reinstall "$deb"
}

main() {
  case "${1:-}" in
    -h|--help) usage; exit 0 ;;
    --uninstall) uninstall; exit 0 ;;
    --purge) uninstall purge; exit 0 ;;
    "") ;;
    *) usage; die "opção desconhecida: $1" ;;
  esac

  [ -f "$PROJECT_DIR/src-tauri/tauri.conf.json" ] \
    || die "rode o script dentro da pasta do projeto CleanNotes."

  need_sudo
  check_os
  install_system_deps
  ensure_rust
  ensure_node
  build_app
  install_deb

  step "Pronto"
  ok "CleanNotes instalado. Abra pelo menu de aplicativos ou rode: $APP_BIN"
  echo "Notas ficam em: $DATA_DIR"
  echo "Para desinstalar: ./install.sh --uninstall"
}

main "$@"
