const {chromium}=require('/home/fengliang.975/.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright-core');
const fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader','--no-proxy-server']});
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,serviceWorkers:'block'});
 const page=await context.newPage(),logs=[],errors=[];
 page.on('console',msg=>logs.push(msg.text()));page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/user-config',route=>route.fulfill({json:{}}));
 try{
  await page.goto('http://10.37.97.145:17865/');await page.locator('[title="Connected"]').waitFor();
  await page.locator('.xterm-helper-textarea').pressSequentially("printf 'GPU_%s\\n' 'READY'");await page.locator('.xterm-helper-textarea').press('Enter');
  await page.waitForTimeout(300);
  assert.ok(logs.some(s=>s.includes('Using webgl renderer')));
  await page.screenshot({path:'/tmp/mobile-terminal-perf-20261107/gpu-mobile.png'});
  await page.getByRole('button',{name:'Copy viewport',exact:true}).click();
  await page.waitForFunction(()=>document.body.textContent.includes('GPU_READY'));
  assert.deepEqual(errors,[]);
  const result={renderer:'webgl',errors,copyViewHasOutput:true,secureContext:await page.evaluate(()=>isSecureContext),overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)};
  console.log(result);fs.writeFileSync('/tmp/mobile-terminal-perf-20261107/gpu-browser.json',JSON.stringify(result,null,2));
 }finally{await context.close();await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
