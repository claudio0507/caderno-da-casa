#!/usr/bin/env python3
"""
Caderno da Casa · servidor mínimo.
Arquivos estáticos + API JSON + SQLite em um arquivo. Só biblioteca padrão (Python 3.9+).

  python3 server.py                      roda o servidor (padrão 127.0.0.1:8765)
  python3 server.py adduser <id> <nome>  cria usuário e pede a senha (id curto: c, e…)
  python3 server.py passwd <id>          troca a senha
  python3 server.py users                lista usuários
  python3 server.py backup <arquivo.db>  cópia consistente do banco
  python3 server.py snapshots            lista snapshots diários do estado
  python3 server.py restore <AAAA-MM-DD> volta ao snapshot do dia (gera nova revisão)
  python3 server.py export               imprime o estado atual em JSON

Variáveis de ambiente: CADERNO_BIND, CADERNO_PORT, CADERNO_DB,
CADERNO_TRUST_PROXY=1 (atrás de Caddy/nginx), CADERNO_INSECURE_COOKIES=1 (só http em rede local).
"""
import getpass
import gzip
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import sqlite3
import sys
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.environ.get('CADERNO_DB') or os.path.join(ROOT, 'data', 'caderno.db')
BIND = os.environ.get('CADERNO_BIND', '127.0.0.1')
PORT = int(os.environ.get('CADERNO_PORT', '8765'))
TRUST_PROXY = os.environ.get('CADERNO_TRUST_PROXY') == '1'
INSECURE_COOKIES = os.environ.get('CADERNO_INSECURE_COOKIES') == '1'

COOKIE = 'cc_sessao'
SESSION_DAYS = 30
MAX_BODY = 2 * 1024 * 1024
LOGIN_MAX_FAILS = 5
LOGIN_LOCK_SECONDS = 15 * 60
STATIC_FILES = {'/': 'index.html', '/index.html': 'index.html'}
STATIC_PREFIXES = ('/css/', '/js/')
COLLECTIONS = ('lanc', 'rec', 'cats', 'contas', 'pessoas')
STATE_KEYS = ('lanc', 'rec', 'cats', 'contas', 'pessoas', 'cfg', 'seq', 'gerado')
LABELS = {'lanc': 'lançamentos', 'rec': 'recorrências', 'cats': 'categorias', 'contas': 'contas',
          'pessoas': 'pessoas', 'cfg': 'parâmetros', 'gerado': 'meses gerados'}
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
       "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'self'; "
       "form-action 'self'; frame-ancestors 'none'")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, nome TEXT NOT NULL, salt BLOB NOT NULL, hash BLOB NOT NULL, criado TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  criado TEXT NOT NULL, expira TEXT NOT NULL, ultimo TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS state (
  id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL, json TEXT NOT NULL,
  atualizado TEXT NOT NULL, user_id TEXT);
CREATE TABLE IF NOT EXISTS history (
  rev INTEGER PRIMARY KEY, user_id TEXT, quando TEXT NOT NULL, resumo TEXT NOT NULL, diff TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (dia TEXT PRIMARY KEY, rev INTEGER NOT NULL, gz BLOB NOT NULL);
"""


# ───────────────────────── banco ─────────────────────────
def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


@contextmanager
def conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    c.row_factory = sqlite3.Row
    try:
        c.execute('PRAGMA journal_mode=WAL')
        c.execute('PRAGMA foreign_keys=ON')
        yield c
    finally:
        c.close()


def init_db():
    with conn() as c:
        c.executescript(SCHEMA)


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


# ───────────────────────── usuários e sessões ─────────────────────────
def hash_pw(pw, salt):
    return hashlib.scrypt(pw.encode('utf-8'), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)


def check_pw(c, uid, pw):
    r = c.execute('SELECT salt, hash FROM users WHERE id=?', (uid,)).fetchone()
    if not r:
        hash_pw(pw, b'0' * 16)  # mesmo custo quando o usuário não existe
        return False
    return hmac.compare_digest(hash_pw(pw, r['salt']), r['hash'])


def set_pw(c, uid, nome, pw):
    salt = secrets.token_bytes(16)
    c.execute('INSERT INTO users (id, nome, salt, hash, criado) VALUES (?,?,?,?,?) '
              'ON CONFLICT(id) DO UPDATE SET salt=excluded.salt, hash=excluded.hash' +
              (', nome=excluded.nome' if nome else ''),
              (uid, nome or uid, salt, hash_pw(pw, salt), now()))


def token_hash(t):
    return hashlib.sha256(t.encode('utf-8')).hexdigest()


def create_session(c, uid):
    t = secrets.token_urlsafe(32)
    exp = (datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)).isoformat(timespec='seconds')
    c.execute('DELETE FROM sessions WHERE expira < ?', (now(),))
    c.execute('INSERT INTO sessions VALUES (?,?,?,?,?)', (token_hash(t), uid, now(), exp, now()))
    return t


def session_user(c, t):
    if not t:
        return None
    th = token_hash(t)
    r = c.execute('SELECT u.id, u.nome, s.expira, s.ultimo FROM sessions s JOIN users u ON u.id = s.user_id '
                  'WHERE s.token_hash=?', (th,)).fetchone()
    if not r or r['expira'] < now():
        return None
    if r['ultimo'] < (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(timespec='seconds'):
        c.execute('UPDATE sessions SET ultimo=? WHERE token_hash=?', (now(), th))
    return {'id': r['id'], 'nome': r['nome']}


def user_name(c, uid):
    r = c.execute('SELECT nome FROM users WHERE id=?', (uid,)).fetchone() if uid else None
    return r['nome'] if r else None


# ───────────────────────── estado e histórico ─────────────────────────
def valid_state(s):
    if not isinstance(s, dict):
        return False
    if any(not isinstance(s.get(k, []), list) for k in COLLECTIONS + ('gerado',)):
        return False
    return isinstance(s.get('cfg', {}), dict) and isinstance(s.get('seq', {}), dict)


def brief(x):
    return {k: x.get(k) for k in ('desc', 'nome', 'tipo', 'valor', 'data') if k in x}


def diff_states(old, new):
    ch = []
    for col in COLLECTIONS:
        o = {str(x.get('id')): x for x in (old.get(col) or []) if isinstance(x, dict)}
        n = {str(x.get('id')): x for x in (new.get(col) or []) if isinstance(x, dict)}
        for k in sorted(n.keys() - o.keys()):
            ch.append({'col': col, 'id': k, 'op': 'novo', 'item': brief(n[k])})
        for k in sorted(o.keys() - n.keys()):
            ch.append({'col': col, 'id': k, 'op': 'removido', 'item': brief(o[k])})
        for k in sorted(o.keys() & n.keys()):
            if o[k] != n[k]:
                campos = {f: [o[k].get(f), n[k].get(f)] for f in sorted(set(o[k]) | set(n[k]))
                          if o[k].get(f) != n[k].get(f)}
                ch.append({'col': col, 'id': k, 'op': 'alterado', 'item': brief(n[k]), 'campos': campos})
    for key in ('cfg', 'gerado'):
        if old.get(key) != new.get(key):
            ch.append({'col': key, 'op': 'alterado', 'antes': old.get(key), 'depois': new.get(key)})
    return ch


def resumo(ch):
    cnt = {}
    for x in ch:
        cnt.setdefault(x['col'], {'novo': 0, 'alterado': 0, 'removido': 0})[x['op']] += 1
    parts = []
    for col, d in cnt.items():
        s = ' '.join(f'{sym}{d[k]}' for k, sym in (('novo', '+'), ('alterado', '~'), ('removido', '−')) if d[k])
        parts.append(f'{LABELS.get(col, col)} {s}')
    return ' · '.join(parts) or 'sem alterações'


def save_state(c, uid, rev_client, new, nota=None):
    """Grava nova revisão. Retorna (status, rev, json_atual): 'ok' | 'same' | 'conflict'."""
    c.execute('BEGIN IMMEDIATE')
    try:
        cur = c.execute('SELECT rev, json FROM state WHERE id=1').fetchone()
        cur_rev = cur['rev'] if cur else 0
        if rev_client is not None and rev_client != cur_rev:
            c.execute('ROLLBACK')
            return 'conflict', cur_rev, (cur['json'] if cur else None)
        new_json = dumps(new)
        if cur and cur['json'] == new_json:
            c.execute('ROLLBACK')
            return 'same', cur_rev, None
        old = json.loads(cur['json']) if cur else {}
        ch = diff_states(old, new)
        rev, t = cur_rev + 1, now()
        if cur:  # primeiro estado de cada dia guardado comprimido, antes da primeira alteração
            c.execute('INSERT OR IGNORE INTO snapshots VALUES (?,?,?)',
                      (t[:10], cur_rev, gzip.compress(cur['json'].encode('utf-8'))))
        c.execute('INSERT OR REPLACE INTO state (id, rev, json, atualizado, user_id) VALUES (1,?,?,?,?)',
                  (rev, new_json, t, uid))
        c.execute('INSERT INTO history VALUES (?,?,?,?,?)',
                  (rev, uid, t, nota or resumo(ch), json.dumps(ch, ensure_ascii=False)))
        c.execute('COMMIT')
        return 'ok', rev, None
    except Exception:
        c.execute('ROLLBACK')
        raise


# ───────────────────────── HTTP ─────────────────────────
FAILS = {}
FAILS_LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = 'caderno/1.0'
    sys_version = ''
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):  # log próprio em _send
        pass

    def client_ip(self):
        if TRUST_PROXY:
            xff = self.headers.get('X-Forwarded-For')
            if xff:
                return xff.split(',')[0].strip()
        return self.client_address[0]

    # respostas
    def _send(self, status, body=b'', ctype='application/json; charset=utf-8', headers=None):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Robots-Tag', 'noindex, nofollow')
        if ctype.startswith('application/json'):
            self.send_header('Cache-Control', 'no-store')
        for k, v in (headers or []):
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)
        print(f'{now()} {self.client_ip()} {self.command} {self.path} {status}', flush=True)

    def _json(self, status, obj, headers=None):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode('utf-8'), headers=headers)

    def _text(self, status, s):
        self._send(status, s.encode('utf-8'), 'text/plain; charset=utf-8')

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > MAX_BODY:
            self.close_connection = True
            raise ValueError('corpo grande demais')
        raw = self.rfile.read(n) if n else b''
        data = json.loads(raw.decode('utf-8')) if raw else {}
        if not isinstance(data, dict):
            raise ValueError('json invalido')
        return data

    # cookies e origem
    def _cookie_token(self):
        raw = self.headers.get('Cookie')
        if not raw:
            return None
        ck = SimpleCookie()
        try:
            ck.load(raw)
        except Exception:
            return None
        return ck[COOKIE].value if COOKIE in ck else None

    def _cookie_header(self, token, max_age):
        host = (self.headers.get('Host') or '').split(':')[0].lower()
        secure = not INSECURE_COOKIES and host not in ('localhost', '127.0.0.1')
        v = f'{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}'
        return ('Set-Cookie', v + ('; Secure' if secure else ''))

    def _same_origin(self):
        host = (self.headers.get('Host') or '').lower()
        origin = self.headers.get('Origin')
        if origin and urlsplit(origin).netloc.lower() != host:
            return False
        sfs = self.headers.get('Sec-Fetch-Site')
        return not sfs or sfs in ('same-origin', 'none')

    # rotas
    def do_GET(self):
        path = urlsplit(self.path).path
        if path.startswith('/api/'):
            self._api('GET', path)
        else:
            self._static(path)

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        self._api('POST', urlsplit(self.path).path)

    def do_PUT(self):
        self._api('PUT', urlsplit(self.path).path)

    def _static(self, path):
        if path == '/robots.txt':
            return self._text(200, 'User-agent: *\nDisallow: /\n')
        rel = STATIC_FILES.get(path) or (path.lstrip('/') if path.startswith(STATIC_PREFIXES) else None)
        if not rel:
            return self._text(404, 'não encontrado')
        root = os.path.realpath(ROOT)
        full = os.path.realpath(os.path.join(root, rel))
        if not full.startswith(root + os.sep) or not os.path.isfile(full):
            return self._text(404, 'não encontrado')
        ctype = mimetypes.guess_type(full)[0] or 'application/octet-stream'
        if full.endswith('.js'):
            ctype = 'text/javascript'
        if ctype.startswith('text/') or ctype in ('application/json',):
            ctype += '; charset=utf-8'
        with open(full, 'rb') as f:
            data = f.read()
        headers = [('Cache-Control', 'no-cache')]
        if rel == 'index.html':
            headers.append(('Content-Security-Policy', CSP))
        self._send(200, data, ctype, headers)

    def _api(self, method, path):
        try:
            with conn() as c:
                user = session_user(c, self._cookie_token())
                if method == 'GET' and path == '/api/ping':
                    users = [dict(r) for r in c.execute('SELECT id, nome FROM users ORDER BY criado')]
                    return self._json(200, {'ok': True, 'user': user, 'users': users})
                if method in ('POST', 'PUT') and not self._same_origin():
                    return self._json(403, {'erro': 'origem inválida'})
                if method == 'POST' and path == '/api/login':
                    return self._login(c)
                if method == 'POST' and path == '/api/logout':
                    t = self._cookie_token()
                    if t:
                        c.execute('DELETE FROM sessions WHERE token_hash=?', (token_hash(t),))
                    return self._json(200, {'ok': True}, [self._cookie_header('', 0)])
                if not user:
                    return self._json(401, {'erro': 'entre para continuar'})
                if method == 'GET' and path == '/api/state':
                    return self._get_state(c, user)
                if method == 'PUT' and path == '/api/state':
                    return self._put_state(c, user)
                if method == 'GET' and path == '/api/history':
                    return self._history(c)
                if method == 'GET' and path.startswith('/api/history/'):
                    return self._history_one(c, path.rsplit('/', 1)[1])
                return self._json(404, {'erro': 'rota inexistente'})
        except ValueError as e:
            return self._json(400, {'erro': str(e)})
        except Exception as e:  # nunca vaza detalhes ao cliente
            print(f'{now()} erro {e!r}', flush=True)
            return self._json(500, {'erro': 'falha interna'})

    def _login(self, c):
        ip = self.client_ip()
        with FAILS_LOCK:
            f = FAILS.get(ip)
            if f and f['ate'] > time.time():
                return self._json(429, {'erro': 'muitas tentativas; aguarde 15 minutos'})
        b = self._body()
        uid, pw = str(b.get('user') or '')[:40], str(b.get('senha') or '')
        if pw and check_pw(c, uid, pw):
            with FAILS_LOCK:
                FAILS.pop(ip, None)
            t = create_session(c, uid)
            u = c.execute('SELECT id, nome FROM users WHERE id=?', (uid,)).fetchone()
            return self._json(200, {'user': dict(u)}, [self._cookie_header(t, SESSION_DAYS * 86400)])
        with FAILS_LOCK:
            f = FAILS.setdefault(ip, {'n': 0, 'ate': 0})
            f['n'] += 1
            if f['n'] >= LOGIN_MAX_FAILS:
                f['n'], f['ate'] = 0, time.time() + LOGIN_LOCK_SECONDS
        time.sleep(0.5)
        return self._json(401, {'erro': 'usuário ou senha incorretos'})

    def _get_state(self, c, user):
        r = c.execute('SELECT rev, json, atualizado, user_id FROM state WHERE id=1').fetchone()
        if not r:
            return self._json(200, {'rev': 0, 'state': None, 'user': user})
        known = parse_qs(urlsplit(self.path).query).get('rev', [''])[0]
        if known.isdigit() and int(known) == r['rev']:
            return self._json(200, {'rev': r['rev'], 'same': True})
        return self._json(200, {'rev': r['rev'], 'state': json.loads(r['json']), 'atualizado': r['atualizado'],
                                'por': user_name(c, r['user_id']), 'user': user})

    def _put_state(self, c, user):
        b = self._body()
        st, rev = b.get('state'), b.get('rev')
        if not isinstance(rev, int) or isinstance(rev, bool) or not valid_state(st):
            raise ValueError('estado inválido')
        st = {k: st[k] for k in STATE_KEYS if k in st}
        status, cur_rev, cur_json = save_state(c, user['id'], rev, st)
        if status == 'conflict':
            r = c.execute('SELECT atualizado, user_id FROM state WHERE id=1').fetchone()
            return self._json(409, {'rev': cur_rev, 'state': json.loads(cur_json) if cur_json else None,
                                    'por': user_name(c, r['user_id']) if r else None,
                                    'atualizado': r['atualizado'] if r else None})
        return self._json(200, {'rev': cur_rev})

    def _history(self, c):
        q = parse_qs(urlsplit(self.path).query).get('limit', ['30'])[0]
        lim = min(200, max(1, int(q))) if q.isdigit() else 30
        rows = c.execute('SELECT h.rev, h.quando, h.resumo, u.nome FROM history h LEFT JOIN users u ON u.id = h.user_id '
                         'ORDER BY h.rev DESC LIMIT ?', (lim,)).fetchall()
        return self._json(200, [{'rev': r['rev'], 'quando': r['quando'], 'resumo': r['resumo'], 'por': r['nome']}
                                for r in rows])

    def _history_one(self, c, rev):
        r = c.execute('SELECT h.rev, h.quando, h.resumo, h.diff, u.nome FROM history h LEFT JOIN users u ON u.id = h.user_id '
                      'WHERE h.rev=?', (int(rev),)).fetchone() if rev.isdigit() else None
        if not r:
            return self._json(404, {'erro': 'revisão inexistente'})
        return self._json(200, {'rev': r['rev'], 'quando': r['quando'], 'resumo': r['resumo'], 'por': r['nome'],
                                'diff': json.loads(r['diff'])})


def serve():
    httpd = ThreadingHTTPServer((BIND, PORT), Handler)
    httpd.daemon_threads = True
    print(f'Caderno da Casa em http://{BIND}:{PORT} · banco {DB_PATH}', flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


# ───────────────────────── CLI ─────────────────────────
def ask_password():
    if not sys.stdin.isatty():  # uso por script: senha em uma linha (duas, para confirmar)
        p1 = sys.stdin.readline().rstrip('\r\n')
        p2 = sys.stdin.readline().rstrip('\r\n') or p1
    else:
        p1 = getpass.getpass('Senha (mínimo 8 caracteres): ')
        p2 = getpass.getpass('Repita a senha: ')
    if p1 != p2:
        sys.exit('As senhas não conferem.')
    if len(p1) < 8:
        sys.exit('Senha curta demais.')
    return p1


def main(argv):
    init_db()
    cmd = argv[1] if len(argv) > 1 else 'run'
    with conn() as c:
        if cmd == 'run':
            serve()
        elif cmd == 'adduser' and len(argv) >= 4:
            uid, nome = argv[2].strip().lower(), ' '.join(argv[3:]).strip()
            if not uid.isalnum():
                sys.exit('id deve ter só letras e números (ex.: c, e).')
            set_pw(c, uid, nome, ask_password())
            print(f'usuário {uid} ({nome}) pronto')
        elif cmd == 'passwd' and len(argv) == 3:
            uid = argv[2].strip().lower()
            if not c.execute('SELECT 1 FROM users WHERE id=?', (uid,)).fetchone():
                sys.exit('usuário inexistente')
            set_pw(c, uid, None, ask_password())
            c.execute('DELETE FROM sessions WHERE user_id=?', (uid,))
            print('senha trocada; sessões encerradas')
        elif cmd == 'users':
            for r in c.execute('SELECT id, nome, criado FROM users ORDER BY criado'):
                print(f"{r['id']:6} {r['nome']:24} desde {r['criado'][:10]}")
        elif cmd == 'backup' and len(argv) == 3:
            dst = sqlite3.connect(argv[2])
            c.backup(dst)
            dst.close()
            print(f'backup gravado em {argv[2]}')
        elif cmd == 'snapshots':
            for r in c.execute('SELECT dia, rev, length(gz) AS n FROM snapshots ORDER BY dia DESC'):
                print(f"{r['dia']}  rev {r['rev']:6}  {r['n'] / 1024:.1f} KB")
        elif cmd == 'restore' and len(argv) == 3:
            r = c.execute('SELECT gz FROM snapshots WHERE dia=?', (argv[2],)).fetchone()
            if not r:
                sys.exit('snapshot inexistente')
            st = json.loads(gzip.decompress(r['gz']).decode('utf-8'))
            status, rev, _ = save_state(c, None, None, st, nota=f'restaurado do snapshot {argv[2]}')
            print(f'{status} · revisão {rev}')
        elif cmd == 'export':
            r = c.execute('SELECT json FROM state WHERE id=1').fetchone()
            print(r['json'] if r else '{}')
        else:
            sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv)
