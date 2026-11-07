const {chromium}=require('/home/fengliang.975/.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright-core');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const root=process.cwd(),serverPid=JSON.parse(fs.readFileSync('/tmp/mobile-terminal-perf-20261107/pty-after.json')).serverPid;
const tmux=(...args)=>execFileSync('nsenter',['-t',String(serverPid),'-U','-m','--preserve-credentials','--','tmux','-L','mtplain',...args],{encoding:'utf8'});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-gpu','--disable-webgl','--disable-3d-apis','--no-proxy-server']});
 const report={errors:[],prefixes:{},resizes:[]};let context;
 async function open(){
  context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844},hasTouch:true});
  await context.addInitScript(()=>sessionStorage.setItem('ttyd_last_tmux_session','t2'));
  const page=await context.newPage();
  await page.route('**/api/user-config',route=>route.fulfill({json:{}}));
  page.on('pageerror',e=>report.errors.push(e.message));
  page.on('websocket',ws=>{
   ws.on('framereceived',({payload})=>{const b=Buffer.from(payload);report.prefixes[b[0]]=(report.prefixes[b[0]]||0)+1;});
   ws.on('framesent',({payload})=>{const b=Buffer.from(payload);if(b[0]===49)report.resizes.push(JSON.parse(b.subarray(1).toString()));});
  });
  await page.goto('http://10.37.97.145:17865/');
  await page.getByRole('button',{name:'Open sessions sidebar'}).filter({hasText:'t2'}).waitFor({timeout:15000});
  return page;
 }
 async function command(page,line,marker){
  const input=page.locator('.xterm-helper-textarea');await input.pressSequentially(line);await input.press('Enter');
  await page.waitForFunction(marker=>document.querySelector('.xterm-rows')?.textContent?.includes(marker),marker,{timeout:10000});
 }
 try{
  let page=await open();report.secureContext=await page.evaluate(()=>isSecureContext);
  await command(page,"printf 'PROBE_%s\\n' 'READY'",'PROBE_READY');
  await page.evaluate(()=>{
   window.__ptyProbe={echo:0,stopped:0};new MutationObserver(()=>{const t=document.querySelector('.xterm-rows')?.textContent||'';if(t.includes('ECHO pty_verify'))window.__ptyProbe.echo ||= Date.now();if(t.includes('STOPPED'))window.__ptyProbe.stopped ||= Date.now();}).observe(document.querySelector('.xterm-rows'),{subtree:true,childList:true,characterData:true});
  });
  await command(page,`python3 '${root}/scripts/weaknet/agent-sim.py' --rate 100`,'SIM READY');
  await delay(5000);let start=Date.now();await page.locator('.xterm-helper-textarea').pressSequentially('kpty_verify.');
  await page.waitForFunction(()=>window.__ptyProbe.echo>0);report.echoMs=await page.evaluate(()=>window.__ptyProbe.echo)-start;
  start=Date.now();await page.locator('.xterm-helper-textarea').press('Control+c');await page.waitForFunction(()=>window.__ptyProbe.stopped>0);report.interruptMs=await page.evaluate(()=>window.__ptyProbe.stopped)-start;
  await command(page,"PERSIST_MARK=stillhere; printf 'SAVE_%s\\n' 'DONE'",'SAVE_DONE');
  await page.setViewportSize({width:844,height:390});await delay(400);
  report.domRows=await page.locator('.xterm-rows > div').count();assert.equal(report.resizes.at(-1).rows,report.domRows);
  await context.close();await delay(700);
  report.sessionsAfterClose=tmux('list-sessions','-F','#{session_name}').trim().split('\n');assert.deepEqual(report.sessionsAfterClose,['t1','t2']);
  page=await open();await command(page,"printf 'PERSIST_%s\\n' \"$PERSIST_MARK\"",'PERSIST_stillhere');
  report.restoredShellState=true;assert.ok(report.prefixes[53]>20);assert.deepEqual(report.errors,[]);
  console.log(JSON.stringify(report,null,2));fs.writeFileSync('/tmp/mobile-terminal-perf-20261107/pty-browser.json',JSON.stringify(report,null,2));
 }finally{await context?.close();await browser.close();tmux('kill-server');}
})().catch(error=>{console.error(error);process.exitCode=1});
