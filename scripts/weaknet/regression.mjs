import { acquireBenchLock } from './bench-lock.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const state=process.env.MT_WEAKNET_STATE||path.join(os.homedir(),'.local/share/mt-weaknet');
const releaseLock=acquireBenchLock(state);
const manifest=JSON.parse(fs.readFileSync(path.join(state,'bench-state.json')));
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_CORE_PATH||path.join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'@playwright/cli/node_modules/playwright-core'));
const here=path.dirname(fileURLToPath(import.meta.url));
const output=path.join(state,'logs',`regression-${Date.now()}.json`);
const results=[];
const only=process.argv.find(arg=>arg.startsWith('--only='))?.slice(7).split(',');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const pane=manifest.panes['7702'];
function cli(...args){return execFileSync('herdr',['--session','mtbench',...args],{encoding:'utf8',timeout:10000});}
async function api(route,method='GET',body){const r=await fetch('http://127.0.0.1:8474'+route,{method,body:body===undefined?undefined:JSON.stringify(body),headers:{'content-type':'application/json'},signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error(await r.text());const t=await r.text();return t?JSON.parse(t):null;}
async function profile(port,kind='P0'){
  if((await api('/proxies'))[`mt${port}`])await api(`/proxies/mt${port}`,'DELETE');
  await api('/proxies','POST',{name:`mt${port}`,listen:`127.0.0.1:${port+10}`,upstream:`127.0.0.1:${port}`});
  for(const stream of ['upstream','downstream']){
    await api(`/proxies/mt${port}/toxics`,'POST',{name:`latency-${stream}`,stream,type:'latency',attributes:{latency:kind==='P0'?25:400,jitter:kind==='P0'?0:150}});
    if(kind==='P2')await api(`/proxies/mt${port}/toxics`,'POST',{name:`bandwidth-${stream}`,stream,type:'bandwidth',attributes:{rate:32}});
  }
}
async function cleanPane(id=pane){
  cli('pane','send-keys',id,'ctrl+c');
  for(let i=0;i<100;i++){
    const info=JSON.parse(cli('pane','process-info','--pane',id)).result.process_info;
    if(info.foreground_process_group_id===info.shell_pid){await delay(100);return;}
    await delay(50);
  }
  throw Error('Pane did not return to shell');
}
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox','--disable-gpu','--disable-webgl','--disable-3d-apis']});
async function open(port=7702,id=pane){
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844},hasTouch:true});
  const page=await context.newPage();const traffic={opens:0,closes:0,inputs:[],prefixes:{},controls:[],errors:[]};
  page.on('pageerror',error=>traffic.errors.push(error.message));
  page.on('websocket',ws=>{traffic.opens++;ws.on('close',()=>traffic.closes++);ws.on('framesent',({payload})=>{const b=Buffer.from(payload);if(b[0]===48||b[0]===49)traffic.inputs.push({prefix:b[0],hex:b.subarray(1).toString('hex'),text:b.subarray(1).toString()});});ws.on('framereceived',({payload})=>{const b=Buffer.from(payload);traffic.prefixes[b[0]]=(traffic.prefixes[b[0]]||0)+1;if(b[0]===52)traffic.controls.push(JSON.parse(b.subarray(1)));});});
  try{
    await page.goto(`http://127.0.0.1:${port+10}/`+(id?`?mux=herdr&pane=${encodeURIComponent(id)}`:''),{timeout:60000});
    await page.locator('[title="Connected"]').waitFor({timeout:20000});
    await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent?.trim().length>0);
    return {page,context,traffic,input:page.locator('.xterm-helper-textarea')};
  }catch(error){await context.close();throw error;}
}
async function check(name,fn){if(only&&!only.some(prefix=>name.startsWith(prefix)))return;try{const evidence=await fn();results.push({name,passed:true,evidence});}catch(error){results.push({name,passed:false,error:error.stack});}fs.writeFileSync(output,JSON.stringify(results,null,2));console.log(JSON.stringify(results.at(-1)));}
async function shellEcho(run,tag){await run.input.pressSequentially(`printf 'REG_%s\\n' '${tag}'`);await run.input.press('Enter');await run.page.waitForFunction(tag=>document.querySelector('.xterm-rows')?.textContent?.includes('REG_'+tag),tag);return tag;}
try{
  await profile(7702);await cleanPane();
  await check('1 herdr input and 15 connected indicator',async()=>{const r=await open();try{await shellEcho(r,'HERDR');assert.ok(r.traffic.prefixes[53]);assert.ok(await r.page.locator('[title="Connected"]').count());return r.traffic;}finally{await r.context.close();}});
  await check('2 multiline paste API through text input UI',async()=>{
    await cleanPane();const r=await open();try{
      const body="printf 'PASTE_%s\\n' 'FIRST'\nprintf 'PASTE_%s\\n' 'SECOND'\n";
      await r.page.getByRole('button',{name:'Text input',exact:true}).click();
      await r.page.getByPlaceholder('Type or paste text...').fill(body);
      const response=r.page.waitForResponse(response=>response.url().includes('/api/herdr/paste'));void response.catch(()=>{});
      await r.page.getByRole('button',{name:'Send',exact:true}).click();const res=await response;assert.equal(res.status(),200);
      // Herdr paste retains the shell's normal bracketed-paste confirmation behavior.
      await r.input.press('Enter');await r.page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent?.includes('PASTE_SECOND'));
      return {response:await res.json(),text:await r.page.locator('.xterm-rows').innerText()};
    }finally{await r.context.close();}
  });
  await check('3 Ctrl Alt Shift arrow combinations',async()=>{
    await cleanPane();const r=await open();try{
      cli('pane','run',pane,`python3 '${here}/input-recorder.py'`);await r.page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent?.includes('RECORDER READY'));
      await r.page.getByRole('button',{name:'组合键',exact:true}).click();
      const panel=r.page.getByRole('region',{name:'组合键面板'});
      const evidence=[];
      for(const [modifier,key,expected] of [['Ctrl','ArrowLeft','1b5b313b3544'],['Alt','ArrowRight','1b5b313b3343'],['Shift','ArrowUp','1b5b313b3241']]){
        await panel.getByRole('button',{name:modifier,exact:true}).click();await panel.getByRole('button',{name:key,exact:true}).click();
        await r.page.waitForFunction(expected=>document.querySelector('.xterm-rows')?.textContent?.includes('KEYHEX '+expected),expected);
        evidence.push({modifier,key,expected});await panel.getByRole('button',{name:modifier,exact:true}).click();
      }
      return evidence;
    }finally{await r.context.close();await cleanPane();}
  });
  await check('4 pinch emits correct resized dimensions',async()=>{
    const r=await open();try{
      const cdp=await r.context.newCDPSession(r.page);const before=r.traffic.inputs.length;
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:110,y:250,id:1},{x:210,y:250,id:2}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:80,y:250,id:1},{x:240,y:250,id:2}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await delay(700);
      const resizes=r.traffic.inputs.slice(before).filter(frame=>frame.prefix===49).map(frame=>JSON.parse(frame.text));assert.ok(resizes.length);
      const rows=await r.page.locator('.xterm-rows > div').count();assert.equal(resizes.at(-1).rows,rows);
      return {resizes,domRows:rows,fontSize:await r.page.evaluate(()=>localStorage.getItem('terminal_font_size'))};
    }finally{await r.context.close();}
  });
  await check('5 switch pane using sidebar',async()=>{
    const r=await open();try{
      await r.page.getByRole('button',{name:'Open sessions sidebar'}).click();
      const target=manifest.panes['7705'];await r.page.getByRole('button').filter({has:r.page.getByText(target,{exact:true})}).click();
      await r.page.waitForURL(url=>url.searchParams.get('pane')===target);const close=r.page.getByRole('button',{name:'Close sessions sidebar'});if(await close.isVisible())await close.click();
      await r.page.locator('[title="Connected"]').waitFor({timeout:20000});
      await shellEcho(r,'SWITCHED');return {url:r.page.url(),opens:r.traffic.opens};
    }finally{await r.context.close();}
  });
  for(const kind of ['P0','P2'])await check(`6 takeover under ${kind}`,async()=>{
    await profile(7702,kind);await cleanPane();const first=await open();let second;
    try{
      if(kind==='P2'){cli('pane','run',pane,`python3 '${here}/agent-sim.py' --rate 100`);await delay(3000);}
      second=await open();await first.page.getByText('已被另一端接管',{exact:true}).waitFor({timeout:15000});
      const count=first.traffic.opens;await delay(7000);assert.equal(first.traffic.opens,count);assert.ok(await first.page.locator('[title="Disconnected"]').count());
      return {first:first.traffic,second:second.traffic};
    }finally{await first.context.close();if(second)await second.context.close();await cleanPane();}
  });
  await profile(7702);
  await check('7 hidden controller release and visible restore',async()=>{
    const r=await open();try{
      // Desktop/headless visibility has no OS app switch; dispatch the browser lifecycle signal.
      await r.page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
      await r.page.locator('[title="Disconnected"]').waitFor();await delay(200);assert.ok(r.traffic.closes>=1);
      await r.page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));});
      await r.page.locator('[title="Connected"]').waitFor();await shellEcho(r,'VISIBLE');assert.equal(r.traffic.opens,2);return r.traffic;
    }finally{await r.context.close();}
  });
  for(const port of [7701,7702])await check(`8 Detach behavior ${port}`,async()=>{
    await profile(port);const r=await open(port,manifest.panes[String(port)]);try{
      const before=r.traffic.opens;await r.page.getByRole('button',{name:'Open sessions sidebar'}).click();
      const response=r.page.waitForResponse(response=>response.url().includes('/api/herdr/release'));void response.catch(()=>{});
      await r.page.getByRole('button',{name:'Detach to Shell',exact:true}).click();assert.equal((await response).status(),200);
      await delay(2500);assert.ok(r.traffic.opens>before);await shellEcho(r,'DETACH');return r.traffic;
    }finally{await r.context.close();}
  });
  await check('11 Git Diff panel',async()=>{
    const fixture=fs.mkdtempSync(path.join(state,'git-regression-'));
    const originalCwd=JSON.parse(cli('pane','process-info','--pane',pane)).result.process_info.foreground_processes[0]?.cwd;
    const quote=value=>"'"+value.replaceAll("'", "'\\''")+"'";
    let r;
    try{
      execFileSync('git',['init','-q',fixture]);
      fs.writeFileSync(path.join(fixture,'regression.txt'),'BEFORE_WEAKNET_DIFF\n');
      execFileSync('git',['-C',fixture,'add','regression.txt']);
      execFileSync('git',['-C',fixture,'-c','user.name=Weaknet Bench','-c','user.email=weaknet@example.invalid','-c','commit.gpgsign=false','commit','-qm','fixture']);
      fs.writeFileSync(path.join(fixture,'regression.txt'),'AFTER_WEAKNET_DIFF\n');
      cli('pane','run',pane,'cd '+quote(fixture));await delay(300);r=await open();
      await r.page.getByRole('button',{name:'Git',exact:true}).click();
      await r.page.getByText('regression.txt',{exact:true}).click();
      await r.page.getByText('AFTER_WEAKNET_DIFF',{exact:true}).waitFor({timeout:10000});
      return {text:(await r.page.locator('body').innerText()).slice(-4000)};
    }finally{
      if(r)await r.context.close();
      cli('pane','run',pane,'cd '+quote(originalCwd||process.env.MT_WEAKNET_ROOT||path.join(os.homedir(),'project/mobile-terminal-weaknet')));
      fs.rmSync(fixture,{recursive:true,force:true});
    }
  });
  await check('12 image paste upload',async()=>{const r=await open();try{
    const response=r.page.waitForResponse(response=>response.url().endsWith('/api/upload'));void response.catch(()=>{});
    await r.page.locator('.xterm-helper-textarea').evaluate(element=>{
      const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR2cAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
      const data=new DataTransfer();data.items.add(new File([bytes],'mtbench-paste.png',{type:'image/png'}));element.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
    });
    const res=await response;assert.equal(res.status(),200);const body=await res.json();assert.ok(fs.existsSync(body.path));assert.ok(path.basename(body.path).includes('mtbench-paste'));assert.equal(fs.readFileSync(body.path).toString('base64'),'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR2cAAAAASUVORK5CYII=');fs.unlinkSync(body.path);return body;
  }finally{await r.context.close();await cleanPane();}});
  await check('13 goal and prompt boards load with gzip',async()=>{
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
    try{const records=[];for(const name of ['goal-board.html','prompt-board.html']){const page=await context.newPage();const response=await page.goto('http://127.0.0.1:7712/'+name);assert.equal(response.status(),200);assert.equal(response.headers()['content-encoding'],'gzip');await page.locator('#status').filter({hasText:name==='goal-board.html'?'已加载':'已同步'}).waitFor({timeout:10000});await page.locator('#detail').waitFor();records.push({name,title:await page.title(),status:await page.locator('#status').innerText(),encoding:response.headers()['content-encoding']});await page.close();}return records;}finally{await context.close();}
  });
  await check('9/10 plain shell and tmux restore within two minutes',async()=>{
    const start=Date.now();spawnSync('tmux',['-L','mtbench','kill-server'],{stdio:'ignore'});
    const r=await open(7702,null);try{
      await shellEcho(r,'PLAIN');assert.ok(r.traffic.prefixes[53]);
      execFileSync('tmux',['-L','mtbench','new-session','-d','-s','t1']);execFileSync('tmux',['-L','mtbench','new-session','-d','-s','t2']);
      await r.page.evaluate(()=>sessionStorage.setItem('ttyd_last_tmux_session','t2'));
      await r.page.reload();await r.page.getByRole('button',{name:'Open sessions sidebar'}).filter({hasText:'t2'}).waitFor({timeout:15000});
      await shellEcho(r,'TMUX');
      await r.page.evaluate(()=>{
        window.__tmuxRegression={ready:0,echo:0,stopped:0,maxStep:0};
        new MutationObserver(()=>{
          const text=document.querySelector('.xterm-rows')?.textContent||'';
          const state=window.__tmuxRegression;
          if(text.includes('SIM READY'))state.ready=Date.now();
          if(text.includes('ECHO tmux_busy')&&!state.echo)state.echo=Date.now();
          if(text.includes('STOPPED'))state.stopped=Date.now();
          for(const match of text.matchAll(/agent step=(\d+)/g))state.maxStep=Math.max(state.maxStep,Number(match[1]));
        }).observe(document.querySelector('.xterm-rows'),{subtree:true,childList:true,characterData:true});
      });
      const before=r.traffic.prefixes[53]||0;
      const simulator=path.join(here,'agent-sim.py').replaceAll("'", "'\\''");
      await r.input.pressSequentially(`python3 '${simulator}' --rate 100`);await r.input.press('Enter');
      await r.page.waitForFunction(()=>window.__tmuxRegression.ready>0,null,{polling:10});
      await delay(5000);
      const inputAt=Date.now();await r.input.pressSequentially('ktmux_busy.');
      await r.page.waitForFunction(()=>window.__tmuxRegression.echo>0,null,{polling:10});
      const interruptAt=Date.now();await r.input.press('Control+c');
      await r.page.waitForFunction(since=>window.__tmuxRegression.stopped>=since,interruptAt,{polling:10});
      const busy=await r.page.evaluate(()=>window.__tmuxRegression);
      assert.ok(busy.maxStep>=400);assert.ok((r.traffic.prefixes[53]||0)-before>20);
      assert.ok(!r.traffic.controls.some(c=>c.type==='heartbeat'));assert.ok(Date.now()-start<120000);
      return {elapsed_ms:Date.now()-start,busy:{maxStep:busy.maxStep,echo_ms:busy.echo-inputAt,interrupt_ms:busy.stopped-interruptAt,compressed_frames:(r.traffic.prefixes[53]||0)-before},traffic:r.traffic};
    }finally{await r.context.close();execFileSync('tmux',['-L','mtbench','kill-server']);}
  });
}finally{fs.writeFileSync(output,JSON.stringify(results,null,2));await browser.close();releaseLock();process.exitCode=results.some(result=>!result.passed)?1:0;console.log('Report '+output);}
