#!/usr/bin/env python3
"""Fake SMTP server (no TLS, no auth check) for run_mail.sh: appends each accepted message,
with its envelope, to the file argv[2]."""
import socketserver
import sys


class H(socketserver.StreamRequestHandler):
    def send(self, s):
        self.wfile.write(s.encode())

    def handle(self):
        self.send("220 fake smtp\r\n")
        env = []
        while line := self.rfile.readline():
            cmd = line.decode().rstrip("\r\n")
            up = cmd.upper()
            if up.startswith("EHLO") or up.startswith("HELO"):
                self.send("250 fake\r\n")
            elif up.startswith("MAIL FROM") or up.startswith("RCPT TO"):
                env.append(cmd); self.send("250 ok\r\n")
            elif up == "DATA":
                self.send("354 go\r\n")
                data = b""
                while (l := self.rfile.readline()) != b".\r\n":
                    data += l
                with open(sys.argv[2], "a") as f:
                    f.write("\n".join(env) + "\n" + data.decode() + "=====\n")
                env = []
                self.send("250 queued\r\n")
            elif up == "QUIT":
                self.send("221 bye\r\n"); return
            else:
                self.send("250 ok\r\n")


class S(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


S(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
