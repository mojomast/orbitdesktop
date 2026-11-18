"""Private helper for the local rehearsal. The worker cannot launch this program."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import subprocess
import sys
import time
import tarfile
import tempfile


def check(value, reason):
    if not value: raise ValueError(reason)


def git(repo, *args):
    return subprocess.check_output(['git','-c','user.name=Fixture','-c','user.email=fixture@localhost',*args],cwd=repo,stderr=subprocess.DEVNULL,text=True).strip()


def data_suite(workdir, argv):
    """TestRunner for ONE data format, not a general command or test interpreter.

    Reads two small regular files. The fixture test is a declarative pair of
    integers committed BEFORE the lease. No child process, import or eval.
    """
    check(list(argv) in (['sum-data-v1'],['sum-data-v1','case.json']), 'unknown_test')
    def data(name):
        fd=os.open(Path(workdir)/name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        with os.fdopen(fd,'rb') as f:
            check(stat.S_ISREG(os.fstat(fd).st_mode),'invalid_file'); raw=f.read(65);check(len(raw)<=64,'data_limit');return raw
    case=json.loads(data('case.json')); actual=data('total.txt')
    check(isinstance(case,list) and len(case)==2 and all(type(n) is int and 0<=n<=1000 for n in case),'invalid_case')
    ok=actual==f'{sum(case)}\n'.encode()
    return {'exit_code':0 if ok else 1,'timed_out':False,'output_tail':'sum comparison passed' if ok else 'sum comparison failed'}


def main():
    action, wid, aid = sys.argv[1:]; cfg=json.load(sys.stdin)
    check(action in ('offer','verify') and re.fullmatch('[0-9a-f]{32}',wid) and re.fullmatch('att_[0-9a-f]{16}',aid),'invalid_request')
    root=Path.cwd(); check(root==Path(os.environ['HOME']) and root.name.startswith('orbit-brief-') and root.stat().st_mode & 0o077==0,'private_fixture_required')
    # Import only tracked regular files from the exact operator-selected tree,
    # never a mutable checkout's untracked Python modules or user site hooks.
    check(re.fullmatch('[a-f0-9]{40}',cfg['bundlebeesRef']) and Path(cfg['bundlebees']).is_absolute(),'approved_checkout_required')
    code=root/'approved-source'; code.mkdir(exist_ok=True)
    if not (code/'bundlebees_plugin').is_dir():
        with tempfile.TemporaryFile() as archive:
            subprocess.run(['git','-C',cfg['bundlebees'],'archive',cfg['bundlebeesRef'],'bundlebees_plugin'],stdout=archive,check=True,timeout=20);archive.seek(0)
            with tarfile.open(fileobj=archive,mode='r:') as tar:
                for member in tar:
                    p=Path(member.name);check(not p.is_absolute() and '..' not in p.parts and p.parts[0]=='bundlebees_plugin' and (member.isfile() or member.isdir()),'unsafe_source')
                    tar.extract(member,code,filter='data')
    sys.path.insert(0,str(code))
    from bundlebees_plugin import leases, queue, verify_local, integrate_job
    db=sqlite3.connect(f'file:{root}/worker-join/registry.sqlite?mode=rw',uri=True)
    db.row_factory=sqlite3.Row
    def active():
        w=db.execute('SELECT * FROM workers WHERE workerId=?',(wid,)).fetchone()
        return w and w['revokedAt'] is None and w['pairedAt'] and w['tokenUntil']>time.time()*1000 and 'sum-brief' in json.loads(w['scopes'])
    check(active(),'worker_unavailable')
    base=root/aid; state=base/'state'; repo=base/'repo'
    if action=='offer':
        base.mkdir(mode=0o700); repo.mkdir(); git(repo,'init','-q','-b','main')
        case=[secrets.randbelow(999)+1,secrets.randbelow(999)+1]
        (repo/'case.json').write_text(json.dumps(case)+'\n');(repo/'total.txt').write_text('0\n')
        git(repo,'add','case.json','total.txt');git(repo,'commit','-qm','Approved synthetic sum case');rev=git(repo,'rev-parse','HEAD')
        board=queue.JsonQueue(base/'board.json');(base/'board.json').write_text(json.dumps({aid:{'repo':'fixture/sum','job_id':aid,'title':'Sum two approved line items','status':'queued'}}))
        item=queue.eligible(board.list_items(),set());check(item and item.feature_id==aid,'not_eligible');queue.QueueStore(state).claim(item.feature_id,job_id=item.job_id)
        leases.record_lease(state,aid,{'objective':'Sum case.json into total.txt','assigned_files':['total.txt'],'source_rev':rev,'acceptance':{'criteria':['sum equals total'],'tests':['case.json']}})
        board.set_status(aid,'running');db.execute('BEGIN IMMEDIATE');check(active(),'worker_unavailable')
        db.execute("INSERT INTO sum_briefs(attemptId,workerId,sourceRev,a,b,state) VALUES(?,?,?,?,?,'queued')",(aid,wid,rev,*case));db.commit();return {'state':'queued','sourceRev':rev}

    # Scanner authority comes from an independently supplied binary hash. The
    # checked-in BundleBees CI tarball pin is one way to establish this hash.
    scanner=Path(cfg['scanner']);check(scanner.is_absolute() and scanner.resolve()==scanner and re.fullmatch('[0-9a-f]{64}',cfg['scannerSha256']),'scanner_not_approved')
    fd=os.open(scanner,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    pinned=base/'gitleaks'; h=hashlib.sha256()
    with os.fdopen(fd,'rb') as src,pinned.open('xb') as dst:
        s=os.fstat(src.fileno());check(stat.S_ISREG(s.st_mode) and not s.st_mode&0o022 and 0<s.st_size<=128*1024*1024,'unsafe_scanner');n=0
        while block:=src.read(1024**2):
            n+=len(block);check(n<=s.st_size,'scanner_changed');h.update(block);dst.write(block)
    check(h.hexdigest()==cfg['scannerSha256'],'scanner_digest_mismatch');pinned.chmod(0o500)
    q=queue.QueueStore(state);claim=q.read(aid);check(claim and claim['state']=='claimed' and claim['job_id']==aid,'missing_queue_claim')
    row=db.execute("SELECT * FROM sum_briefs WHERE workerId=? AND attemptId=? AND state='reported'",(wid,aid)).fetchone();check(row,'report_unavailable')
    rev=row['sourceRev']; total=row['total'];check(type(total) is int and 0<=total<=2000,'invalid_report')
    # Only an integer enters the fixed data patch. The worker supplies neither
    # a test, a path, a lease, nor a command. Run real BB RED/GREEN + scanner.
    patch=f'diff --git a/total.txt b/total.txt\n--- a/total.txt\n+++ b/total.txt\n@@ -1 +1 @@\n-0\n+{total}\n'
    opts=dict(suite_command=['sum-data-v1'],runner=data_suite,cacheable=False)
    record=verify_local.verify_and_commit(state,repo,aid,patch=patch,declared_files=['total.txt'],base_rev=rev,tests=['case.json'],gitleaks=str(pinned),require_gitleaks=True,**opts)
    check(record['ok'] and record['red']['exit_code']==1 and record['suite']['exit_code']==0 and record['gitleaks']['exit_code']==0,'verification_failed')
    check(active(),'worker_unavailable')
    wave=integrate_job.integrate(state,{'job_id':aid,'goal':{'base_rev':rev},'tasks':[{'attempts':[aid],'state':'verified'}]},repo,**opts)
    check(wave['ok'] and wave['record']['accepted'],'wave_not_accepted');head=wave['record']['head_sha']
    # BB builds its candidate wave in a throwaway directory. The only visible
    # acceptance is a CAS against the original, still-authorized report. Never
    # hold Orbit's revocation lock while scanning or running the combined suite.
    db.execute('BEGIN IMMEDIATE');check(active(),'worker_unavailable')
    cur=db.execute("UPDATE sum_briefs SET state='accepted',waveCommit=? WHERE attemptId=? AND workerId=? AND sourceRev=? AND state='reported' AND total=?",(head,aid,wid,rev,total));check(cur.rowcount==1,'report_changed');db.commit()
    q.write(aid,dict(claim,state='ready_for_review',wave=head));queue.JsonQueue(base/'board.json').set_status(aid,'ready_for_review',{'wave':head})
    return {'state':'accepted','waveCommit':head,'sourceRev':rev,'verifiedCommit':record['sha'],'red':1,'suite':0,'gitleaks':0,'combinedSuite':wave['record']['suite']['exit_code']}


if __name__=='__main__':
    try: print(json.dumps(main()))
    except Exception as exc:
        reason=getattr(exc,'code',None) or (str(exc) if isinstance(exc,ValueError) and re.fullmatch('[a-z_]+',str(exc)) else 'coordinator_failed')
        print(json.dumps({'error':reason}));sys.exit(1)
