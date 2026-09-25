import json
from playwright.sync_api import sync_playwright, expect
O='https://kimi.tailec998.ts.net:4325'
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/home/mojo/.hermes-instances/fresh/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',args=['--no-sandbox'])
 page=b.new_page(); errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(O);page.set_content(f'<iframe sandbox="allow-scripts allow-downloads" src="{O}/apps/cocs-studio-3dffa1d817142e663e455de9/index.html"></iframe>')
 s=page.frame_locator('iframe');s.locator('[data-tool=updates]').click();s.locator('#updateDays').select_option('36500');s.locator('#updateScan').click()
 expect(s.locator('#updateScan')).to_be_enabled(timeout=180000)
 print(s.locator('#updateStatus').inner_text())
 assert s.locator('#updateBranches option').count()>0
 s.locator('#updateCompare').click();expect(s.locator('#updateExport')).to_be_enabled(timeout=90000)
 r=json.loads(s.locator('#updateStatus').inner_text());assert r['activation'].startswith('NOT UPDATED');assert len(r['target']['commit'])==40
 print('PASS live GitHub comparison',r['target']['name'],len(r['impacts']))
 s.locator('#updateDays').select_option('90');assert s.locator('#updateExport').is_disabled()
 page.route('https://api.github.com/**',lambda route:route.fulfill(status=403,body='{}',headers={'Access-Control-Allow-Origin':'*'}))
 s.locator('#updateScan').click();expect(s.locator('#updateStatus')).to_contain_text('HTTP 403');assert s.locator('#updateCompare').is_disabled();assert not errors,errors
 print('PASS stale evidence invalidation and simulated rate-limit failure; zero page errors')
 b.close()
