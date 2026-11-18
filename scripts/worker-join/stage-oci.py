"""Stage only an independently approved single-platform OCI image from local bytes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile

MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
CONFIG = 'application/vnd.oci.image.config.v1+json'
LAYER = 'application/vnd.oci.image.layer.v1.tar'
JSON_MAX = 2 ** 20
KIT_MAX = 4 * 1024 ** 3


def require(condition, code):
    if not condition:
        raise ValueError(code)


def descriptor(d, types):
    require(isinstance(d, dict) and d.get('mediaType') in types and
            not {'urls', 'data', 'subject', 'artifactType'}.intersection(d) and
            type(d.get('size')) is int and 0 <= d['size'] <= KIT_MAX and
            re.fullmatch('sha256:[a-f0-9]{64}', str(d.get('digest'))), 'invalid_descriptor')
    return d['digest'][7:]


def stage(layout, parent, approved):
    """Parent is an owner-controlled existing directory. Never extract or load a layer."""
    require(re.fullmatch(r'[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?/(?:[a-z0-9]+(?:[._-][a-z0-9]+)*/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[a-f0-9]{64}', approved), 'approved_image_required')
    root = Path(layout); parent = Path(parent)
    require(root.is_absolute() and root.resolve(strict=True) == root and parent.is_absolute() and parent.resolve(strict=True) == parent, 'canonical_directories_required')
    flags = os.O_DIRECTORY | os.O_RDONLY | os.O_NOFOLLOW
    fds = []; kit = None; total = 0
    try:
        def directory(name, parentfd=None):
            fd = os.open(name, flags, dir_fd=parentfd); fds.append(fd); return fd
        base = directory(root); blobs = directory('blobs', base); store = directory('sha256', blobs)
        def read(parentfd, name, limit, target=None, expected=None):
            nonlocal total
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parentfd)
            with os.fdopen(fd, 'rb') as f:
                st = os.fstat(fd)
                require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_size <= limit, 'unsafe_blob')
                sha = hashlib.sha256(); count = 0; buf = bytearray()
                out = target.open('xb') if target else None
                try:
                    while chunk := f.read(1024 * 1024):
                        count += len(chunk); total += len(chunk)
                        require(count <= limit and total <= KIT_MAX, 'kit_limit')
                        sha.update(chunk)
                        if out: out.write(chunk)
                        if not target or limit <= JSON_MAX: buf.extend(chunk)
                finally:
                    if out: out.close()
                require(count == st.st_size and (expected is None or (count == expected['size'] and 'sha256:' + sha.hexdigest() == expected['digest'])), 'blob_mismatch')
                return bytes(buf)
        require(json.loads(read(base, 'oci-layout', JSON_MAX)) == {'imageLayoutVersion':'1.0.0'}, 'unknown_layout')
        idx = json.loads(read(base, 'index.json', JSON_MAX)); digest = approved.split('@')[1]
        require(idx.get('schemaVersion') == 2 and isinstance(idx.get('manifests'), list), 'invalid_index')
        matches = [d for d in idx['manifests'] if isinstance(d, dict) and d.get('digest') == digest]
        require(len(matches) == 1, 'approved_manifest_missing')
        name = descriptor(matches[0], {MANIFEST})
        kit = Path(tempfile.mkdtemp(prefix='orbit-oci-', dir=parent)); target = kit / 'blobs' / 'sha256'; target.mkdir(parents=True)
        manifest = json.loads(read(store, name, JSON_MAX, target/name, matches[0]))
        require(manifest.get('schemaVersion') == 2 and manifest.get('mediaType', MANIFEST) == MANIFEST and 'subject' not in manifest and 'artifactType' not in manifest, 'invalid_manifest')
        conf = manifest.get('config'); cname = descriptor(conf, {CONFIG}); config = json.loads(read(store,cname,JSON_MAX,target/cname,conf))
        layers = manifest.get('layers'); require(isinstance(layers,list) and len(layers) <= 128, 'invalid_layers')
        diffids = config.get('rootfs',{}).get('diff_ids'); require(config.get('os') and config.get('architecture') and config.get('rootfs',{}).get('type') == 'layers' and isinstance(diffids,list) and len(layers)==len(diffids) and all(re.fullmatch(r'sha256:[a-f0-9]{64}',s) for s in diffids), 'invalid_config')
        for layer in layers:
            lname = descriptor(layer,{LAYER,LAYER+'+gzip',LAYER+'+zstd'})
            if not (target/lname).exists(): read(store,lname,layer['size'],target/lname,layer)
            else: require((target/lname).stat().st_size == layer['size'],'blob_mismatch')
        (kit/'oci-layout').write_text('{"imageLayoutVersion":"1.0.0"}\n')
        (kit/'index.json').write_text(json.dumps({'schemaVersion':2,'manifests':[{k:matches[0][k] for k in ('digest','size','mediaType')}]})+'\n')
        return {'kit':str(kit),'approvedImage':approved,'verifiedLayers':len(layers),'loaded':False,'started':False}
    except BaseException:
        if kit: shutil.rmtree(kit)
        raise
    finally:
        for fd in reversed(fds): os.close(fd)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    for key in ('layout','stage-parent','approved-image'): p.add_argument('--'+key,required=True)
    args = p.parse_args()
    try: print(json.dumps(stage(args.layout,args.stage_parent,args.approved_image)))
    except (ValueError,OSError,KeyError,TypeError,AttributeError): sys.exit('OCI kit refused; verify the local layout, independently approved digest and stage parent.')
