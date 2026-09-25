import sys,tempfile,json,stat,concurrent.futures
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'extensions/orbit-secrets'))
from vault import Vault
with tempfile.TemporaryDirectory() as d:
    v=Vault(d);v.put('TEST_KEY','test-sensitive-value')
    assert v.get('TEST_KEY')=='test-sensitive-value'
    assert 'test-sensitive-value' not in json.dumps(v.list())
    assert b'test-sensitive-value' not in v.db.read_bytes()
    assert stat.S_IMODE(v.db.stat().st_mode)==0o600
    assert stat.S_IMODE((Path(d)/'master.key').stat().st_mode)==0o600
    assert stat.S_IMODE(Path(d).stat().st_mode)==0o700
    try:v.put('TEST_KEY','overwrite');raise AssertionError()
    except ValueError:pass
    v.put('TEST_KEY','new-value',True);assert Vault(d).get('TEST_KEY')=='new-value'
    for name in ['../escape','a','A;echo','A\n','',None]:
        try:v.put(name,'x');raise AssertionError()
        except ValueError:pass
    with concurrent.futures.ThreadPoolExecutor() as pool:list(pool.map(lambda n:v.put('KEY_'+str(n),'x'),range(20)))
    assert len(v.list())==21
    v.delete('TEST_KEY');assert len(v.list())==20
    try:v.get('TEST_KEY');raise AssertionError()
    except ValueError:pass
print('PASS encrypted storage, permissions, redacted metadata, persistence, explicit replacement, validation, concurrent writes and deletion')
