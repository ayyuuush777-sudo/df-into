const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

// Both Xvfb and Chrome use this exact size. No scaling.
const W = 2560;
const H = 1440;
const FPS = 60;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function xdo(args){
  return new Promise(resolve => {
    exec('xdotool ' + args, { env: { ...process.env, DISPLAY: ':99' } }, () => resolve());
  });
}

async function main(){
  const htmlPath = path.join(__dirname, 'study-planner.html');
  if(!fs.existsSync(htmlPath)) throw new Error('study-planner.html not found');
  const html = fs.readFileSync(htmlPath, 'utf8');
  console.log('Loaded study-planner.html (' + html.length + ' bytes)');

  let events = null;
  const evPath = path.join(__dirname, 'events.json');
  if(fs.existsSync(evPath)){
    try{
      events = JSON.parse(fs.readFileSync(evPath, 'utf8'));
      if(!Array.isArray(events)) events = null;
      else console.log('Found events.json — ' + events.length + ' events');
    }catch(e){ console.log('events.json parse error'); }
  }
  if(!events) console.log('No events.json — scripted tour');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log('Server on ' + port);

  console.log('Launching Chrome at native ' + W + 'x' + H + ' (DPR 1, no scaling)…');
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: false,
    defaultViewport: null,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=' + W + ',' + H,
      '--window-position=0,0',
      '--force-device-scale-factor=1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
      '--hide-scrollbars',
      '--disable-features=Translate,ChromeWhatsNewUI,MediaRouter',
      '--disable-component-update',
      '--disable-background-networking',
      '--start-maximized',
      // Font rendering: use full subpixel AA, no hinting tricks
      '--font-render-hinting=medium',
      '--enable-font-antialiasing',
      '--disable-lcd-text=false',
    ],
  });

  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  await page.setViewport({
    width: W,
    height: H,
    deviceScaleFactor: 1,
  });

  page.on('dialog', async d => { try { await d.accept(); } catch(e){} });

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

  console.log('Loading page…');
  await page.goto('http://127.0.0.1:' + port + '/', {
    waitUntil: 'networkidle0',
    timeout: 90000,
  });

  try { await page.evaluate(() => document.fonts.ready); } catch(e){}
  await sleep(5000);

  const diag = await page.evaluate(() => ({
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    dpr: window.devicePixelRatio,
  }));
  console.log('▶ Viewport: ' + diag.innerW + 'x' + diag.innerH + ' CSS @ DPR ' + diag.dpr);
  console.log('▶ Native render: ' + (diag.innerW * diag.dpr) + 'x' + (diag.innerH * diag.dpr) + ' physical px');
  console.log('▶ Expected: ' + W + 'x' + H + ' — should match above');

  console.log('Starting ffmpeg (native, no scaling)…');
  const ffmpeg = spawn('ffmpeg', [
    '-y',
    '-f', 'x11grab',
    '-framerate', String(FPS),
    '-video_size', W + 'x' + H,
    '-draw_mouse', '1',
    '-i', ':99',
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '12',
    '-tune', 'film',
    '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-movflags', '+faststart',
    '-r', String(FPS),
    'output.mp4',
  ], {
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env, DISPLAY: ':99' },
  });

  await sleep(3000);

  try{
    if(events && events.length) await replayEvents(page, events);
    else await scriptedTour(page);
  }catch(e){ console.error('Replay error:', e); }

  await sleep(1500);
  console.log('Stopping ffmpeg…');
  ffmpeg.stdin.write('q');
  await new Promise(r => ffmpeg.on('exit', r));

  await browser.close();
  server.close();
  const size = fs.statSync('output.mp4').size;
  console.log('✓ output.mp4 — ' + (size / 1048576).toFixed(1) + ' MB at ' + W + 'x' + H + ' @ ' + FPS + 'fps');
}

async function replayEvents(page, events){
  console.log('Replaying ' + events.length + ' events…');
  events.sort((a, b) => a.t - b.t);
  const t0 = Date.now();
  for(const ev of events){
    const wait = ev.t - (Date.now() - t0);
    if(wait > 0) await sleep(wait);
    try{
      if(ev.type === 'scroll'){
        if(ev.target === 'html' || !ev.target){
          await page.evaluate(top => window.scrollTo(0, top), ev.top || 0);
        } else {
          await page.evaluate((sel, top) => {
            const el = document.querySelector(sel); if(el) el.scrollTop = top;
          }, ev.target, ev.top || 0);
        }
      } else if(ev.type === 'click'){
        if(ev.x != null && ev.y != null){
          await xdo('mousemove ' + ev.x + ' ' + ev.y);
          await sleep(30);
          await page.mouse.click(ev.x, ev.y);
        } else if(ev.target){
          await page.evaluate(sel => {
            const el = document.querySelector(sel);
            if(el){ el.scrollIntoView({ block: 'center' }); el.click(); }
          }, ev.target);
        }
      } else if(ev.type === 'move'){
        if(ev.x != null && ev.y != null) await xdo('mousemove ' + ev.x + ' ' + ev.y);
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
    }catch(e){ console.log('skip ' + ev.type + ': ' + e.message); }
  }
}

async function scriptedTour(page){
  console.log('Scripted tour…');
  await sleep(2500);
  await page.evaluate(async () => {
    const max = document.body.scrollHeight - window.innerHeight;
    for(let i = 0; i <= 200; i++){
      const t = i / 200;
      const e = t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t+2,2)/2;
      window.scrollTo(0, max * e);
      await new Promise(r => setTimeout(r, 30));
    }
  });
  await sleep(1200);
  await page.evaluate(async () => {
    const start = window.scrollY;
    for(let i = 0; i <= 150; i++){
      const t = i / 150;
      const e = t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t+2,2)/2;
      window.scrollTo(0, start * (1 - e));
      await new Promise(r => setTimeout(r, 25));
    }
  });
  await sleep(700);
  const click = async sel => { try { await page.click(sel); return true; } catch(e){ return false; } };
  await click('.ai-report-btn'); await sleep(7500);
  await click('.mcls'); await sleep(900);
  await click('.bhold'); await sleep(3200);
  await click('.mcls'); await sleep(900);
  await click('.bpw'); await sleep(3200);
  await sleep(1500);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
