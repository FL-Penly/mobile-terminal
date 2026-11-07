const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const label=process.argv[2],size=4*1024*1024,expected=crypto.createHash('sha256').update(Buffer.alloc(size,120)).digest('hex');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function sample(){
 const ws=new WebSocket('ws://127.0.0.1:17865/ws');ws.binaryType='arraybuffer';
 let finished=false,pid,started=0,received=0,prefix='',tail='',digest=crypto.createHash('sha256');
 try{return await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('PTY throughput timed out')),15000);
  ws.addEventListener('error',reject);
  ws.addEventListener('open',()=>{ws.send(JSON.stringify({AuthToken:'',columns:80,rows:24}));ws.send(Buffer.from('0printf "__PTY_PID:%s\\n" "$$"\r'));});
  ws.addEventListener('message',event=>{
   if(finished)return;
   let data=Buffer.from(event.data);if(data[0]!==48)return;data=data.subarray(1);
   if(!started){
    prefix+=data.toString();
    const p=prefix.match(/__PTY_PID:(\d+)/);
    if(p&&!pid){pid=Number(p[1]);prefix='';ws.send(Buffer.from(`0python3 -c 'import os; os.write(1,bytes([66,69,71,73,78,10])); os.write(1,b"x"*${size}); os.write(1,bytes([69,78,68,10]))'\r`));return;}
    const begin=prefix.indexOf('BEGIN\r\n');if(begin<0)return;started=performance.now();data=Buffer.from(prefix.slice(begin+7));prefix='';
   }
   if(received<size){const n=Math.min(size-received,data.length);digest.update(data.subarray(0,n));received+=n;data=data.subarray(n);}
   tail+=data.toString();
   if(received===size&&tail.includes('END\r\n')){finished=true;clearTimeout(timer);const elapsed=performance.now()-started;assert.equal(digest.digest('hex'),expected);resolve({bytes:received,ms:elapsed,MiBps:size/1048576/(elapsed/1000)});}
  });
 });}finally{ws.close();await delay(400);if(pid&&fs.existsSync('/proc/'+pid)){try{process.kill(pid,'SIGHUP')}catch{}}}
}
(async()=>{const samples=[];for(let i=0;i<3;i++)samples.push(await sample());const result={label,samples,medianMiBps:[...samples].map(s=>s.MiBps).sort((a,b)=>a-b)[1]};fs.writeFileSync('/tmp/mobile-terminal-perf-20261107/pty-throughput-'+label+'.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));})().catch(e=>{console.error(e);process.exitCode=1});
