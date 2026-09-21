from playwright.sync_api import sync_playwright, expect
import json, zipfile
from pathlib import Path
import os
URL=os.environ.get('DEVPLAN_TEST_URL','http://127.0.0.1:4178/devplan-studio/index.html')
answers=['Test planning tool','Help teams plan releases','Maintainers capture a goal then export a plan','Create projects\nExport plans','Create a project and see its name\nDownload a ZIP containing the plan','Billing','Vanilla JS','New project','None','No authentication','None','Local browser; retain previous release for rollback','One week, no remote data','Browser tests and ZIP integrity checks','None']
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(accept_downloads=True,viewport={'width':1280,'height':900})
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('dialog',lambda d:d.accept())
    response=page.goto(URL)
    assert response.status==200
    assert page.locator('#storage').inner_text()
    page.locator('#next').click()
    assert 'Answer this question' in page.locator('#notice').inner_text()
    for answer in answers:
        page.locator('#answer').fill(answer)
        page.locator('#next').click()
    assert 'Right-size' in page.locator('h2').inner_text()
    page.locator('#next').click()
    page.get_by_role('button',name='Generate specification',exact=True).click()
    assert 'R2' in page.locator('#spec').input_value()
    page.locator('#next').click()
    page.locator('#approve').check()
    page.locator('#next').click()
    assert 'Implement R1' in page.locator('#view').inner_text()
    page.locator('#next').click()
    page.get_by_role('button',name='Save checkpoint',exact=True).click()
    page.locator('#next').click()
    with page.expect_download() as dl:
        page.get_by_role('button',name='Download complete ZIP',exact=True).click()
    path=Path('/tmp/devplan-studio-test.zip');dl.value.save_as(path)
    with zipfile.ZipFile(path) as z:
        assert z.testzip() is None
        for name in ['spec.md','devplan.md','handoff.md','phase-P1.md','interview.json','validation.json']:assert name in z.namelist()
        assert 'three unsuccessful' in z.read('handoff.md').decode()
        assert json.loads(z.read('validation.json'))['aiReviewed'] is False
    with page.expect_download() as dl:page.locator('#save').click()
    project=Path('/tmp/devplan-studio-project.json');dl.value.save_as(project)
    page.locator('#new').click()
    page.locator('#import').set_input_files(project)
    expect(page.locator('#answer')).to_have_value(answers[0])
    page.get_by_role('button',name='07  Export & handoff',exact=True).click()
    assert 'approve the review' in page.locator('#view').inner_text()
    page.locator('#import').set_input_files({'name':'bad.json','mimeType':'application/json','buffer':b'{"version":9}'})
    expect(page.locator('#notice')).to_contain_text('Import failed')
    page.get_by_role('button',name='01  Interview',exact=True).click()
    page.locator('#answer').fill('<img src=x onerror=alert(1)>')
    assert page.locator('img').count()==0
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path='/tmp/devplan-studio-mobile.png')
    assert not errors,errors
    print('PASS: published sandbox, interview, required-answer gate, specification, approval, phases, checkpoints, ZIP CRC/content, export/import, invalid import, approval reset, literal text, mobile width, no JS errors')
    browser.close()
