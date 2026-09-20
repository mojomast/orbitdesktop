from pathlib import Path
p=Path('/usr/share/xpra/www/index.html')
p.write_text(p.read_text().replace('</body>', '<script src="orbit-fit.js"></script></body>'))
for suffix in ['.gz','.br']:
 p.with_name(p.name+suffix).unlink(missing_ok=True)
