"""Optional live Chromium/WebRTC test. Requires Python playwright + Chromium.
No game rendering, no fake RTCPeerConnection, no changes to the shipped Mesh.
Run from repository root: python test/webrtc-smoke.py
"""
import json, os, pathlib, re, shutil, subprocess
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parents[1]
modules = json.loads(re.search(r'<script id="__pw_modules__" type="application/json">(.*?)</script>', (root / 'public/index.html').read_text(), re.S).group(1))
source = modules['@pw/src/net/mesh.js']
server = subprocess.Popen(['node', 'test/webrtc-server.mjs'], cwd=root, stdout=subprocess.PIPE, text=True)
try:
    port = int(server.stdout.readline().strip())
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'), headless=True, args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-features=WebRtcHideLocalIpsWithMdns'])
        contexts, pages = [], []
        def player(code):
            ctx = browser.new_context(); contexts.append(ctx)
            pg = ctx.new_page(); pages.append(pg)
            pg.goto(f'http://127.0.0.1:{port}/')
            pg.evaluate('''async ({source,code}) => {
              const { Mesh } = await import(URL.createObjectURL(new Blob([source],{type:'text/javascript'})));
              window.received=[]; window.rosters=[]; window.closedReason=null;
              window.mesh = new Mesh({joined(){},status(list){rosters.push(list)},peer(){},departed(){},snapshot(){},packet(peer,data,lane){received.push({from:peer.id,data,lane})},closed(reason){closedReason=reason}});
              mesh.join(code);
            }''', {'source':source, 'code':code})
            pg.wait_for_function('mesh.active || closedReason !== null', timeout=60000)
            assert pg.evaluate('mesh.active'), pg.evaluate('closedReason')
            return pg
        def check_full(players):
            n = len(players)
            for pg in players:
                pg.wait_for_function('n => mesh.peers.size === n-1 && [...mesh.peers.values()].every(p => p.admitted && p.hello && p.data.readyState === "open" && p.pose.readyState === "open")', arg=n, timeout=20000)
            for i,pg in enumerate(players):
                pg.evaluate('i=>{mesh.broadcast({type:"magic-test",caster:i}); mesh.broadcast({type:"pose-test",caster:i},"pose")}', i)
            for pg in players:
                pg.wait_for_function('n=>new Set(received.filter(m=>m.data.type==="magic-test").map(m=>m.from)).size===n-1', arg=n, timeout=10000)
                assert pg.evaluate('''async () => {for (const p of mesh.peers.values()) { const stats=await p.pc.getStats(); for(const s of stats.values()) if ((s.type==='local-candidate'||s.type==='remote-candidate')&&s.candidateType==='relay') return false; } return true;}''')
        a=player(''); code=a.evaluate('mesh.code'); print('Room created:',code,flush=True)
        b=player(code); print('Second player admitted',flush=True)
        c=player(code); print('Third player admitted',flush=True)
        d=player(code); print('Fourth player admitted',flush=True)
        check_full([a,b,c,d]); print('PASS: 4 independent browser contexts, 6 real WebRTC links, direct DataChannel message delivery, no relay candidates',flush=True)
        a.evaluate('mesh.leave()'); a.close()
        for pg in [b,c,d]:
            pg.wait_for_function('mesh.peers.size===2 && mesh.active',timeout=10000)
            pg.evaluate('received=[]')
        e=player(code); check_full([b,c,d,e]); print('PASS: creator departed, new player joined, full mesh restored',flush=True)
        browser.close()
finally:
    server.terminate()
    try: server.wait(timeout=5)
    except subprocess.TimeoutExpired: server.kill()
