#!/usr/bin/env bash
# Instala Mail en el sistema: binario, icono y lanzador.
#
#   sudo ./deploy/install.sh [--user NOMBRE]     instalar o actualizar
#   sudo ./deploy/install.sh --uninstall         quitarlo (no borra tus correos: ~/.local/share/lux-desktop)
#
# Antes: cmake -S . -B build && cmake --build build --target luxmail
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "ejecútalo con sudo" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")/.." && pwd)
APP_USER=${SUDO_USER:-}
UNINSTALL=0
while [ $# -gt 0 ]; do
  case $1 in
    --user) APP_USER=$2; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "opción desconocida: $1" >&2; exit 2 ;;
  esac
done

if [ $UNINSTALL -eq 1 ]; then
  rm -f /usr/local/bin/mail-desktop /usr/share/applications/mail-desktop.desktop /usr/share/icons/hicolor/256x256/apps/mail-desktop.png
  rm -rf /opt/mail-desktop
  echo "Desinstalado. Tus correos y ajustes se han conservado."
  exit 0
fi

[ -n "$APP_USER" ] && [ "$APP_USER" != root ] || { echo "indica tu usuario: --user NOMBRE" >&2; exit 2; }
id "$APP_USER" >/dev/null || { echo "no existe el usuario $APP_USER" >&2; exit 2; }
BIN=$HERE/build/luxmail
[ -x "$BIN" ] || { echo "falta $BIN: compila primero (cmake --build build --target luxmail)" >&2; exit 1; }

echo "==> Instalando en /usr/local/bin/mail-desktop"
# `install` borra el destino antes de copiar: sirve aunque la app esté abierta.
install -m 0755 "$BIN" /usr/local/bin/mail-desktop
install -Dm 0644 "$HERE/app/icon.png" /usr/share/icons/hicolor/256x256/apps/mail-desktop.png
install -Dm 0644 "$HERE/deploy/mail-desktop.desktop" /usr/share/applications/mail-desktop.desktop
gtk-update-icon-cache -qf /usr/share/icons/hicolor 2>/dev/null || true

# Para que la ventana busque actualizaciones: de qué repositorio y commit se instaló.
install -d /opt/mail-desktop
echo "$HERE" > /opt/mail-desktop/source
runuser -u "$APP_USER" -- git -C "$HERE" rev-parse HEAD > /opt/mail-desktop/version 2>/dev/null || rm -f /opt/mail-desktop/version

echo "Listo. Ábrelo desde el menú de aplicaciones o con: mail-desktop"
