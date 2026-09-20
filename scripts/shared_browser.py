#!/usr/bin/env python3
"""Control the shared Orbit Chromium. Uses its private CDP port, not a separate browser."""
import argparse,json
from playwright.sync_api import sync_playwright
p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=['tabs','navigate','text','click','fill','press','screenshot']);p.add_argument('--tab',type=int,default=0);p.add_argument('--url');p.add_argument('--selector');p.add_argument('--value');p.add_argument('--output');a=p.parse_args()
with sync_playwright() as pw:
 b=pw.chromium.connect_over_cdp('http://127.0.0.1:4345');pages=b.contexts[0].pages
 if a.action=='tabs':print(json.dumps([{'index':i,'url':page.url,'title':page.title()} for i,page in enumerate(pages)]))
 else:
  page=pages[a.tab];page.bring_to_front()
  if a.action=='navigate':
   if not a.url or not a.url.startswith(('https://','http://')):p.error('Use an http(s) URL')
   page.goto(a.url,wait_until='domcontentloaded',timeout=30000)
  elif a.action=='text':print(page.locator('body').inner_text()[:30000])
  elif a.action=='click':page.locator(a.selector).click(timeout=10000)
  elif a.action=='fill':page.locator(a.selector).fill(a.value,timeout=10000)
  elif a.action=='press':page.keyboard.press(a.value)
  elif a.action=='screenshot':
   if not a.output:p.error('--output required')
   page.screenshot(path=a.output)
  if a.action!='text':print(json.dumps({'url':page.url,'title':page.title(),'action':a.action}))
 # Do not close browser/context: the human is using it too. Playwright disconnects on exit.
