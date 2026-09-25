import asyncio,json,subprocess
from playwright.async_api import async_playwright
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(headless=True,args=['--no-sandbox'])
  page=await browser.new_page()
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  from urllib.parse import quote
  url='http://127.0.0.1:4333/apps/planet-remote-2b44f8321d59e51bd2941a4b/index.html'
  r=await page.goto(url+'#orbit-config='+quote(json.dumps({'theme':'Solar','size':260,'message':'Desktop test'})))
  assert r.status==200,r.status
  assert await page.locator('#message').inner_text()=='Desktop test'
  assert await page.locator('#title').inner_text()=='Solar planet'
  assert await page.locator('#planet').evaluate('(e)=>e.style.width')=='260px'
  assert not errors,errors
  print('Published browser test passed: HTTP 200, theme, size, message, no JS errors')
  await browser.close()
asyncio.run(main())
