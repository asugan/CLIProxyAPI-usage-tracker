#!/usr/bin/env python3
"""Build a local Shell extension archive; never install or enable it implicitly."""
from pathlib import Path
import json
import subprocess
import tempfile
import zipfile

root = Path(__file__).resolve().parent
metadata = json.loads((root / 'metadata.json').read_text())
output = root / 'dist' / f"{metadata['uuid']}.shell-extension.zip"
output.parent.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='cliproxy-quota-', dir=output.parent) as temp:
    schemas = Path(temp) / 'schemas'
    schemas.mkdir()
    for source in (root / 'schemas').glob('*.xml'):
        (schemas / source.name).write_bytes(source.read_bytes())
    subprocess.run(['glib-compile-schemas', '--strict', str(schemas)], check=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in ['metadata.json', 'extension.js', 'prefs.js', 'api.js', 'quota.js', 'secrets.js', 'stylesheet.css']:
            archive.write(root / name, name)
        for source in schemas.iterdir():
            archive.write(source, f'schemas/{source.name}')
print(output)
