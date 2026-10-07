#!/usr/bin/env python3
"""Comprueba una cuenta de correo ANTES de añadirla a la app: login IMAP, carpetas con su rol, capacidades
que usa la app, y login SMTP. No envía ni modifica nada. Solo biblioteca estándar.

    python3 tools/check_account.py tu@dominio.es --imap imap.dominio.es --smtp smtp.dominio.es
    # opciones: --user (si no es el correo) --imap-port 993 --imap-starttls --smtp-port 587 --smtp-ssl

La contraseña se pide por teclado (no se guarda en ningún sitio ni aparece en el historial).
"""
import argparse
import getpass
import imaplib
import re
import smtplib
import ssl
import sys

ROLES = {"\\Sent": "Enviados", "\\Drafts": "Borradores", "\\Trash": "Papelera", "\\Junk": "Spam", "\\Archive": "Archivo", "\\All": "Todo (archivo)"}


def check_imap(a, user, password):
    print(f"IMAP  {a.imap}:{a.imap_port} ({'STARTTLS' if a.imap_starttls else 'TLS'})")
    try:
        if a.imap_starttls:
            m = imaplib.IMAP4(a.imap, a.imap_port)
            m.starttls(ssl.create_default_context())
        else:
            m = imaplib.IMAP4_SSL(a.imap, a.imap_port, ssl_context=ssl.create_default_context())
    except Exception as e:
        print(f"  ✖ no se pudo conectar: {e}")
        return False
    try:
        m.login(user, password)
    except imaplib.IMAP4.error as e:
        print(f"  ✖ login rechazado: {e}\n    (¿usuario distinto del correo? ¿contraseña de aplicación? prueba --user)")
        return False
    caps = set(c.decode() if isinstance(c, bytes) else c for c in m.capabilities)
    print("  ✔ login correcto")
    wanted = {"UIDPLUS": "borrar y mover con seguridad", "MOVE": "mover en un paso (si no, se copia y borra)", "SPECIAL-USE": "reconocer Enviados/Archivo/Spam por su rol", "IDLE": "(la app sondea cada 3 min; IDLE no se usa)"}
    for cap, why in wanted.items():
        print(f"  {'✔' if cap in caps else '·'} {cap:<12} {why}")
    typ, data = m.list()
    print("  Carpetas:")
    roles_found = set()
    for line in data:
        text = line.decode("utf-8", "replace")
        mt = re.match(r'\((?P<flags>[^)]*)\) "(?P<sep>[^"]*|NIL)" (?P<name>.+)', text)
        if not mt:
            continue
        flags = mt["flags"].split()
        role = next((ROLES[f] for f in flags if f in ROLES), "INBOX" if mt["name"].strip('"').upper() == "INBOX" else "")
        roles_found.add(role)
        print(f"    - {mt['name'].strip(chr(34)):<30} {('[' + role + ']') if role else ''}")
    for need in ("Enviados", "Borradores", "Papelera"):
        if need not in roles_found:
            print(f"  ⚠ el servidor no marca ninguna carpeta como {need}: la app no podrá guardar/leer esa carpeta")
    typ, st = m.status("INBOX", "(MESSAGES UNSEEN)")
    print(f"  INBOX: {st[0].decode()}")
    m.logout()
    return True


def check_smtp(a, user, password):
    print(f"SMTP  {a.smtp}:{a.smtp_port} ({'TLS' if a.smtp_ssl else 'STARTTLS'})")
    try:
        s = smtplib.SMTP_SSL(a.smtp, a.smtp_port, timeout=20) if a.smtp_ssl else smtplib.SMTP(a.smtp, a.smtp_port, timeout=20)
        s.ehlo()
        if not a.smtp_ssl:
            s.starttls(context=ssl.create_default_context())
            s.ehlo()
        s.login(user, password)
        s.noop()
        s.quit()
    except smtplib.SMTPAuthenticationError as e:
        print(f"  ✖ login rechazado: {e}")
        return False
    except Exception as e:
        print(f"  ✖ {e}")
        return False
    print("  ✔ login correcto (no se envió nada)")
    return True


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("email")
    p.add_argument("--user", help="usuario de login si no es el correo")
    p.add_argument("--imap", required=True)
    p.add_argument("--imap-port", type=int, default=993)
    p.add_argument("--imap-starttls", action="store_true", help="IMAP en el puerto 143 con STARTTLS en vez de TLS directo")
    p.add_argument("--smtp")
    p.add_argument("--smtp-port", type=int, default=587)
    p.add_argument("--smtp-ssl", action="store_true", help="SMTP con TLS directo (puerto 465) en vez de STARTTLS")
    a = p.parse_args()
    user = a.user or a.email
    password = getpass.getpass(f"Contraseña de {user}: ")
    ok = check_imap(a, user, password)
    if a.smtp:
        print()
        ok = check_smtp(a, user, password) and ok
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
