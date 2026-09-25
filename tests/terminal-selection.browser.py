from playwright.sync_api import sync_playwright, expect
# Synthetic transport fixture; real xterm renderer, mouse gestures and OS clipboard.
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
    context=browser.new_context(permissions=['clipboard-read','clipboard-write'],viewport={'width':1200,'height':900})
    page=context.new_page()
    page.route('**/clipboard-harness',lambda route: route.fulfill(content_type='text/html',body='''<html><body><script type="module">
import {createPane,setToken} from '/src/panes.ts';
class Socket {
 static OPEN=1; static CONNECTING=0;
 readyState=1;
 constructor(){window.socket=this;setTimeout(()=>this.onopen(),30)}
 send(raw){const m=JSON.parse(raw);(window.sent??=[]).push(m);if(m.type==='auth')this.onmessage({data:JSON.stringify({type:'ready',history:true})});}
 close(){}
}
window.WebSocket=Socket;
setToken('fixture-not-a-credential');
const pane=createPane({id:'test',kind:'terminal',url:''},16,{});
document.body.append(pane.element);
document.querySelector('.terminal-host').style.cssText='width:1000px;height:500px';pane.resize();
window.feed=data=>socket.onmessage({data:JSON.stringify({type:'data',data})});
</script></body></html>'''))
    page.goto('http://127.0.0.1:4499/clipboard-harness')
    page.get_by_role('button',name='Connect to local host shell').click()
    page.wait_for_function('window.socket && window.sent?.some(m=>m.type==="auth")')
    page.evaluate("feed(Array.from({length:150},(_,i)=>'RETAINED_'+i+'\\r\\n').join('')+'\\x1b[?1049h\\x1b[2J\\x1b[HAPPLICATION_SCREEN\\r\\n\\x1b[?1000h\\x1b[?1006h')")
    page.wait_for_timeout(300)
    mode=page.get_by_role('button',name='Toggle persistent selection',exact=False)
    mode.click()
    expect(mode).to_have_attribute('aria-pressed','true')
    box=page.locator('.xterm-screen').bounding_box()
    page.mouse.move(box['x']+2,box['y']+8);page.mouse.down()
    page.mouse.move(box['x']+180,box['y']+8,steps=15);page.mouse.up()
    expect(page.get_by_role('button',name='Copy selected terminal text',exact=False)).to_be_enabled()
    page.keyboard.press('Control+c')
    assert 'APPLICATION_SCREEN' in page.evaluate('navigator.clipboard.readText()')
    assert not page.evaluate('sent.some(m=>m.type==="input")'), 'Selection/copy leaked input to app'
    page.get_by_role('button',name='Open native terminal text selection',exact=False).click()
    text=page.get_by_role('textbox',name='Terminal scrollback text')
    assert 'RETAINED_0' in text.input_value()
    assert 'RETAINED_149' in text.input_value()
    assert 'APPLICATION_SCREEN' in text.input_value()
    text.press('Escape')
    page.locator('.xterm-helper-textarea').focus()
    page.keyboard.press('Escape')
    expect(mode).to_have_attribute('aria-pressed','false')
    print('PASS real xterm: mouse-enabled alternate screen selects without Shift, native Ctrl+C OS clipboard, no app input leakage, normal history beyond viewport retained alongside alternate screen, Escape exits mode. Transport fixture only.')
    browser.close()
