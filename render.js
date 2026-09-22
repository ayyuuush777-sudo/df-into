const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const VIEW_W = 800;
const VIEW_H = 450;
const DPR = 3.2;
const OUT_W = 2560;
const OUT_H = 1440;
const FPS = 30;

const FRAMES_DIR = path.join(__dirname, 'frames');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main(){
  const htmlPath = path.join(__dirname, 'study-planner.html');
  if(!fs.existsSync(htmlPath)) throw new Error('study-planner.html not found');
  const html = fs.readFileSync(htmlPath, 'utf8');
  console.log('Loaded study-planner.html (' + html.length + ' bytes)');

  let events = [];
  const evPath = path.join(__dirname, 'events.json');
  if(fs.existsSync(evPath)){
    try {
      events = JSON.parse(fs.readFileSync(evPath, 'utf8'));
      if(!Array.isArray(events)) events = [];
      console.log('Found events.json — ' + events.length + ' events');
    } catch(e){ console.log('events.json parse error: ' + e.message); }
  }
  if(!events.length) {
    // No events — build a synthetic scripted event list
    events = buildScriptedEvents();
    console.log('No events.json — using scripted tour with ' + events.length + ' events');
  }

  // Sort by time
  events.sort((a, b) => a.t - b.t);

  // Compute total duration and frame count
  const lastT = events.length ? events[events.length - 1].t : 0;
  const durationMs = lastT + 1200;  // 1.2s tail so last action is visible
  const totalFrames = Math.ceil(durationMs / 1000 * FPS);
  console.log('▶ Duration: ' + (durationMs/1000).toFixed(1) + 's, ' + totalFrames + ' frames @ ' + FPS + 'fps');

  // Fresh frames directory
  if(fs.existsSync(FRAMES_DIR)) fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
  fs.mkdirSync(FRAMES_DIR);

  // Local HTTP server
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log('Server on ' + port);

  // Launch headless Chrome — no Xvfb needed
  console.log('Launching headless Chrome…');
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--font-render-hinting=medium',
      '--force-color-profile=srgb',
      '--disable-features=Translate,ChromeWhatsNewUI,MediaRouter',
      '--disable-component-update',
      '--disable-background-networking',
      '--hide-scrollbars',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({
    width: VIEW_W,
    height: VIEW_H,
    deviceScaleFactor: DPR,
  });

  page.on('dialog', async d => { try { await d.accept(); } catch(e){} });

  // localStorage shim
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('_t','1'); localStorage.removeItem('_t'); }
    catch(e){
      const m = {};
      Object.defineProperty(window, 'localStorage', { configurable: true, value: {
        getItem: k => (k in m ? m[k] : null),
        setItem: (k,v) => { m[k] = String(v); },
        removeItem: k => { delete m[k]; },
        clear: () => { for (const k in m) delete m[k]; },
        key: i => Object.keys(m)[i] || null,
        get length(){ return Object.keys(m).length; },
      }});
    }
  });

  // Hide ambient blobs (huge CPU), install a fake cursor overlay,
  // and freeze the clock (so every frame shows the same time)
  await page.evaluateOnNewDocument(() => {
    // Freeze Date so the clock doesn't tick during long screenshots
    const FROZEN = new Date();
    const _Date = Date;
    function FrozenDate(...args){
      if(args.length) return new _Date(...args);
      return new _Date(FROZEN.getTime());
    }
    FrozenDate.now = () => FROZEN.getTime();
    FrozenDate.parse = _Date.parse;
    FrozenDate.UTC = _Date.UTC;
    FrozenDate.prototype = _Date.prototype;
    window.Date = FrozenDate;

    // Freeze performance.now for animations that use it
    const _perfNow = performance.now.bind(performance);
    const frozenPerf = _perfNow();
    performance.now = () => frozenPerf;
  });

  console.log('Loading page…');
  await page.goto('http://127.0.0.1:' + port + '/', {
    waitUntil: 'networkidle0',
    timeout: 90000,
  });

  try { await page.evaluate(() => document.fonts.ready); } catch(e){}
  await sleep(3500);

  // Inject runtime CSS: hide ambient, pause all animations, style cursor
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = `
      .amb { display: none !important; }
      *, *::before, *::after {
        animation-play-state: paused !important;
        transition-duration: 0.001ms !important;
      }
      #__cursor {
        position: fixed !important;
        width: 22px !important;
        height: 22px !important;
        border-radius: 50% !important;
        border: 2px solid rgba(255,255,255,0.95) !important;
        background: rgba(255,255,255,0.28) !important;
        box-shadow: 0 0 0 5px rgba(255,255,255,0.12), 0 0 10px rgba(0,0,0,0.5) !important;
        pointer-events: none !important;
        z-index: 2147483647 !important;
        transform: translate(-50%, -50%) !important;
        top: -100px !important;
        left: -100px !important;
        transition: none !important;
      }
    `;
    document.head.appendChild(s);

    const cur = document.createElement('div');
    cur.id = '__cursor';
    document.body.appendChild(cur);
  });

  const diag = await page.evaluate(() => ({
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    dpr: window.devicePixelRatio,
  }));
  console.log('▶ Viewport: ' + diag.innerW + 'x' + diag.innerH + ' CSS @ DPR ' + diag.dpr);
  console.log('▶ Output: ' + OUT_W + 'x' + OUT_H + ' physical');

  // ─── FRAME LOOP ───
  console.log('Rendering ' + totalFrames + ' frames…');
  let evIdx = 0;
  let curX = -100, curY = -100;
  const t0 = Date.now();

  for(let frame = 0; frame < totalFrames; frame++){
    const T = frame / FPS * 1000;  // virtual time in ms

    // Apply all events up to T
    while(evIdx < events.length && events[evIdx].t <= T){
      const ev = events[evIdx];
      try {
        await applyEvent(page, ev);
        if(ev.x != null) curX = ev.x;
        if(ev.y != null) curY = ev.y;
      } catch(e){ /* skip */ }
      evIdx++;
    }

    // Position the fake cursor
    await page.evaluate((x, y) => {
      const c = document.getElementById('__cursor');
      if(c){ c.style.left = x + 'px'; c.style.top = y + 'px'; }
    }, curX, curY);

    // Let Chrome settle: two rAFs
    await page.evaluate(() => new Promise(r => {
      requestAnimationFrame(() => requestAnimationFrame(r));
    }));

    // Screenshot
    const frameFile = String(frame).padStart(6, '0') + '.png';
    await page.screenshot({
      path: path.join(FRAMES_DIR, frameFile),
      omitBackground: false,
      captureBeyondViewport: false,
      type: 'png',
    });

    if(frame % 30 === 0){
      const elapsed = (Date.now() - t0) / 1000;
      const perFrame = elapsed / (frame + 1);
      const remaining = (totalFrames - frame) * perFrame;
      console.log('  frame ' + frame + '/' + totalFrames +
                  ' (' + perFrame.toFixed(2) + 's/frame, ETA ' + remaining.toFixed(0) + 's)');
    }
  }

  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('✓ ' + totalFrames + ' frames captured in ' + totalSec + 's');

  await browser.close();
  server.close();

  // ─── ENCODE ───
  console.log('Encoding MP4 with ffmpeg…');
  await new Promise((resolve, reject) => {
    const ff = exec(
      'ffmpeg -y -framerate ' + FPS +
      ' -i ' + path.join(FRAMES_DIR, '%06d.png') +
      ' -c:v libx264 -preset medium -crf 14' +
      ' -pix_fmt yuv420p' +
      ' -colorspace bt709 -color_primaries bt709 -color_trc bt709' +
      ' -movflags +faststart' +
      ' -r ' + FPS +
      ' output.mp4',
      { maxBuffer: 1024 * 1024 * 50 },
      (err, stdout, stderr) => {
        if(err){ console.error(stderr); reject(err); return; }
        resolve();
      }
    );
  });

  const size = fs.statSync('output.mp4').size;
  console.log('✓ output.mp4 — ' + (size / 1048576).toFixed(1) + ' MB at ' + OUT_W + 'x' + OUT_H + ' @ ' + FPS + 'fps');
}

async function applyEvent(page, ev){
  if(ev.type === 'scroll'){
    if(ev.target === 'html' || !ev.target){
      await page.evaluate(top => window.scrollTo(0, top), ev.top || 0);
    } else {
      await page.evaluate((sel, top) => {
        const el = document.querySelector(sel);
        if(el) el.scrollTop = top;
      }, ev.target, ev.top || 0);
    }
  } else if(ev.type === 'click'){
    if(ev.x != null && ev.y != null){
      await page.mouse.click(ev.x, ev.y);
    } else if(ev.target){
      await page.evaluate(sel => {
        const el = document.querySelector(sel);
        if(el){ el.scrollIntoView({ block: 'center' }); el.click(); }
      }, ev.target);
    }
  } else if(ev.type === 'input'){
    await page.evaluate((sel, val) => {
      const el = document.querySelector(sel);
      if(el){
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, ev.target, ev.value);
  }
  // 'move' events only update cursor position — handled in main loop
}

function buildScriptedEvents(){
  // Fallback tour if no events.json exists
  const e = [];
  const push = (t, type, extra) => e.push(Object.assign({ t, type }, extra || {}));
  push(500,  'scroll', { top: 0 });
  push(1500, 'scroll', { top: 400 });
  push(2500, 'scroll', { top: 900 });
  push(3500, 'scroll', { top: 1400 });
  push(4500, 'scroll', { top: 700 });
  push(5500, 'scroll', { top: 0 });
  push(6500, 'click',  { x: 72,  y: 94, target: '.ai-report-btn' });
  push(13000,'click',  { x: 702, y: 48, target: '.mcls' });
  push(14000,'click',  { x: 300, y: 106 });
  push(18000,'click',  { x: 702, y: 48, target: '.mcls' });
  return e;
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
