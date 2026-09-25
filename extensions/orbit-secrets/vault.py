"""Local owner vault. Never log values. Host account is the trust boundary."""
import os, re, sqlite3, time
from pathlib import Path
from cryptography.fernet import Fernet
DEFAULT = Path('/home/mojo/.hermes-instances/fresh/workspace/orbitdesktop/.runtime/secrets')
class Vault:
    def __init__(self, root=None):
        self.root = Path(root or DEFAULT)
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.root.is_symlink(): raise ValueError('Symlink vault refused')
        self.root.chmod(0o700)
        key = self.root / 'master.key'
        try:
            fd = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError: pass
        else:
            with os.fdopen(fd,'wb') as f: f.write(Fernet.generate_key()); f.flush(); os.fsync(f.fileno())
        if key.is_symlink(): raise ValueError('Symlink key refused')
        key.chmod(0o600)
        self.cipher = Fernet(key.read_bytes())
        self.db = self.root / 'vault.sqlite3'
        if self.db.is_symlink(): raise ValueError('Symlink database refused')
        fd = os.open(self.db, os.O_CREAT | os.O_RDWR, 0o600); os.close(fd)
        self.db.chmod(0o600)
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS secrets(name TEXT PRIMARY KEY, value BLOB NOT NULL, updated INTEGER NOT NULL)')
    def connect(self): return sqlite3.connect(self.db, timeout=10)
    def valid(self, name):
        if not isinstance(name,str) or not re.fullmatch('[A-Z][A-Z0-9_]{0,95}',name): raise ValueError('Use an uppercase environment variable name (maximum 96 characters).')
    def list(self):
        with self.connect() as db:
            return [dict(name=n,updated=t,masked='••••••••') for n,t in db.execute('SELECT name,updated FROM secrets ORDER BY name')]
    def put(self,name,value,replace=False):
        self.valid(name)
        if not isinstance(value,str) or not 1 <= len(value.encode()) <= 16384 or '\x00' in value: raise ValueError('Value must be 1–16384 bytes with no NUL characters.')
        with self.connect() as db:
            if replace:
                cur=db.execute('UPDATE secrets SET value=?,updated=? WHERE name=?',(self.cipher.encrypt(value.encode()),int(time.time()),name))
                if cur.rowcount != 1: raise ValueError('Secret does not exist.')
            else:
                try: db.execute('INSERT INTO secrets VALUES(?,?,?)',(name,self.cipher.encrypt(value.encode()),int(time.time())))
                except sqlite3.IntegrityError: raise ValueError('Secret exists. Use Replace explicitly.') from None
    def get(self,name):
        self.valid(name)
        with self.connect() as db: row=db.execute('SELECT value FROM secrets WHERE name=?',(name,)).fetchone()
        if not row: raise ValueError('Secret does not exist.')
        return self.cipher.decrypt(row[0]).decode()
    def delete(self,name):
        self.valid(name)
        with self.connect() as db:
            if db.execute('DELETE FROM secrets WHERE name=?',(name,)).rowcount != 1: raise ValueError('Secret does not exist.')
