import hashlib
import io
import json
from pathlib import Path
import runpy
import tarfile
import tempfile
import unittest

MOD = runpy.run_path(str(Path(__file__).resolve().parents[1]/'scripts/worker-join/stage-oci.py'))


class OciStage(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.layout = Path(tmp.name)/'source'; self.out = Path(tmp.name)/'kits'; self.out.mkdir()
        self.blobs = self.layout/'blobs'/'sha256'; self.blobs.mkdir(parents=True)
        self.layout.joinpath('oci-layout').write_text('{"imageLayoutVersion":"1.0.0"}')
        stream=io.BytesIO()
        with tarfile.open(fileobj=stream,mode='w') as tar:
            data=b'Fixture only\n';entry=tarfile.TarInfo('notice');entry.size=len(data);tar.addfile(entry,io.BytesIO(data))
        self.layer=self.blob(MOD['LAYER'],stream.getvalue())
        self.config=self.blob(MOD['CONFIG'],json.dumps({'os':'linux','architecture':'amd64','rootfs':{'type':'layers','diff_ids':[self.layer['digest']]}}).encode())
        self.index(self.layer)

    def blob(self,typ,data):
        digest=hashlib.sha256(data).hexdigest();(self.blobs/digest).write_bytes(data)
        return {'digest':'sha256:'+digest,'mediaType':typ,'size':len(data)}

    def index(self,layer):
        self.manifest=self.blob(MOD['MANIFEST'],json.dumps({'schemaVersion':2,'config':self.config,'layers':[layer]}).encode());self.approved='fixtures.invalid/worker@'+self.manifest['digest']
        (self.layout/'index.json').write_text(json.dumps({'schemaVersion':2,'manifests':[self.manifest]}))

    def stage(self,ref=None): return MOD['stage'](self.layout,self.out,ref or self.approved)

    def test_closed_kit_verifies_again_offline_without_source_or_unreferenced_files(self):
        (self.blobs/'unreferenced').write_text('untrusted sidecar');report=self.stage();kit=Path(report['kit']);self.assertFalse(report['started']);self.assertFalse(report['loaded']);self.assertEqual(report['verifiedLayers'],1)
        self.assertEqual(len(list((kit/'blobs'/'sha256').iterdir())),3)
        self.layout.rename(self.layout.with_name('unused'));self.layout=kit;self.assertEqual(self.stage()['approvedImage'],self.approved)

    def test_approval_and_complete_descriptor_chain_required(self):
        for ref in ['fixtures.invalid/worker:latest','fixtures.invalid/worker@sha256:'+'0'*64]:
            with self.assertRaises(ValueError): self.stage(ref)
        for desc in [self.config,self.manifest,self.layer]:
            target=self.blobs/desc['digest'][7:];original=target.read_bytes();target.write_bytes(b'!'+original[1:]);
            with self.assertRaises(ValueError): self.stage()
            target.write_bytes(original)
        self.assertEqual(list(self.out.iterdir()),[])

    def test_external_and_linked_blobs_refused(self):
        self.index(dict(self.layer,urls=['https://fixtures.invalid/layer']))
        with self.assertRaises(ValueError): self.stage()
        self.index(self.layer);target=self.blobs/self.layer['digest'][7:];outside=self.out/'outside';target.rename(outside);target.symlink_to(outside)
        with self.assertRaises(OSError): self.stage()
        self.assertEqual(list(self.out.iterdir()),[outside])

if __name__=='__main__': unittest.main()
