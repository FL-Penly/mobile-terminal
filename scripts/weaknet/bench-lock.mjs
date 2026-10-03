import fs from 'node:fs';
import path from 'node:path';

const ticks = pid => {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[21]; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

export function acquireBenchLock(state) {
  const lockPath=path.join(state,'bench.lock');
  const owner={pid:process.pid,start_ticks:ticks(process.pid)};
  let descriptor;
  try { descriptor=fs.openSync(lockPath,'wx',0o600); }
  catch(error) {
    if(error.code!=='EEXIST')throw error;
    const saved=JSON.parse(fs.readFileSync(lockPath,'utf8'));
    if(ticks(saved.pid)===saved.start_ticks)throw new Error(`Bench already running as PID ${saved.pid}; do not run measurements or regression concurrently`);
    fs.unlinkSync(lockPath);
    descriptor=fs.openSync(lockPath,'wx',0o600);
  }
  fs.writeFileSync(descriptor,JSON.stringify(owner));fs.closeSync(descriptor);
  return () => {
    try {
      const saved=JSON.parse(fs.readFileSync(lockPath,'utf8'));
      if(saved.pid===owner.pid&&saved.start_ticks===owner.start_ticks)fs.unlinkSync(lockPath);
    }catch(error){if(error.code!=='ENOENT')throw error;}
  };
}
