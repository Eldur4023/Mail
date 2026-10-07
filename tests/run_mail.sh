#!/usr/bin/env bash
# End to end: two accounts against a fake IMAP and SMTP server, with a stub `secret-tool`.
# Usage: tests/run_mail.sh [path-to-lux-binary]   (default build/vendor/lux/lux)
set -u
cd "$(dirname "$0")/.."
LUX=$(realpath "${1:-build/vendor/lux/lux}")
T=$(mktemp -d); trap '[ -n "${KEEP:-}" ] || rm -rf "$T"; kill $(jobs -p) 2>/dev/null' EXIT
IMAP=14170; SMTP=14171; WEB=18110
mkdir "$T/bin"
cat > "$T/bin/secret-tool" <<STUB
#!/bin/bash
f=$T/secret_\${@: -1}
case "\$1" in store) cat > \$f;; lookup) cat \$f 2>/dev/null || exit 1;; clear) rm -f \$f;; esac
STUB
chmod +x "$T/bin/secret-tool"
python3 tests/imap_fake_server.py $IMAP "$T/imap.log" & python3 tests/smtp_fake_server.py $SMTP "$T/smtp.log" & sleep 0.5
cp -r app "$T/app"; rm -rf "$T/app/data"; cd "$T/app"
# `lux` a secas no tiene el módulo window: fuera su import, su bloque y window.lux
cp ../tests/window_stub.lux window.lux 2>/dev/null || cp "$OLDPWD/tests/window_stub.lux" window.lux
sed -i '/^import window$/d; /^    window:$/,/^        icon /d' app.lux
LUX_MAIL_OPT="$T/sin-instalar" PATH="$T/bin:$PATH" "$LUX" . --port $WEB >"$T/srv.log" 2>&1 & sleep 2
fail=0
check() { if grep -qF -- "$2" <<<"$1"; then echo "ok   $3"; else echo "FAIL $3: wanted [$2]"; fail=1; fi; }
acct() { curl -s -m 10 -XPOST localhost:$WEB/api/accounts -d "name=$1&email=$2&password=pw&color=%23$3&imap_host=127.0.0.1&imap_port=$IMAP&imap_tls=none&smtp_host=127.0.0.1&smtp_port=$SMTP&smtp_tls=none"; }
check "$(curl -s -m 10 localhost:$WEB/api/update)" '"available":false' "actualizaciones: sin instalar no avisa"
check "$(curl -s -m 10 -o /dev/null -w "%{http_code}" -XPOST localhost:$WEB/api/update)" 400 "actualizaciones: sin instalar no lanza nada"
check "$(curl -s -m 5 localhost:$WEB/api/update/log)" '"state"' "actualizaciones: registro"
check "$(acct Trabajo yo@x.com 1d4ed8)" '"id":1' "alta cuenta 1"
check "$(acct Personal yo@y.com 16a34a)" '"id":2' "alta cuenta 2"
check "$(curl -s -m 60 -XPOST localhost:$WEB/api/sync)" '"added":8' "sync de dos cuentas"
check "$(curl -s -m 60 -XPOST localhost:$WEB/api/sync)" '"added":0' "segunda sync incremental"
M0=$(curl -s -m 5 "localhost:$WEB/api/messages?role=inbox"); M=$M0; check "$M" '"color":"#16a34a"' "bandeja unificada con color"
check "$(curl -s -m 5 "localhost:$WEB/api/messages?role=inbox&account=2&q=dos")" '"account_id":2' "filtro por cuenta + búsqueda"
# enviar como la cuenta 2, respondiendo a un mensaje; Cco solo en el sobre
curl -s -m 20 localhost:$WEB/api/send -d "account=2" --data-urlencode $'to=ana@z.com\nluis@z.com' \
  -d "bcc=oculto@z.com" --data-urlencode "subject=Re: Café" -d "body=Hola" \
  -d "in_reply_to=<orig@x>" -d "references=<r1@x> <orig@x>" >"$T/send.out"
check "$(cat "$T/send.out")" '"ok":true' "send ok"
S=$(cat "$T/smtp.log")
check "$S" 'MAIL FROM:<yo@y.com>' "sobre: remitente = cuenta elegida"
check "$S" 'RCPT TO:<oculto@z.com>' "sobre: Cco"
check "$S" 'RCPT TO:<luis@z.com>' "sobre: segundo destinatario"
check "$S" 'From: "Personal" <yo@y.com>' "cabecera From"
check "$S" 'In-Reply-To: <orig@x>' "In-Reply-To"
check "$S" 'References: <r1@x> <orig@x>' "References"
if grep -q 'oculto@z.com' <(sed -n '/^Date:/,/^=====/p' "$T/smtp.log"); then echo "FAIL Cco aparece en el mensaje"; fail=1; else echo "ok   Cco ausente del mensaje"; fi
check "$(cat "$T/imap.log")" 'APPEND' "copia en Enviados (IMAP APPEND)"
# búsqueda de texto completo: cuerpo, sin acentos, prefijos, y una consulta con sintaxis FTS5 hostil no rompe
Q() { curl -s -m 10 -G "localhost:$WEB/api/messages" --data-urlencode "role=inbox" --data-urlencode "q=$1"; }
check "$(Q 'body tw')" '"snippet":"body two' "FTS: prefijos y varias palabras en el cuerpo"
check "$(Q 'DOS')" '"subject":"dos"' "FTS: sin distinguir mayúsculas"
check "$(Q 'NEAR( AND "x" OR - * ^')" '[' "FTS: sintaxis hostil no da error"
if [ "$(Q 'noexiste')" = "[]" ]; then echo "ok   FTS: sin resultados"; else echo "FAIL FTS: sin resultados"; fail=1; fi
# marcar leído: local al instante, y en el servidor (UID STORE)
curl -s -m 20 -XPOST localhost:$WEB/api/message/2/seen >/dev/null
check "$(cat "$T/imap.log")" 'UID STORE 9 +FLAGS.SILENT (\Seen)' "leído enviado al servidor"
check "$(curl -s -m 5 "localhost:$WEB/api/messages?role=inbox&account=1&q=dos")" '"seen":1' "leído guardado en local"
# otro cliente: deja el 9 como no leído y borra el 5; el sync lo refleja
remote() { exec 3<>/dev/tcp/127.0.0.1/$IMAP; printf '%s\r\n' "x X-TEST $1" >&3; sleep 0.2; exec 3>&-; }
remote 'FLAGS 9 '; remote 'DELETE 5'
curl -s -m 60 -XPOST localhost:$WEB/api/sync >/dev/null
M=$(curl -s -m 5 "localhost:$WEB/api/messages?role=inbox&account=1")
if grep -q '"subject":"one"' <<<"$M"; then echo "FAIL borrado remoto no se refleja"; fail=1; else echo "ok   borrado en el servidor retirado en local"; fi
check "$M" '"subject":"dos"' "el otro mensaje sigue"
check "$M" '"subject":"dos","from_name":"b@x.com","from_email":"b@x.com","to_text":"","date":0,"seen":0' "flag cambiado en otro cliente refrescado"
# quitar una cuenta borra sus mensajes y su índice (cascada + trigger)
curl -s -m 10 -XPOST localhost:$WEB/api/accounts/2/delete >/dev/null
if [ "$(Q 'body')" != "[]" ] && grep -q '"account_id":2' <<<"$(Q 'body')"; then echo "FAIL el índice conserva mensajes de una cuenta borrada"; fail=1; else echo "ok   cuenta borrada: sin mensajes en la búsqueda"; fi
# borradores: guardar sin destinatario, conservar Cco, reemplazar la versión anterior, enviar, descartar
draft() { curl -s -m 20 localhost:$WEB/api/draft -d account=1 --data-urlencode "subject=$1" -d "body=$2" ${3:+-d "bcc=oculto@z.com"} ${4:+--data-urlencode "replaces=$4"}; }
D1=$(draft "Borrador uno" "texto 1" bcc); check "$D1" '"message_id":"<' "guardar borrador sin destinatario"
check "$(cat "$T/imap.log")" 'Bcc: oculto@z.com' "el borrador conserva el Cco"
ID1=$(sed -E 's/.*"message_id":"([^"]+)".*/\1/' <<<"$D1")
D2=$(draft "Borrador dos" "texto 2" "" "$ID1"); ID2=$(sed -E 's/.*"message_id":"([^"]+)".*/\1/' <<<"$D2")
curl -s -m 60 -XPOST localhost:$WEB/api/sync >/dev/null
DR=$(curl -s -m 5 "localhost:$WEB/api/messages?role=drafts&account=1")
check "$DR" '"subject":"Borrador dos"' "el borrador guardado aparece en Borradores"
if grep -q 'Borrador uno' <<<"$DR"; then echo "FAIL la versión anterior del borrador sigue"; fail=1; else echo "ok   la versión anterior se retiró"; fi
check "$(curl -s -m 20 localhost:$WEB/api/send -d account=1 -d to=ana@z.com -d subject="Borrador dos" -d body="texto 2" --data-urlencode "draft=$ID2")" '"warning":""' "enviar un borrador sin avisos"
curl -s -m 60 -XPOST localhost:$WEB/api/sync >/dev/null
if [ "$(curl -s -m 5 "localhost:$WEB/api/messages?role=drafts&account=1")" = "[]" ]; then echo "ok   enviarlo retira el borrador"; else echo "FAIL el borrador sigue tras enviarlo"; fail=1; fi
D3=$(draft "Borrador tres" "x"); ID3=$(sed -E 's/.*"message_id":"([^"]+)".*/\1/' <<<"$D3")
curl -s -m 20 -XPOST localhost:$WEB/api/draft/discard -d account=1 --data-urlencode "message_id=$ID3" >/dev/null
curl -s -m 60 -XPOST localhost:$WEB/api/sync >/dev/null
if [ "$(curl -s -m 5 "localhost:$WEB/api/messages?role=drafts&account=1")" = "[]" ]; then echo "ok   descartar borra el borrador"; else echo "FAIL descartar no borró"; fail=1; fi
# adjunto por multipart
printf 'contenido-adjunto' > "$T/nota.txt"
UP=$(curl -s -m 20 localhost:$WEB/api/upload -F "file=@$T/nota.txt"); check "$UP" '"name":"nota.txt"' "subida de adjunto"
ID=$(sed -E 's/.*"id":"([0-9a-f]+)".*/\1/' <<<"$UP")
check "$(curl -s -m 20 localhost:$WEB/api/send -d account=1 -d to=ana@z.com -d subject=Adjunto -d body=Mira -d "attachments=$ID")" '"ok":true' "send con adjunto"
check "$(curl -s -o /dev/null -w %{http_code} localhost:$WEB/api/send -d account=1 -d to=a@z.com -d "attachments=../../etc/")" '400' "id de adjunto inválido rechazado"
S=$(cat "$T/smtp.log")
check "$S" 'filename="nota.txt"' "adjunto con su nombre"
check "$S" "$(printf 'contenido-adjunto' | base64)" "contenido del adjunto en base64"
# contactos: remitentes recibidos y destinatarios enviados; las cuentas propias no
C=$(curl -s -m 5 "localhost:$WEB/api/contacts?q=")
check "$C" '"email":"a@x.com"' "contacto de un correo recibido"
check "$C" '"email":"ana@z.com"' "contacto de un destinatario"
if grep -q 'yo@x.com' <<<"$C"; then echo "FAIL una cuenta propia es contacto"; fail=1; else echo "ok   cuentas propias fuera de contactos"; fi
check "$(curl -s -m 5 "localhost:$WEB/api/contacts?q=ana")" '"email":"ana@z.com"' "búsqueda de contactos"
first_id() { curl -s -m 5 "localhost:$WEB/api/messages?role=$1&account=1" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r[0]['id'] if r else '')"; }
# ── adjuntos de un borrador reabierto ────────────────────────────────────────────
printf 'adjunto-de-borrador' > "$T/guardado.txt"
UPD=$(curl -s -m 20 localhost:$WEB/api/upload -F "file=@$T/guardado.txt"); UID1=$(sed -E 's/.*"id":"([0-9a-f]+)".*/\1/' <<<"$UPD")
curl -s -m 20 localhost:$WEB/api/draft -d account=1 -d subject="Con adjunto" -d body=x -d "attachments=$UID1" >/dev/null
curl -s -m 60 -XPOST localhost:$WEB/api/sync >/dev/null
DID=$(first_id drafts)
RES=$(curl -s -m 20 -XPOST localhost:$WEB/api/message/$DID/attachments)
check "$RES" '"name":"guardado.txt"' "recuperar adjuntos de un borrador"
RID=$(sed -E 's/.*"id":"([0-9a-f]+)".*/\1/' <<<"$RES")
curl -s -m 20 localhost:$WEB/api/send -d account=1 -d to=ana@z.com -d subject=Reabierto -d body=Hola -d "attachments=$RID" >/dev/null
check "$(cat "$T/smtp.log")" "$(printf 'adjunto-de-borrador' | base64)" "el adjunto recuperado se envía"
check "$(curl -s -o /dev/null -w %{http_code} -XPOST localhost:$WEB/api/message/99999/attachments)" '404' "adjuntos de un mensaje inexistente: 404"
# ── ajustes de cuenta ─────────────────────────────────────────────────────────
code() { curl -s -o /dev/null -w "%{http_code}" -XPOST "localhost:$WEB$1" ${2:+--data-urlencode "$2"} ${3:+--data-urlencode "$3"} ${4:+--data-urlencode "$4"} ${5:+--data-urlencode "$5"}; }
check "$(code /api/accounts/1/update name=Oficina color=#aa3300 "signature=Un saludo, Yo" password=nueva-clave)" '204' "actualizar cuenta"
A=$(curl -s -m 5 localhost:$WEB/api/accounts)
check "$A" '"name":"Oficina","email":"yo@x.com","color":"#aa3300","signature":"Un saludo, Yo"' "nombre, color y firma guardados"
check "$(cat "$T/secret_1")" 'nueva-clave' "contraseña nueva en el llavero"
check "$(code /api/accounts/1/update name=X color=rojo)" '400' "color inválido: 400"
check "$(code /api/accounts/1/update name= color=#112233)" '400' "nombre vacío: 400"
check "$(code /api/accounts/77/update name=X color=#112233)" '404' "cuenta inexistente: 404"
curl -s -m 20 localhost:$WEB/api/send -d account=1 -d to=firma@z.com -d subject=Firma -d body=Hola >/dev/null
LASTBODY=$(python3 - "$T/smtp.log" <<'PY'
import sys, base64, re
msg = open(sys.argv[1]).read().split("=====")[-2]            # el último mensaje aceptado
b64 = msg.split("\n\n", 2)[-1] if "base64" in msg else ""    # cuerpo tras las cabeceras
print(base64.b64decode("".join(b64.split())).decode(errors="replace"))
PY
)
check "$LASTBODY" 'Un saludo, Yo' "la firma se añade a lo que se envía"
# ── mover / archivar / borrar ──────────────────────────────────────────────────
MID=$(first_id inbox)
check "$(code /api/message/$MID/move to=bogus)" '400' "mover a un rol inválido: 400"
check "$(code /api/message/99999/move to=trash)" '404' "mover un mensaje inexistente: 404"
check "$(code /api/message/$MID/move to=archive)" '204' "archivar"
check "$(cat "$T/imap.log")" 'UID MOVE' "archivar envía UID MOVE al servidor"
if [ -z "$(first_id inbox)" ]; then echo "ok   archivado: sale de la Entrada al instante"; else echo "FAIL el mensaje sigue en la Entrada"; fail=1; fi
curl -s -m 60 -XPOST localhost:$WEB/api/sync >/dev/null
AID=$(first_id archive); if [ -n "$AID" ]; then echo "ok   archivado: aparece en Archivo tras sincronizar"; else echo "FAIL no aparece en Archivo"; fail=1; fi
check "$(code /api/message/$AID/unseen)" '204' "marcar como no leído"
check "$(curl -s -m 5 "localhost:$WEB/api/messages?role=archive&account=1")" '"seen":0' "no leído guardado en local"
check "$(code /api/message/$AID/move to=trash)" '204' "a la papelera"
curl -s -m 60 -XPOST localhost:$WEB/api/sync >/dev/null
TID=$(first_id trash); if [ -n "$TID" ]; then echo "ok   la papelera lo recibe"; else echo "FAIL la papelera no lo recibe"; fail=1; fi
check "$(code /api/message/$TID/move to=delete)" '204' "borrado definitivo"
check "$(cat "$T/imap.log")" 'UID EXPUNGE' "borrado definitivo expulsa en el servidor"
curl -s -m 60 -XPOST localhost:$WEB/api/sync >/dev/null
if [ -z "$(first_id trash)" ]; then echo "ok   papelera vacía tras el borrado definitivo"; else echo "FAIL el mensaje reaparece"; fail=1; fi
# ── conversaciones ──────────────────────────────────────────────────────────────
add() { local raw; raw=$(printf "$2" | base64 -w0); exec 3<>/dev/tcp/127.0.0.1/$IMAP; printf 'x X-TEST ADD %s %s\r\n' "$1" "$raw" >&3; sleep 0.15; exec 3>&-; }
mk() { printf 'From: p@x.com\r\nMessage-ID: %s\r\nSubject: %s\r\nDate: %s\r\n%s\r\ntexto\r\n' "$1" "$2" "$3" "$4"; }
add 30 "$(mk '<t1@x>' 'Plan' 'Mon, 05 Oct 2026 09:00:00 +0000' '')"
add 31 "$(mk '<t2@x>' 'Re: Plan' 'Mon, 05 Oct 2026 10:00:00 +0000' 'In-Reply-To: <t1@x>\r\n')"
add 32 "$(mk '<t3@x>' 'Re: Re: Plan' 'Mon, 05 Oct 2026 11:00:00 +0000' 'References: <t1@x> <t2@x>\r\n')"
add 33 "$(mk '<t4@x>' 'RE: Plan' 'Mon, 05 Oct 2026 12:00:00 +0000' '')"
add 34 "$(mk '<u1@x>' 'Plan' 'Tue, 06 Oct 2026 12:00:00 +0000' '')"
add 36 "$(mk '<c1@x>' 'Re: Otra cosa' 'Mon, 05 Oct 2026 13:00:00 +0000' 'In-Reply-To: <p1@x>\r\n')"
curl -s -m 60 -XPOST localhost:$WEB/api/sync >/dev/null
add 37 "$(mk '<p1@x>' 'Otra cosa' 'Mon, 05 Oct 2026 08:00:00 +0000' '')"      # el padre llega después que su hijo
curl -s -m 60 -XPOST localhost:$WEB/api/sync >/dev/null
L=$(curl -s -m 5 "localhost:$WEB/api/messages?role=inbox&account=1")
TH=$(python3 -c "import sys,json; r=json.load(sys.stdin); print(sorted((x['subject'], x['thread_count']) for x in r if 'Plan' in x['subject'] or 'Otra' in x['subject']))" <<<"$L")
check "$TH" "('RE: Plan', 4)" "respuestas por In-Reply-To, References y asunto en una sola conversación (4 mensajes)"
check "$TH" "('Plan', 1)" "un mensaje con el mismo asunto pero sin Re: ni cabeceras no se une"
check "$TH" "('Re: Otra cosa', 2)" "el hijo que llegó antes que su padre acaba en la misma conversación"
if [ "$(python3 -c "import sys,json; print(len([x for x in json.load(sys.stdin) if 'Otra' in x['subject']]))" <<<"$L")" = 1 ]; then echo "ok   la lista muestra una sola fila por conversación"; else echo "FAIL la conversación sale en varias filas"; fail=1; fi
PID=$(python3 -c "import sys,json; print([x['id'] for x in json.load(sys.stdin) if x['subject']=='RE: Plan'][0])" <<<"$L")
check "$(curl -s -m 5 localhost:$WEB/api/thread/$PID | python3 -c "import sys,json; print([x['subject'] for x in json.load(sys.stdin) if x['role'] == 'inbox'])")" "['Plan', 'Re: Plan', 'Re: Re: Plan', 'RE: Plan']" "la conversación completa, del más antiguo al más reciente"
check "$(curl -s -m 5 "localhost:$WEB/api/messages?role=inbox&account=1" | python3 -c "import sys,json; print([x['thread_unseen'] for x in json.load(sys.stdin) if x['subject']=='RE: Plan'])")" '[4]' "la conversación tiene 4 sin leer"
curl -s -m 20 -XPOST localhost:$WEB/api/message/$PID/seen >/dev/null
check "$(curl -s -m 5 "localhost:$WEB/api/messages?role=inbox&account=1" | python3 -c "import sys,json; print([x['thread_unseen'] for x in json.load(sys.stdin) if x['subject']=='RE: Plan'])")" '[0]' "abrir la conversación la deja leída entera"
# archivar una conversación entera (scope=thread): sus 4 mensajes de la Entrada, no solo el último
check "$(curl -s -o /dev/null -w %{http_code} -XPOST localhost:$WEB/api/message/$PID/move -d to=archive -d scope=thread)" '204' "archivar la conversación entera"
curl -s -m 60 -XPOST localhost:$WEB/api/sync >/dev/null
if [ "$(curl -s -m 5 "localhost:$WEB/api/messages?role=inbox&account=1" | python3 -c "import sys,json; print(any(x['subject']=='RE: Plan' for x in json.load(sys.stdin)))")" = "False" ]; then echo "ok   la conversación archivada ya no está en la Entrada"; else echo "FAIL la conversación sigue en la Entrada"; fail=1; fi
check "$(curl -s -m 5 "localhost:$WEB/api/messages?role=archive&account=1" | python3 -c "import sys,json; print([(x['subject'],x['thread_count']) for x in json.load(sys.stdin) if x['subject']=='RE: Plan'])")" "('RE: Plan', 4)" "en Archivo aparece como una conversación de 4"
# ── spam y mover a una carpeta cualquiera ──────────────────────────────────────────
add 40 "$(mk '<s1@x>' 'Oferta increible' 'Wed, 07 Oct 2026 08:00:00 +0000' '')"
add 41 "$(mk '<c9@x>' 'Pedido cliente' 'Wed, 07 Oct 2026 09:00:00 +0000' '')"
curl -s -m 60 -XPOST localhost:$WEB/api/sync >/dev/null
find_id() { curl -s -m 5 "localhost:$WEB/api/messages?role=inbox&account=1" | python3 -c "import sys,json; print([x['id'] for x in json.load(sys.stdin) if x['subject']=='$1'][0])"; }
check "$(code /api/message/$(find_id 'Oferta increible')/move to=junk)" '204' "marcar como spam"
check "$(cat "$T/imap.log")" 'UID MOVE 40 "Junk"' "spam: UID MOVE a la carpeta Junk"
FLD=$(curl -s -m 5 localhost:$WEB/api/folders)
check "$FLD" '"path":"Clientes","role":null' "las carpetas propias del servidor se sincronizan (sin rol)"
CID=$(python3 -c "import sys,json; print([f['id'] for f in json.load(sys.stdin) if f['path']=='Clientes' and f['account_id']==1][0])" <<<"$FLD")
IID=$(python3 -c "import sys,json; print([f['id'] for f in json.load(sys.stdin) if f['path']=='INBOX' and f['account_id']==1][0])" <<<"$FLD")
PC=$(find_id 'Pedido cliente')
check "$(code /api/message/$PC/move to=folder folder_id=99999)" '400' "mover a una carpeta que no existe: 400"
check "$(code /api/message/$PC/move to=folder folder_id=$IID)" '400' "mover a la misma carpeta: 400"
check "$(code /api/message/$PC/move to=folder folder_id=$CID)" '204' "mover a una carpeta cualquiera"
check "$(cat "$T/imap.log")" 'UID MOVE 41 "Clientes"' "mover: UID MOVE a la carpeta elegida"
curl -s -m 60 -XPOST localhost:$WEB/api/sync >/dev/null
check "$(curl -s -m 5 "localhost:$WEB/api/messages?folder=$CID&account=1")" '"subject":"Pedido cliente"' "la carpeta propia se puede listar por id"
check "$(curl -s -m 5 "localhost:$WEB/api/messages?role=junk&account=1")" '"subject":"Oferta increible"' "el spam aparece en Spam"
# ── acciones en lote ───────────────────────────────────────────────────────────────
add 50 "$(mk '<l1@x>' 'Lote A' 'Wed, 07 Oct 2026 10:00:00 +0000' '')"
add 51 "$(mk '<l2@x>' 'Lote B' 'Wed, 07 Oct 2026 10:05:00 +0000' '')"
add 52 "$(mk '<l3@x>' 'Lote C' 'Wed, 07 Oct 2026 10:10:00 +0000' '')"
curl -s -m 60 -XPOST localhost:$WEB/api/sync >/dev/null
IA=$(find_id 'Lote A'); IB=$(find_id 'Lote B'); IC=$(find_id 'Lote C')
check "$(curl -s -o /dev/null -w %{http_code} -XPOST localhost:$WEB/api/messages/move -d to=archive)" '400' "lote sin ids: 400"
R=$(curl -s -m 60 -XPOST localhost:$WEB/api/messages/move -d to=archive --data-urlencode "ids=$IA
$IB
99999")
check "$R" '"moved":2,"failed":1,"error":"404"' "mover en lote: 2 movidos y el inexistente no detiene al resto"
curl -s -m 60 -XPOST localhost:$WEB/api/sync >/dev/null
AR=$(curl -s -m 5 "localhost:$WEB/api/messages?role=archive&account=1")
check "$AR" '"subject":"Lote A"' "en lote: A llegó a Archivo"
check "$AR" '"subject":"Lote B"' "en lote: B llegó a Archivo"
unseen_of() { curl -s -m 5 "localhost:$WEB/api/messages?role=inbox&account=1" | python3 -c "import sys,json; print([x['thread_unseen'] for x in json.load(sys.stdin) if x['subject']=='$1'])"; }
check "$(unseen_of 'Lote C')" '[1]' "Lote C empieza sin leer"
curl -s -m 20 -XPOST localhost:$WEB/api/messages/seen -d seen=1 --data-urlencode "ids=$IC" >/dev/null
check "$(unseen_of 'Lote C')" '[0]' "leído en lote"
curl -s -m 20 -XPOST localhost:$WEB/api/messages/seen -d seen=0 --data-urlencode "ids=$IC" >/dev/null
check "$(unseen_of 'Lote C')" '[1]' "no leído en lote"
# ── mensajes enriquecidos (HTML) ──────────────────────────────────────────────────────
curl -s -m 20 localhost:$WEB/api/send -d account=1 -d to=ana@z.com -d subject=Rico -d "body=negrita y firma" --data-urlencode "html=<b>negrita</b> <a href=\"https://x.es\">enlace</a>" >/dev/null
python3 - "$T/smtp.log" <<'PY' && echo "ok   mensaje enriquecido: multipart/alternative con texto y HTML (y firma en ambos)" || { echo "FAIL mensaje enriquecido"; fail=1; }
import sys, email
raw = open(sys.argv[1]).read().split("=====")[-2]
msg = email.message_from_string(raw[raw.index("Date:"):])
assert msg.get_content_type() == "multipart/alternative", msg.get_content_type()
parts = {p.get_content_type(): p.get_payload(decode=True).decode() for p in msg.get_payload()}
assert "negrita y firma" in parts["text/plain"], parts
assert "<b>negrita</b>" in parts["text/html"] and "https://x.es" in parts["text/html"], parts
assert "Un saludo, Yo" in parts["text/plain"] and "Un saludo, Yo" in parts["text/html"], parts   # firma de la cuenta 1
PY
curl -s -m 20 localhost:$WEB/api/draft -d account=1 -d subject="Borrador rico" -d "body=hola" --data-urlencode "html=<i>hola</i>" >/dev/null
check "$(cat "$T/imap.log")" 'Content-Type: multipart/alternative' "el borrador enriquecido guarda texto y HTML"
# ── carpetas: crear, renombrar, borrar ──────────────────────────────────────────────
folders() { curl -s -m 5 localhost:$WEB/api/folders; }
fid() { python3 -c "import sys,json; r=[f['id'] for f in json.load(sys.stdin) if f['path']=='$1' and f['account_id']==1]; print(r[0] if r else '')" <<<"$(folders)"; }
check "$(code /api/folders account=1 "name=Proyectos 2026")" '204' "crear una carpeta"
check "$(cat "$T/imap.log")" 'CREATE "Proyectos 2026"' "crear: CREATE en el servidor"
check "$(folders)" '"path":"Proyectos 2026","role":null' "la carpeta nueva aparece sin rol"
check "$(code /api/folders account=1 "name=Proyectos 2026")" '409' "crear una carpeta que ya existe: 409"
check "$(code /api/folders account=1 "name=a/b")" '400' "nombre con barra: 400"
check "$(code /api/folders account=1 "name=   ")" '400' "nombre vacío: 400"
check "$(code /api/folders account=1 "name=Año")" '204' "crear una carpeta con tilde"
check "$(cat "$T/imap.log")" 'CREATE "A&APE-o"' "tilde: viaja en UTF-7 modificado"
curl -s -m 60 -XPOST localhost:$WEB/api/sync >/dev/null
if [ "$(python3 -c "import sys,json; print(len([f for f in json.load(sys.stdin) if f['path']=='Año' and f['account_id']==1]))" <<<"$(folders)")" = 1 ]; then echo "ok   tras sincronizar la carpeta con tilde sigue una sola vez"; else echo "FAIL carpeta con tilde duplicada o perdida"; fail=1; fi
PF=$(fid "Proyectos 2026")
check "$(code /api/folders/$PF/rename "name=Proyectos 2027")" '204' "renombrar"
check "$(cat "$T/imap.log")" 'RENAME "Proyectos 2026" "Proyectos 2027"' "renombrar: RENAME en el servidor"
check "$(folders)" '"path":"Proyectos 2027"' "el nombre nuevo se refleja"
check "$(code /api/folders/$PF/rename "name=Clientes")" '409' "renombrar a un nombre que ya existe: 409"
check "$(code /api/folders/$(fid INBOX)/rename "name=Otra")" '400' "una carpeta con rol no se renombra: 400"
check "$(code /api/folders/$(fid INBOX)/delete)" '400' "una carpeta con rol no se borra: 400"
check "$(code /api/folders/$PF/delete)" '204' "borrar una carpeta propia"
check "$(cat "$T/imap.log")" 'DELETE "Proyectos 2027"' "borrar: DELETE en el servidor"
if [ -z "$(fid 'Proyectos 2027')" ]; then echo "ok   la carpeta borrada desaparece"; else echo "FAIL la carpeta sigue"; fail=1; fi
# otro cliente borra "Clientes": tras sincronizar desaparece de aquí con sus mensajes
exec 3<>/dev/tcp/127.0.0.1/$IMAP; printf 'x X-TEST DELFOLDER Clientes\r\n' >&3; sleep 0.2; exec 3>&-
curl -s -m 60 -XPOST localhost:$WEB/api/sync >/dev/null
if [ -z "$(fid Clientes)" ]; then echo "ok   una carpeta borrada por otro cliente se retira al sincronizar"; else echo "FAIL la carpeta borrada en el servidor sigue aquí"; fail=1; fi
check "$(curl -s -m 5 "localhost:$WEB/api/messages?role=inbox&account=1")" '[' "el buzón local sigue funcionando tras la limpieza"
# ── imágenes dentro del mensaje (cid) ──────────────────────────────────────────────────
python3 -c "import base64,sys; sys.stdout.buffer.write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='))" > "$T/logo.png"
IMG=$(sed -E 's/.*"id":"([0-9a-f]+)".*/\1/' <<<"$(curl -s -m 20 localhost:$WEB/api/upload -F "file=@$T/logo.png")")
check "$(curl -s -o /dev/null -w '%{http_code} %{content_type}' localhost:$WEB/outbox/$IMG/logo.png)" '200 image/png' "la subida se puede mostrar en el editor (/outbox/id/nombre)"
TXT=$(sed -E 's/.*"id":"([0-9a-f]+)".*/\1/' <<<"$(curl -s -m 20 localhost:$WEB/api/upload -F "file=@$T/nota.txt")")
check "$(curl -s -o /dev/null -w %{http_code} localhost:$WEB/api/send -d account=1 -d to=ana@z.com -d subject=x -d body=x --data-urlencode "html=<img src=\"cid:$TXT\">" -d "inline=$TXT")" '400' "imagen en línea que no es imagen: 400"
curl -s -m 20 localhost:$WEB/api/send -d account=1 -d to=ana@z.com -d subject="Con logo" -d body="texto" --data-urlencode "html=<p>Hola</p><img src=\"cid:$IMG\">" -d "inline=$IMG" >/dev/null
python3 - "$T/smtp.log" "$IMG" <<'PY' && echo "ok   imagen en línea: multipart/alternative con multipart/related (HTML + imagen con Content-ID)" || { echo "FAIL imagen en línea"; fail=1; }
import sys, email
raw = open(sys.argv[1]).read().split("=====")[-2]
msg = email.message_from_string(raw[raw.index("Date:"):])
assert msg.get_content_type() == "multipart/alternative", msg.get_content_type()
text, related = msg.get_payload()
assert related.get_content_type() == "multipart/related", related.get_content_type()
html, img = related.get_payload()
assert html.get_content_type() == "text/html" and ("cid:" + sys.argv[2]) in html.get_payload(decode=True).decode()
assert img.get_content_type() == "image/png" and img["Content-ID"] == "<" + sys.argv[2] + ">", dict(img.items())
assert img["Content-Disposition"].startswith("inline"), img["Content-Disposition"]
PY
if [ -d "$T/app/data/outbox/$IMG" ]; then echo "FAIL la imagen subida no se limpia tras enviar"; fail=1; else echo "ok   la subida se borra tras enviar"; fi
# ── probar una cuenta antes de guardarla ────────────────────────────────────────────────
TEST=$(curl -s -m 30 localhost:$WEB/api/accounts/test -d email=yo@x.com -d password=pw -d imap_host=127.0.0.1 -d imap_port=$IMAP -d imap_tls=none -d smtp_host=127.0.0.1 -d smtp_port=$SMTP -d smtp_tls=none)
python3 - "$TEST" <<'PY' && echo "ok   probar cuenta: IMAP y SMTP correctos" || { echo "FAIL probar cuenta correcta"; fail=1; }
import sys, json
r = json.loads(sys.argv[1]); assert r["imap"]["ok"] and r["smtp"]["ok"], r
assert "carpetas" in r["imap"]["message"], r
PY
BAD=$(curl -s -m 30 localhost:$WEB/api/accounts/test -d email=yo@x.com -d password=pw -d imap_host=127.0.0.1 -d imap_port=$IMAP -d imap_tls=none -d smtp_host=127.0.0.1 -d smtp_port=1 -d smtp_tls=none)
python3 - "$BAD" <<'PY' && echo "ok   probar cuenta: un SMTP caído se señala sin tumbar el IMAP" || { echo "FAIL probar cuenta con SMTP caído"; fail=1; }
import sys, json
r = json.loads(sys.argv[1]); assert r["imap"]["ok"] and not r["smtp"]["ok"] and r["smtp"]["message"], r
PY
check "$(curl -s -o /dev/null -w %{http_code} localhost:$WEB/api/accounts/test -d email=yo@x.com)" '400' "probar cuenta sin contraseña: 400"
# ── cuando algo falla: nada se da por hecho ──────────────────────────────────────────────
# SMTP caído: el envío falla (500) y no queda copia en Enviados ni contacto nuevo
APP_BEFORE=$(grep -c APPEND "$T/imap.log")
curl -s -m 20 localhost:$WEB/api/accounts -d name=Caido -d email=caido@x.com -d password=pw -d imap_host=127.0.0.1 -d imap_port=$IMAP -d imap_tls=none -d smtp_host=127.0.0.1 -d smtp_port=1 -d smtp_tls=none >/dev/null
BAD_ID=$(curl -s -m 5 localhost:$WEB/api/accounts | python3 -c "import sys,json; print([a['id'] for a in json.load(sys.stdin) if a['name']=='Caido'][0])")
check "$(curl -s -o /dev/null -w %{http_code} localhost:$WEB/api/send -d account=$BAD_ID -d to=nadie@z.com -d subject=Fallo -d body=x)" '500' "enviar con el SMTP caído: 500 (no se da por enviado)"
if [ "$(grep -c APPEND "$T/imap.log")" = "$APP_BEFORE" ]; then echo "ok   un envío fallido no deja copia en Enviados"; else echo "FAIL un envío fallido dejó copia en Enviados"; fail=1; fi
if curl -s "localhost:$WEB/api/contacts?q=nadie" | grep -q nadie@z.com; then echo "FAIL un envío fallido añadió un contacto"; fail=1; else echo "ok   un envío fallido no añade contactos"; fi
# el servidor rechaza un MOVE: el mensaje sigue en la Entrada (no se borra lo local si el servidor no lo hizo)
add 60 "$(mk '<f1@x>' 'No se mueve' 'Wed, 07 Oct 2026 11:00:00 +0000' '')"
curl -s -m 60 -XPOST localhost:$WEB/api/sync >/dev/null
NM=$(find_id 'No se mueve')
exec 3<>/dev/tcp/127.0.0.1/$IMAP; printf 'x X-TEST FAIL MOVE\r\nx X-TEST FAIL COPY\r\n' >&3; sleep 0.3; exec 3>&-
check "$(code /api/message/$NM/move to=archive scope=thread)" '500' "el servidor rechaza el MOVE: la petición falla (500)"
check "$(curl -s -m 5 "localhost:$WEB/api/messages?role=inbox&account=1")" '"subject":"No se mueve"' "...y el mensaje sigue en la Entrada (lo local no se toca)"
exec 3<>/dev/tcp/127.0.0.1/$IMAP; printf 'x X-TEST OK MOVE\r\nx X-TEST OK COPY\r\n' >&3; sleep 0.3; exec 3>&-
check "$(code /api/message/$NM/move to=archive scope=thread)" '204' "con el servidor de nuevo bien, el mismo movimiento funciona"
exit $fail
