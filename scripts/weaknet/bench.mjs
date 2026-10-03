#!/usr/bin/env node
import { acquireBenchLock } from './bench-lock.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const state = process.env.MT_WEAKNET_STATE || path.join(os.homedir(), '.local/share/mt-weaknet');
const releaseLock=acquireBenchLock(state);
const manifest = JSON.parse(fs.readFileSync(path.join(state, 'bench-state.json')));
const require = createRequire(import.meta.url);
const playwright = process.env.PLAYWRIGHT_CORE_PATH || path.join(execFileSync('npm', ['root', '-g'], {encoding:'utf8'}).trim(), '@playwright/cli/node_modules/playwright-core');
const { chromium } = require(playwright);
const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map(arg => { const i=arg.indexOf('='); return [arg.slice(2,i),arg.slice(i+1)]; }));
const ports = (args.ports || '7701,7702,7703,7704').split(',').map(Number);
const profiles = (args.profiles || 'P0,P1,P2').split(',');
const scenes = (args.scenes || 'S1,S2,S3,S4,S5a,S5b,S5c,S7').split(',');
if (ports.some(port => ![7701,7702,7703,7704].includes(port))) throw new Error('Only isolated ports 7701–7704 are allowed');
const profileRates = args['rates-file'] ? JSON.parse(fs.readFileSync(args['rates-file'], 'utf8')) : {};
const calibrationRate = Number(args.rate || 100);
const sampleMs = Number(args['sample-ms'] || 10000);
if (scenes.includes('CAL') && (ports.length!==1 || ports[0]!==7701 || profiles.length!==1 || profiles[0]!=='P0'
  || !Number.isInteger(calibrationRate) || calibrationRate<1 || calibrationRate>100 || ![10000,20000].includes(sampleMs))) {
  throw new Error('CAL requires baseline 7701/P0, integer rate 1–100 and a 10s or 20s sample');
}
if (scenes.includes('S2u') && profiles.some(profile=>!Number.isInteger(profileRates[profile]) || profileRates[profile]<1 || profileRates[profile]>100)) {
  throw new Error('S2u requires a confirmed rate for every profile in --rates-file');
}
const output = args.output || path.join(state, 'logs', `bench-${Date.now()}.json`);
const prior = args.resume ? JSON.parse(fs.readFileSync(args.resume)) : null;
const results = {started:new Date().toISOString(), config:{ports,profiles,scenes,recovery_probe_ms:20,profile_rates:profileRates,calibration_rate:calibrationRate,sample_ms:sampleMs,viewport:'390x844',serviceWorkers:'block'}, cases:prior?prior.cases.filter(item=>!item.error):[]};
if(prior)results.resumed_from=args.resume;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let probeNumber = 0;
const runTag = Date.now().toString(36).slice(-4);
function cli(...args) { return execFileSync('herdr', ['--session','mtbench',...args], {encoding:'utf8',timeout:10000}); }
function save() { fs.writeFileSync(output, JSON.stringify(results,null,2)); }
async function api(route,method='GET',body) {
  const response=await fetch(`http://127.0.0.1:8474${route}`, {method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(3000)});
  if(!response.ok) throw new Error(`${method} ${route}: ${await response.text()}`);
  const text=await response.text();return text?JSON.parse(text):null;
}
async function setProfile(port,profile) {
  const proxies=await api('/proxies');
  if(proxies[`mt${port}`]) await api(`/proxies/mt${port}`,'DELETE');
  await api('/proxies','POST',{name:`mt${port}`,listen:`127.0.0.1:${port+10}`,upstream:`127.0.0.1:${port}`});
  const route=`/proxies/mt${port}/toxics`;
  const values={P0:[25,0,null],P1:[150,50,128],P2:[400,150,32]}[profile];
  if(!values) throw new Error('Unknown profile '+profile);
  for(const stream of ['upstream','downstream']) {
    await api(route,'POST',{name:`latency-${stream}`,type:'latency',stream,attributes:{latency:values[0],jitter:values[1]}});
    if(values[2]) await api(route,'POST',{name:`bandwidth-${stream}`,type:'bandwidth',stream,attributes:{rate:values[2]}});
  }
}
async function blackout(port,type='timeout') {
  for(const stream of ['upstream','downstream']) await api(`/proxies/mt${port}/toxics`,'POST',{name:`outage-${stream}`,type,stream,attributes:{timeout:type==='timeout'?0:1}});
}
async function bufferedOutage(port,profile,enabled) {
  const normal={P0:[25,0],P1:[150,50],P2:[400,150]}[profile];
  for(const stream of ['upstream','downstream']) await api(`/proxies/mt${port}/toxics/latency-${stream}`,'POST',{attributes:{latency:enabled?60000:normal[0],jitter:enabled?0:normal[1]}});
}
async function restore(port) {
  for(const stream of ['upstream','downstream']) await api(`/proxies/mt${port}/toxics/outage-${stream}`,'DELETE');
}
function stats(samples) {
  const sorted=samples.map(s=>s.ms).sort((a,b)=>a-b);
  return {samples,p50:sorted[Math.ceil(sorted.length*.5)-1],p95:sorted[Math.ceil(sorted.length*.95)-1],max:sorted.at(-1),timeouts:samples.filter(s=>s.timeout).length};
}
let stopping=false;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || '/opt/google/chrome/chrome',headless:true,args:['--no-sandbox','--disable-gpu','--disable-webgl','--disable-3d-apis']});
process.on('SIGTERM',()=>{stopping=true;void browser.close();});
process.on('SIGINT',()=>{stopping=true;void browser.close();});
async function waitForShell(pane) {
  const deadline=Date.now()+5000;
  while(Date.now()<deadline) {
    const info=JSON.parse(cli('pane','process-info','--pane',pane)).result.process_info;
    if(info.foreground_process_group_id===info.shell_pid) { await delay(100);return; }
    await delay(50);
  }
  throw new Error(`Pane ${pane} did not return to its shell`);
}
async function newPage(port,profile) {
  const pane=manifest.panes[String(port)];
  cli('pane','send-keys',pane,'ctrl+c');
  await waitForShell(pane);
  cli('pane','run',pane,"printf '\\033[2J\\033[HMT BENCH READY\\n'");
  await setProfile(port,profile);
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  await context.addInitScript(() => {
    window.__bench={echoes:{},ready:0,stopped:0,overlay:0};
    let previousReady=false, previousStopped=false, previousOverlay=false;
    const inspect=()=>{
      const text=document.querySelector('.xterm-rows')?.textContent || '';
      const now=Date.now();
      for(const match of text.matchAll(/ECHO ([A-Za-z0-9_-]+)/g)) window.__bench.echoes[match[1]]??=now;
      const ready=text.includes('SIM READY'), stopped=text.includes('STOPPED');
      if(ready&&!previousReady)window.__bench.ready=now;
      if(stopped&&!previousStopped)window.__bench.stopped=now;
      previousReady=ready;previousStopped=stopped;
      const overlay=[...document.querySelectorAll('h3')].some(el=>/^(Reconnecting\.\.\.|Disconnected)$/.test(el.textContent));
      if(overlay&&!previousOverlay)window.__bench.overlay=now;
      previousOverlay=overlay;
    };
    new MutationObserver(inspect).observe(document,{subtree:true,childList:true,characterData:true});
  });
  const page=await context.newPage();
  const traffic={bytes:0,frames:0,prefixes:{},opens:0,closes:0,controls:[],errors:[],link_events:[]};
  page.on('pageerror',error=>traffic.errors.push(error.message));
  page.on('websocket',ws=>{
    const attempt=++traffic.opens;
    traffic.link_events.push({attempt,type:'created',at:Date.now()});
    ws.on('close',()=>{traffic.closes++;traffic.link_events.push({attempt,type:'closed',at:Date.now()});});
    ws.on('socketerror',error=>traffic.link_events.push({attempt,type:'error',at:Date.now(),error}));
    ws.on('framereceived',({payload})=>{
      const data=typeof payload==='string'?Buffer.from(payload):payload;
      traffic.bytes+=data.length;traffic.frames++;
      const prefix=String.fromCharCode(data[0]);traffic.prefixes[prefix]=(traffic.prefixes[prefix]||0)+1;
      if(prefix==='4')try{traffic.controls.push(JSON.parse(data.subarray(1).toString()));}catch{}
    });
  });
  const url=`http://127.0.0.1:${port+10}/?mux=herdr&pane=${encodeURIComponent(pane)}`;
  const cdp=await context.newCDPSession(page);
  const httpStatuses=[];
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketHandshakeResponseReceived',event=>traffic.link_events.push({type:'handshake',at:Date.now(),status:event.response.status}));
  cdp.on('Network.responseReceivedExtraInfo',event=>{if(event.statusCode===304)httpStatuses.push(304);});
  try {
  const response=await page.goto(url,{timeout:90000,waitUntil:'load'});
  const navigation=await page.evaluate(()=>{const e=performance.getEntriesByType('navigation')[0];return {encoded_bytes:e.encodedBodySize,transfer_bytes:e.transferSize,duration_ms:e.duration,status:e.responseStatus};});
  await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent?.includes('MT BENCH READY'),null,{timeout:30000});
  const input=page.locator('.xterm-helper-textarea');
  return {page,context,traffic,port,pane,input,navigation,response,httpStatuses};
  } catch(error) { await context.close();throw error; }
}
async function startSim(run,rate=100) {
  const since=Date.now();
  cli('pane','run',run.pane,`python3 '${path.join(here,'agent-sim.py').replaceAll("'", "'\\''")}' --rate ${rate}`);
  await run.page.waitForFunction(since=>window.__bench.ready>=since,since,{timeout:30000});
}
async function echo(run,timeout=30000) {
  const id=runTag+(++probeNumber).toString(36).padStart(4,'0');
  const start=Date.now();
  await run.input.pressSequentially(`k${id}.`);
  try {
    await run.page.waitForFunction(id=>!!window.__bench.echoes[id],id,{timeout,polling:10});
    const observed=await run.page.evaluate(id=>window.__bench.echoes[id],id);
    return {id,ms:observed-start};
  } catch(error) {
    if(error.name!=='TimeoutError')throw error;
    return {id,ms:timeout,timeout:true};
  }
}
async function recoverEcho(run,timeout=120000) {
  const start=Date.now();const ids=[];
  while(Date.now()-start<timeout) {
    const id=runTag+(++probeNumber).toString(36).padStart(4,'0');ids.push(id);
    await run.input.pressSequentially(`k${id}.`);
    await delay(20);
    const observed=await run.page.evaluate(ids=>{
      const matches=ids.map(id=>window.__bench.echoes[id]).filter(Boolean);
      const overlay=document.querySelector('h3')?.textContent;
      return matches.length&&!/Reconnecting|Disconnected|Connecting/.test(overlay||'')?Math.min(...matches):null;
    },ids);
    if(observed)return {ms:observed-start,probes:ids.length};
  }
  return {ms:timeout,timeout:true,probes:ids.length};
}
async function stopSim(run) {
  const start=Date.now();await run.input.press('Control+c');
  try {
    await run.page.waitForFunction(start=>window.__bench.stopped>=start,start,{timeout:30000,polling:10});
    return {ms:await run.page.evaluate(()=>window.__bench.stopped)-start};
  }catch(error){if(error.name!=='TimeoutError')throw error;return {ms:30000,timeout:true};}
}
async function scenario(port,profile,scene) {
  probeNumber=0;
  let run;
  try {
    run=await newPage(port,profile);
    const {page,traffic}=run;
    if(scene==='S1') {
      const cold=run.navigation;
      await page.reload({waitUntil:'load',timeout:90000});
      const warm=await page.evaluate(()=>{const e=performance.getEntriesByType('navigation')[0];return {encoded_bytes:e.encodedBodySize,transfer_bytes:e.transferSize,duration_ms:e.duration,status:e.responseStatus};});
      return {cold,warm,http_statuses:run.httpStatuses};
    }
    const rate=scene==='S2u'?profileRates[profile]:scene==='CAL'?calibrationRate:scene.startsWith('S5a')?0:100;
    await startSim(run,rate);
    if(scene==='CAL') {
      await delay(5000);
      const before=traffic.bytes;const started=performance.now();
      while (performance.now()-started<sampleMs) await delay(Math.ceil(sampleMs-(performance.now()-started)));
      const measuredMs=performance.now()-started;const bytes=traffic.bytes-before;
      return {rate,measured_ms:measuredMs,ws_down_bytes:bytes,bytes_per_second:bytes*1000/measuredMs};
    }
    if(scene==='S2'||scene==='S2u') {
      await delay(5000);const samples=[];
      for(let i=0;i<20;i++){const sample=await echo(run);samples.push(sample);console.log(JSON.stringify({progress:{port,profile,scene,probe:i+1,...sample}}));await delay(1000);}
      return {rate,...stats(samples)};
    }
    if(scene==='S3') {
      const samples=[];
      for(let i=0;i<5;i++) {
        await delay(5000);samples.push(await stopSim(run));
        if(i<4){if(samples.at(-1).timeout)cli('pane','send-keys',run.pane,'ctrl+c');await startSim(run);}
      }
      return stats(samples);
    }
    if(scene==='S4'||scene==='S4-buffered') {
      await delay(5000);
      if(scene.endsWith('buffered'))await bufferedOutage(port,profile,true);else await blackout(port);
      await delay(10000);
      const before=traffic.bytes;const start=Date.now();
      if(scene.endsWith('buffered'))await bufferedOutage(port,profile,false);else await restore(port);
      const restored=Date.now();const recovery=await recoverEcho(run);
      return {...recovery,ms:restored-start+recovery.ms,restore_started_at:start,restored_at:restored,ws_down_bytes:traffic.bytes-before};
    }
    if(scene.startsWith('S5')) {
      await delay(5000);
      const begin=Date.now();
      if(scene.endsWith('buffered'))await bufferedOutage(port,profile,true);else await blackout(port,scene==='S5c'?'reset_peer':'timeout');
      await delay(scene==='S5c'?1000:40000);
      const observed=await page.evaluate(()=>window.__bench.overlay);
      const before=traffic.bytes;const start=Date.now();
      if(scene.endsWith('buffered'))await bufferedOutage(port,profile,false);else await restore(port);
      const restored=Date.now();const recovery=await recoverEcho(run);
      return {detection_ms:observed>=begin?observed-begin:null,...recovery,recovery_ms:restored-start+recovery.ms,outage_started_at:begin,restore_started_at:start,restored_at:restored,ws_down_bytes:traffic.bytes-before};
    }
    if(scene==='S7') {
      await delay(5000);const start=traffic.bytes;await delay(60000);const busy=traffic.bytes-start;
      await stopSim(run);await startSim(run,0);await delay(2000);
      const idleStart=traffic.bytes;await delay(60000);
      return {busy_bytes:busy,idle_bytes:traffic.bytes-idleStart};
    }
    throw new Error('Unknown scene '+scene);
  } finally {
    if(run){
      results.lastTraffic=run.traffic;
      await run.context.close();
      cli('pane','send-keys',run.pane,'ctrl+c');
    }
    try { await api(`/proxies/mt${port}`,'DELETE'); } catch(error) { console.error('proxy cleanup failed',error.message); }
  }
}
try {
  save();
  outer: for(const port of ports) for(const profile of profiles) for(const scene of scenes) {
    if(stopping||!browser.isConnected())break outer;
    if(scene==='S7'&&profile!=='P0')continue;
    if(results.cases.some(item=>item.port===port&&item.profile===profile&&item.scene===scene&&!item.error))continue;
    console.log(JSON.stringify({starting:{port,profile,scene,time:new Date().toISOString()}}));
    const started=Date.now();let result;
    try{result={port,profile,scene,...await scenario(port,profile,scene)};}
    catch(error){result={port,profile,scene,error:error.stack};}
    result.elapsed_ms=Date.now()-started;result.traffic=results.lastTraffic;delete results.lastTraffic;
    results.cases.push(result);save();console.log(JSON.stringify(result));
  }
} finally { results.finished=new Date().toISOString();save();await browser.close();releaseLock();process.exitCode=stopping?130:results.cases.some(item=>item.error)?1:0; }
