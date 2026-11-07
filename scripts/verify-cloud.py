#!/usr/bin/env python3
"""Verify a frozen optimization package without touching user task files."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys

def verify(root):
    root = Path(root).resolve()
    release = json.loads((root / 'RELEASE.json').read_text())
    if release.get('schemaVersion') != 1 or not release.get('files'):
        raise ValueError('invalid release manifest')
    for name, digest in release['files'].items():
        p = PurePosixPath(name)
        if not name or p.is_absolute() or '..' in p.parts or '\\' in name or p.as_posix() != name:
            raise ValueError('unsafe manifest path')
        target = root / name
        if any(x.is_symlink() for x in (target, *target.parents) if x != root and root in x.parents):
            raise ValueError('symlink in distribution: ' + name)
        if not target.resolve().is_relative_to(root) or not target.is_file():
            raise ValueError('missing distribution file: ' + name)
        if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            raise ValueError('content hash mismatch: ' + name)
    return {'verified': True, 'version': release['version'], 'files': len(release['files']), 'liveValidated': False}

if __name__ == '__main__':
    try:
        print(json.dumps(verify(Path(__file__).resolve().parents[1]), ensure_ascii=False))
    except (ValueError, OSError, KeyError, TypeError) as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
