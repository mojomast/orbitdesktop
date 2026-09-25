from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZipFile, ZIP_DEFLATED
root = Path(__file__).parent
md = (root / 'README.updated.md').read_text()
paras = []
for line in md.splitlines():
    if not line.strip():
        continue
    if line.startswith('#'):
        level = len(line) - len(line.lstrip('#'))
        paras.append(f'<text:h text:style-name="Heading_20_{min(level,3)}" text:outline-level="{level}">{escape(line.lstrip("# "))}</text:h>')
    else:
        paras.append('<text:p text:style-name="Standard">' + escape(line.strip()) + '</text:p>')
content = '''<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:text>''' + ''.join(paras) + '</office:text></office:body></office:document-content>'
styles = '''<?xml version="1.0" encoding="UTF-8"?><office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.2"><office:styles><style:style style:name="Standard" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.12in"/><style:text-properties fo:font-family="Liberation Sans" fo:font-size="11pt"/></style:style>'''
for level, size in [(1,24),(2,17),(3,13)]:
    styles += f'<style:style style:name="Heading_20_{level}" style:display-name="Heading {level}" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-top="0.18in" fo:keep-with-next="always"/><style:text-properties fo:font-size="{size}pt" fo:font-weight="bold" fo:color="#203b50"/></style:style>'
styles += '</office:styles></office:document-styles>'
manifest = '''<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>'''
with ZipFile(root / 'Orbit Desktop - Updated README.odt', 'w') as z:
    z.writestr('mimetype', 'application/vnd.oasis.opendocument.text')
    for name, data in [('content.xml', content), ('styles.xml', styles), ('META-INF/manifest.xml', manifest)]:
        z.writestr(name, data, compress_type=ZIP_DEFLATED)
print('Created Writer document from the Markdown draft.')
