from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']); page=b.new_page()
 page.goto('http://127.0.0.1:4187/')
 page.route('**/api/agent', lambda route: route.fulfill(status=200,content_type='application/json',body='{}'))
 print(page.evaluate('''async()=>{
 const {createAgentChat}=await import('/src/agent-chat.ts');
 const {createInlineTools}=await import('/src/inline-tools.ts');
 const assert=(v,s)=>{if(!v)throw Error(s)};
 document.body.replaceChildren();
 const body=document.createElement('div');body.style.width='280px';document.body.append(body);
 const dispose=createAgentChat(body,'activity-fixture',()=> '');
 assert(body.querySelector('.agent-activity-strip').textContent.includes('Host disconnected'),'offline status');
 body.querySelector('.agent-activity-strip button').click();
 assert(!body.querySelector('.inline-tools').hidden,'strip opens tools');
 body.querySelectorAll('.agent-activity-strip button')[1].click();
 assert(document.querySelectorAll('.agent-overview-row').length>=1,'overview registration');
 let focused=false;window.addEventListener('orbit-focus-agent',e=>{if(e.detail==='activity-fixture')focused=true},{once:true});
 document.querySelector('[data-agent-id="activity-fixture"]').click();
 await new Promise(r=>setTimeout(r,50));
 assert(focused && !document.querySelector('.agent-overview'),'focus callback and close');
 const status=body.querySelector('.agent-status');status.textContent='WAITING FOR APPROVAL';
 await new Promise(r=>setTimeout(r,0));
 const scroller=document.createElement('div');document.body.append(scroller);
 const t=createInlineTools('activity-tools',scroller);scroller.append(t.root);t.show();
 t.event({event:'tool.started',tool:'read_file',tool_call_id:'a'},'r');
 assert(t.summary().includes('Running read_file'),'running status');
 t.event({event:'tool.completed',tool:'read_file',tool_call_id:'a'},'r');
 t.event({event:'tool.failed',tool:'terminal',tool_call_id:'b',error:true},'r');
 assert(t.root.querySelector('.inline-tools-totals').textContent.includes('read_file ×1'),'grouped totals');
 [...t.root.querySelectorAll('button')].find(b=>b.textContent==='Hide completed').click();
 assert(getComputedStyle(t.root.querySelector('[data-phase="Completed"]')).display==='none','success collapsed');
 assert(getComputedStyle(t.root.querySelector('[data-phase="Failed"]')).display!=='none','failure remains');
 t.sync('new-session');assert(t.root.querySelector('.inline-tools-totals').textContent.includes('0 completed'),'reset');
 t.event({event:'tool.started',tool:'terminal'},'new');assert(!t.summary().includes('Running'),'missing ID does not invent ongoing call');
 t.dispose();dispose();
 return 'PASS activity strip, overview registration/focus, collapsed completed groups, visible failures, session reset, missing-ID uncertainty';
 }'''))
 b.close()
