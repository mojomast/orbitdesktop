from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']); page=b.new_page()
 page.goto('http://127.0.0.1:4187/')
 result=page.evaluate('''async () => {
 const {createInlineTools} = await import('/src/inline-tools.ts');
 document.body.replaceChildren();
 const scroll=document.createElement('div');scroll.style.cssText='height:250px;overflow:auto;width:320px';document.body.append(scroll);
 const t=createInlineTools('fixture',scroll);document.body.append(t.toggle);scroll.append(t.root);t.toggle.click();t.sync('a','run-a');
 const assert=(x,s)=>{if(!x)throw Error(s)};
 for(let i=0;i<35;i++) t.event({event:'tool.started',tool:'terminal',tool_call_id:String(i),timestamp:Date.now()/1000,preview:'command '+i},'run-a');
 assert(scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<5,'auto follow');
 scroll.scrollTop=0;
 t.event({event:'tool.completed',tool:'terminal',tool_call_id:'34',duration:1,output:'<img src=x onerror=alert(1)>'},'run-a');
 assert(scroll.scrollTop===0,'reading older events must not jump');
 assert(t.root.querySelectorAll('.inline-tool').length===35,'ID correlation');
 assert(!t.root.querySelector('img'),'literal rendering');
 t.event({event:'tool.failed',tool:'terminal',tool_call_id:'33',error:true},'run-a');
 assert(t.root.querySelectorAll('[data-phase="Failed"]').length===1,'failure status');
 const duplicate={event:'tool.started',tool:'terminal',tool_call_id:'x',preview:'duplicate'};
 t.event(duplicate,'run-a');t.event(duplicate,'run-a');
 assert(t.root.querySelectorAll('.inline-tool').length===36,'deduplication');
 for(let i=40;i<200;i++)t.event({event:'tool.started',tool:'read_file',tool_call_id:String(i)},'run-a');
 assert(t.root.querySelectorAll('.inline-tool').length===100,'bounded memory');
 t.sync('b');assert(t.root.querySelectorAll('.inline-tool').length===0,'session isolation');
 t.toggle.click();assert(t.root.hidden,'toggle');t.dispose();
 return 'PASS fixture browser: ID correlation, concurrent calls, failures, bounded rows, literal output, autoscroll, scroll-up pause, session isolation and toggle';
 }''')
 print(result);b.close()
