const fs=require('node:fs');

const serverPid=fs.readdirSync('/proc').find(id=>{try{const a=fs.readFileSync('/proc/'+id+'/cmdline','utf8').split('\0');return a.includes('17865')&&a[0].endsWith('rust-terminal')}catch{return false}});
if(!serverPid)throw Error('Isolated port 17865 server not found');
const resources=()=>({fds:fs.readdirSync('/proc/'+serverPid+'/fd').length,threads:fs.readdirSync('/proc/'+serverPid+'/task').length});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const before=resources(), children=[];
 for(let i=0;i<3;i++){
  const ws=new WebSocket('ws://127.0.0.1:17865/ws');ws.binaryType='arraybuffer';
  const pid=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('PTY response timed out')),5000);let output='';
   ws.addEventListener('error',reject);ws.addEventListener('open',()=>{ws.send(JSON.stringify({AuthToken:'',columns:80,rows:24}));ws.send(Buffer.from('0printf "__PTY_PID:%s\\n" "$$"\r'));});
   ws.addEventListener('message',event=>{const data=Buffer.from(event.data);if(data[0]!==48)return;output+=data.subarray(1).toString();const m=output.match(/__PTY_PID:(\d+)/);if(m){clearTimeout(timer);resolve(Number(m[1]));}});
  });
  children.push(pid);ws.close();await sleep(500);
 }
 await sleep(1000);
 const report={serverPid:Number(serverPid),before,after:resources(),children,alive:children.filter(pid=>fs.existsSync('/proc/'+pid)),at:new Date().toISOString()};
 console.log(JSON.stringify(report,null,2));fs.writeFileSync('/tmp/mobile-terminal-perf-20261107/pty-'+process.argv[2]+'.json',JSON.stringify(report,null,2));
 for(const pid of report.alive){try{process.kill(pid,'SIGHUP')}catch{}}
})();
