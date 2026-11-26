#!/usr/bin/env python3
"""notify-email.py — envia o relatório da rotina diária por SMTP.

Configuração (em ~/.newsletter-crawler/.env, chmod 600):
    NC_SMTP_URL=smtps://fkluser@icloud.com:SENHA_DE_APP@smtp.mail.me.com:465
    NC_MAIL_TO=fkluser@icloud.com          # opcional; este é o default
    NC_MAIL_FROM=fkluser@icloud.com        # opcional; default = usuário do SMTP

Também aceita smtp://host:587 (STARTTLS). A senha nunca é impressa; é lida do
arquivo/ambiente e usada apenas em memória pelo smtplib.

Uso:
    notify-email.py --subject "..." --body-file /caminho/corpo.txt
    notify-email.py --subject "..." --body "texto"
    notify-email.py --dry-run --subject t --body-file f

Saída/exit: 0 enviado; 2 não configurado; 1 erro de envio.
"""
import argparse
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage
from email.utils import formatdate
from urllib.parse import unquote, urlsplit

DEFAULT_ENV = os.path.expanduser('~/.newsletter-crawler/.env')


def load_env(path):
    """Lê KEY=VALUE sem avaliar shell; devolve dict."""
    data = {}
    try:
        with open(path, encoding='utf-8', errors='replace') as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                data[key.strip()] = value.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return data


def get_conf(name, file_env, default=''):
    # NC_HOME/.env vence o ambiente (mesma ordem do config.js)
    if file_env.get(name):
        return file_env[name]
    return os.environ.get(name, default)


def parse_smtp_url(url):
    parts = urlsplit(url)
    if parts.scheme not in ('smtp', 'smtps'):
        raise ValueError('NC_SMTP_URL deve começar por smtp:// ou smtps://')
    host = parts.hostname
    if not host:
        raise ValueError('NC_SMTP_URL sem host')
    port = parts.port or (465 if parts.scheme == 'smtps' else 587)
    user = unquote(parts.username) if parts.username else ''
    password = unquote(parts.password) if parts.password else ''
    return parts.scheme, host, port, user, password


def read_body(args):
    if args.body_file:
        with open(args.body_file, encoding='utf-8', errors='replace') as fh:
            return fh.read()
    if args.body:
        return args.body
    return sys.stdin.read()


def main():
    parser = argparse.ArgumentParser(description='Envia e-mail da rotina via SMTP.')
    parser.add_argument('--subject', required=True)
    parser.add_argument('--body', default='')
    parser.add_argument('--body-file', default='')
    parser.add_argument('--to', default='')
    parser.add_argument('--from', dest='from_addr', default='')
    parser.add_argument('--env-file', default=DEFAULT_ENV)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    env = load_env(args.env_file)
    url = get_conf('NC_SMTP_URL', env)
    if not url:
        print('e-mail não configurado: NC_SMTP_URL ausente em %s' % args.env_file,
              file=sys.stderr)
        return 2

    try:
        scheme, host, port, user, password = parse_smtp_url(url)
    except ValueError as exc:
        print('erro: %s' % exc, file=sys.stderr)
        return 1

    to_addr = args.to or get_conf('NC_MAIL_TO', env, 'fkluser@icloud.com')
    from_addr = args.from_addr or get_conf('NC_MAIL_FROM', env, user or to_addr)
    body = read_body(args)

    msg = EmailMessage()
    msg['Subject'] = args.subject
    msg['From'] = from_addr
    msg['To'] = to_addr
    msg['Date'] = formatdate(localtime=True)
    msg.set_content(body)

    if args.dry_run:
        print('dry-run: %s://%s:%s tls=%s user=%s' % (
            scheme, host, port, 'ssl' if scheme == 'smtps' else 'starttls', user or '(sem usuário)'))
        print('from=%s to=%s subject=%s' % (from_addr, to_addr, args.subject))
        print('--- corpo ---')
        print(body)
        return 0

    try:
        if scheme == 'smtps':
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(host, port, timeout=30, context=context) as smtp:
                if user:
                    smtp.login(user, password)
                smtp.send_message(msg)
        else:
            context = ssl.create_default_context()
            with smtplib.SMTP(host, port, timeout=30) as smtp:
                smtp.ehlo()
                smtp.starttls(context=context)
                smtp.ehlo()
                if user:
                    smtp.login(user, password)
                smtp.send_message(msg)
    except Exception as exc:
        print('erro ao enviar e-mail: %s' % exc, file=sys.stderr)
        return 1

    print('e-mail enviado para %s' % to_addr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
