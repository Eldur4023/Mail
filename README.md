# Mail

Cliente de correo de escritorio hecho con [Lux](vendor/lux): una ventana nativa GTK + WebKitGTK en lugar de un Chromium empaquetado, **LuxScript** en lugar de Node, y **un único binario** que se compila y se ejecuta. Una sola bandeja con varias cuentas, cada una con su color, y cambio fácil de cuenta al enviar o responder.

## Estructura

| Ruta | Qué es |
|---|---|
| `app/` | La app, en LuxScript: `app.lux` (configuración y ventana), `sync.lux` (IMAP → SQLite), `messages.lux`, `send.lux`, `drafts.lux`, `actions.lux`, `folders.lux`, `accounts.lux`, `contacts.lux`, `db.lux`, `secrets.lux`, `window.lux` (menú, bandeja, notificaciones) y la interfaz en `templates/` y `public/`. |
| `src/`, `include/`, `third_party/webview` | El shell de escritorio: ventana GTK/WebKit, arranque del servidor Lux por loopback y extracción de los recursos embebidos. |
| `vendor/lux/` | Lux como código fuente, **copia de la rama `dev` del repositorio principal `Lux`** (con los módulos de correo `imap`, `mail`, `mailparse`, `keyring`), más el módulo `window` de Lux Desktop (que no está en Lux; su casa es `Lux-Local`). |
| `tools/` | `respack` (embebe `app/` en el binario), `check_account.py` (diagnóstico de una cuenta) y los scripts de Android. |
| `tests/` | Prueba de extremo a extremo con servidores IMAP y SMTP falsos. |

`vendor/lux/` no se edita aquí: cualquier cambio en Lux (incluidos los módulos de correo) se hace en el repositorio `Lux`, rama `dev`, y se re-vendorea (se copian los ficheros; el módulo `window` se conserva).

## Probar con tu correo real

1. **Llavero:** `sudo apt install libsecret-tools` (y un servicio de llavero activo: GNOME Keyring o KWallet). Las contraseñas van ahí, nunca a la base de datos.
2. **Comprueba la cuenta antes de añadirla** (opcional, no guarda nada ni envía nada):

       python3 tools/check_account.py tu@dominio.es --imap imap.dominio.es --smtp smtp.dominio.es

   Pide la contraseña por teclado, hace login IMAP y SMTP, y lista las carpetas con su rol (Enviados, Borradores, Papelera, Archivo, Spam) y las capacidades del servidor. Opciones: `--user` si el login no es el correo, `--imap-starttls`, `--smtp-ssl` (puerto 465).
3. **Compila y arranca:** `cmake -S . -B build && cmake --build build --target luxmail && ./build/luxmail`.
4. **+ Cuenta:** al escribir el correo se sugieren los servidores (`imap.<dominio>` / `smtp.<dominio>`, o los de los proveedores habituales); revisa y pulsa **Probar conexión**, que comprueba IMAP y SMTP por separado. Luego Guardar.
5. La primera sincronización baja los **últimos 50 mensajes de cada carpeta**; después solo lo nuevo. Se repite cada 3 minutos y al pulsar ⟳. Los datos viven en `~/.local/share/lux-desktop/luxmail/`.

Si algo no cuadra (carpetas sin rol, mensajes que no aparecen), mira primero la salida de `check_account.py`.

## Ejecutar

Binario de escritorio (un solo ejecutable, ventana nativa GTK/WebKit, menú, bandeja y notificaciones):

    cmake -S . -B build && cmake --build build --target luxmail && ./build/luxmail
    ./build/vendor/lux/lux app --port 8080    # recarga solo al guardar; en un navegador (sin el módulo `window`: menú, bandeja y avisos no existen)

(Ya no hay `luxmail-dev`: usaba una API de `lux::App` que Lux ya no tiene.)

## Instalar y actualizar

    cmake -S . -B build && cmake --build build --target luxmail
    pkexec ./deploy/install.sh --user "$USER"      # o con sudo; deja `mail-desktop` en el menú de aplicaciones

Al abrir la ventana se compara el commit instalado con GitHub (`git fetch` en el repositorio desde el que se instaló;
`install.sh` lo anota en `/opt/mail-desktop/source` y `version`). Si hay cambios sale un aviso con la lista;
**Actualizar** ejecuta `deploy/update.sh` en segundo plano: `git pull --ff-only`, compilar y `pkexec deploy/install.sh`.
La contraseña la pide el diálogo del sistema (polkit), una vez y solo para instalar; la app nunca la ve.
Registro en `~/.cache/mail-update.log`. Al terminar, **Reiniciar Mail** abre la versión nueva y cierra la anterior.
`./deploy/install.sh --uninstall` lo quita sin tocar tus correos.

## Android

El mismo servidor Lux corre dentro de la APK (`src/android.cpp` → `libluxlocal.so`) y un `WebView` carga la interfaz por loopback; las
contraseñas van al Android Keystore en lugar de `secret-tool`. El proyecto Gradle está en `android/`.

    export ANDROID_NDK=...                                   # r26+, API mínima 28
    tools/android-build.sh arm64-v8a x86_64                  # OpenSSL + curl + SQLite + libluxlocal.so por ABI
    cd android && gradle assembleDebug                       # JDK 17, Gradle 8.7, SDK 34 (sdk.dir en local.properties)

Probado en un emulador (Android 14, x86_64) contra los servidores IMAP/SMTP falsos de `tests/`: sincroniza, lista, abre, responde con la
navegación del móvil (cajón de carpetas, «atrás» cierra diálogo/pestaña) y envía. Sin probar en un teléfono real (arm64), con un servidor
real (TLS) ni con los adjuntos del selector de archivos. Sincroniza con la app cerrada, sin servicio en primer plano ni notificación fija: una cadena de alarmas que despiertan el móvil llama a
`/api/sync` cada 2 minutos (`Sync.kt`); el aviso de correo nuevo es `window.notify` → notificación de Android. Se arranca al abrir la app y al
reiniciar, y pide la excepción de ahorro de batería la primera vez. Sin IDLE (libcurl no lo tiene) es sondeo: con el acceso especial
«Alarmas y recordatorios» la alarma es exacta; en Doze profundo Android puede espaciarlas hasta ~9 minutos. (Se probó antes `JobScheduler`:
su temporizador no despierta el dispositivo y tardaba más de 2 minutos.)

## Teclado

`j`/`k` o `↓`/`↑` moverse por la lista · `Intro` abrir en pestaña · `w` o `Esc` cerrar pestaña · `[` `]` cambiar de pestaña · `x` marcar · `/` buscar · `c` redactar · `r` responder · `a` responder a todos · `f` reenviar · `e` archivar · `!` spam · `m` mover · `u` no leído · `Supr` eliminar · `?` ayuda · `Esc` cancelar. En la redacción: `Ctrl+S` guarda, `Ctrl+Intro` envía, `Ctrl+1…9` cambia de cuenta.

## Estado

Hecho:
- Varias cuentas IMAP/SMTP (contraseña en el llavero) en una bandeja unificada, con color por cuenta y filtro por cuenta.
- Sincronización incremental a SQLite + `.eml` (lee offline), con flags, borrados y carpetas que viajan en los dos sentidos.
- Conversaciones agrupadas (por `In-Reply-To`/`References`, y por asunto en respuestas sin cabeceras); abrir una la deja leída.
- Lectura segura (HTML aislado sin scripts, imágenes remotas bloqueadas, imágenes incrustadas visibles), búsqueda de texto completo FTS5.
- Redactar, responder, responder a todos y reenviar eligiendo la cuenta «De:»; adjuntos (también al reenviar); firma por cuenta; texto plano o enriquecido (negrita, cursiva, subrayado, listas, enlaces, **imágenes en el cuerpo**; se envía con alternativa de texto y el HTML se filtra por lista blanca).
- Borradores en el servidor (se reabren con adjuntos e imágenes).
- Archivar, spam, eliminar (definitivo desde la Papelera, con confirmación), marcar leído/no leído y mover a cualquier carpeta, siempre sobre la conversación entera. Selección múltiple con las mismas acciones en lote.
- **Carpetas propias**: crear, renombrar y eliminar desde la barra lateral (nombres con tildes y `&` en UTF-7 modificado); las que se borran o renombran desde otro cliente se retiran al sincronizar.
- Ajustes de cuenta (nombre, color, firma, contraseña, quitar cuenta), probar conexión antes de guardar, contactos con autocompletado.
- Escritorio: tema oscuro naranja, menú con atajos, bandeja del sistema y notificación de correo nuevo.
- Los fallos del servidor (IMAP caído, SMTP rechazado, MOVE denegado) abortan la operación sin tocar lo local ni dar nada por enviado.

Límites conocidos: sin IDLE (se sondea cada 3 min); cada llamada IMAP abre una conexión nueva; carpetas solo de primer nivel al crear; sin OAuth2.

Pruebas de extremo a extremo (IMAP y SMTP falsos): `tests/run_mail.sh` (usa `build/vendor/lux/lux`). Los módulos nativos se prueban en el repositorio `Lux` (`tests/run_imap.sh`, `tests/run_mailparse.sh`).

## OAuth2 (decidido: no se implementa)

Solo se usa IMAP/SMTP con contraseña (cuentas propias). Gmail/Outlook con OAuth2 queda sin hacer a propósito, pero el
terreno está preparado: los módulos `imap` y `mail` aceptan `token` (XOAUTH2) en vez de `password`, y `accounts.auth`
admite `oauth_google` / `oauth_ms`. Faltaría el flujo de login (abrir el navegador, recibir el `code` en una ruta
loopback, canjearlo y refrescar tokens) y client IDs propios.
