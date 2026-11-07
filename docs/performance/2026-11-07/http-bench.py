import subprocess, pathlib, sys, time, os, urllib.request, json, statistics, socket
binary,label=sys.argv[1:]
with socket.socket() as sock:
 sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
env=os.environ.copy(); env.update(RUST_TERMINAL_TMUX_SOCKET='mt-perf-isolated-20261107',HERDR_SOCKET_PATH='/tmp/mobile-terminal-perf-20261107/no-herdr.sock')
with open('/tmp/mobile-terminal-perf-20261107/'+label+'.log','w') as log:
 process=subprocess.Popen([binary,'--port',str(port),'--shell','/bin/sh','--static-dir',str(pathlib.Path('frontend/dist').resolve())],env=env,stdout=log,stderr=log)
 try:
  url='http://127.0.0.1:'+str(port)
  for _ in range(100):
   try:
    urllib.request.urlopen(url+'/api/health',timeout=1).read(); break
   except Exception: time.sleep(.1)
  rows=[]
  for i in range(31):
   start=time.perf_counter()
   with urllib.request.urlopen(urllib.request.Request(url+'/',headers={'Accept-Encoding':'gzip'}),timeout=10) as response:
    body=response.read(); etag=response.headers['ETag']
   rows.append((time.perf_counter()-start)*1000)
  start=time.perf_counter()
  try: urllib.request.urlopen(urllib.request.Request(url+'/',headers={'Accept-Encoding':'gzip','If-None-Match':etag}),timeout=10)
  except urllib.error.HTTPError as error: status=error.code
  report=dict(label=label,bytes=len(body),cold_ms=rows[0],warm_median_ms=statistics.median(rows[1:]),warm_p95_ms=sorted(rows[1:])[28],conditional_status=status,conditional_ms=(time.perf_counter()-start)*1000,samples_ms=rows)
  pathlib.Path('/tmp/mobile-terminal-perf-20261107/'+label+'.json').write_text(json.dumps(report,indent=2)); print(json.dumps(report))
 finally:
  process.terminate(); process.wait(timeout=10)
