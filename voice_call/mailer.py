"""Sending the emails an account needs: confirming an address and resetting a password.

Set SMTP_HOST (and SMTP_PORT, SMTP_USER, SMTP_PASSWORD, MAIL_FROM) in .env to send for real, and PUBLIC_URL to
the address people reach the app at, so the links in the emails point there. For Gmail use smtp.gmail.com, port
587, and an app password.

With no SMTP_HOST nothing can be sent, so the message is written to the server's console instead: enough to try a
password reset on one's own machine, and a clear sign on a real server that mail is not set up.
"""
from __future__ import annotations

import os
import smtplib
import ssl
import threading
from email.message import EmailMessage


def configured() -> bool:
    return bool((os.getenv("SMTP_HOST") or "").strip())


def link(path: str, token: str) -> str:
    base = (os.getenv("PUBLIC_URL") or "http://127.0.0.1:8000").rstrip("/")
    return f"{base}{path}?token={token}"


def _deliver(message: EmailMessage):
    host, port = os.environ["SMTP_HOST"].strip(), int(os.getenv("SMTP_PORT") or 587)
    with smtplib.SMTP(host, port, timeout=20) as server:
        server.starttls(context=ssl.create_default_context())
        user = (os.getenv("SMTP_USER") or "").strip()
        if user:
            server.login(user, os.getenv("SMTP_PASSWORD") or "")
        server.send_message(message)


def send(to: str, subject: str, body: str):
    """In the background, so a slow mail server never holds up the page that asked. Failures are only printed."""
    if not configured():
        print(f"\n  [mail, SMTP is not set up] to {to}: {subject}\n  " + body.replace("\n", "\n  ") + "\n")
        return
    message = EmailMessage()
    message["To"], message["Subject"] = to, subject
    message["From"] = (os.getenv("MAIL_FROM") or os.getenv("SMTP_USER") or "voice-call@localhost").strip()
    message.set_content(body)

    def go():
        try:
            _deliver(message)
        except Exception as exc:
            print(f"  could not send mail to {to}: {type(exc).__name__}")
    threading.Thread(target=go, daemon=True).start()
