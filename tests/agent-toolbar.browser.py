from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox'])
 page=b.new_page()
 page.goto('http://127.0.0.1:4187/')
 print(page.evaluate('''async () => {
 const {createPane}=await import('/src/panes.ts');
 document.querySelector('#app').replaceChildren();
 const host=document.createElement('div');host.className='monitor desktop-window';document.querySelector('#app').append(host);
 const pane=createPane({id:crypto.randomUUID(),kind:'agent',url:'orbit://welcome'},19,{kind(){},split(){},close(){},url(){}});
 host.append(pane.element);host.style.height='700px';
 const head=host.querySelector('.pane-head');
 for(const theme of ['midnight','xp','classic','nous','paper','cyberpunk','aurora','phosphor','blueprint','pop','ocean','forest','plum','ember']) {
 document.documentElement.dataset.orbitTheme=theme;
 for(const width of [280,320,500,670,1000]) {
 host.style.width=width+'px';await new Promise(requestAnimationFrame);
 const h=head.getBoundingClientRect();
 for(const node of head.querySelectorAll('button,input,select')) {
 const r=node.getBoundingClientRect();
 if(r.width && (r.left<h.left-1||r.right>h.right+1||r.bottom>h.bottom+1))throw Error(theme+' '+width+' clipped '+node.textContent);
 }
 if(head.children[1].className!=='agent-meta agent-toolbar-meta')throw Error('placement');
 }
 }
 const toggle=head.querySelector('.inline-tools-toggle');
 const toolButton=[...head.querySelectorAll('button')].find(x=>x.textContent==='Show tools');
 if(!toolButton)throw Error('missing tools');toolButton.click();if(toolButton.textContent!=='Hide tools')throw Error('toggle');
 pane.dispose();return 'PASS: toolbar controls contained at 280/320/500/670/1000px across 14 theme attributes; placed beside selector; tool toggle works';
 }'''))
 b.close()
