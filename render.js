const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

const W = 1920;
const H = 1080;
const FPS = 60;
const CRF = 14;
const PRESET = 'medium';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function xdo(args){
  return new Promise(resolve => {
    exec('xdotool ' + args, { env: { ...process.env, DISPLAY: ':99' } }, () => resolve());
  });
}

/* Fill the full recording frame — injected at render time only,
   your study-planner.html file is untouched. */
const FILL_STYLES = `
  html, body { width: 100% !important; max-width: none !important; overflow-x: hidden !important; }
  .shell { max-width: none !important; width: 100% !important; padding-left: 40px !important; padding-right: 40px !important; }
  [style*="max-width"] { max-width: none !important; }
  .amb { display: none !important; }
`;

async function main(){
  const htmlPath = path.join(__dirname, 'study-planner.html');
  if(!fs.existsSync(htmlPath)) throw new Error('study-planner.html not found');
  const html = fs.readFileSync(htmlPath, 'utf8');
  console.log('Loaded HTML (' + html.length + ' bytes)');
  console.log('Target: ' + W + 'x' + H + ' @ ' + FPS + 'fps · CRF ' + CRF);

  let events = null;
  const evPath = path.join(__dirname, 'events.json');
  if(fs.existsSync(evPath)){
    try{
      events = JSON.parse(fs.readFileSync(evPath, 'utf8'));
      if(!Array.isArray(events)) events = null;
      else console.log('events.json — ' + events.length + ' events');
    }catch(e){}
  }
  if(!events) console.log('No events.json — scripted tour');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  console.log('Launching Chrome…');
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: false,
    defaultViewport: null,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu-sandbox',
      '--window-size=' + W + ',' + H,
      '--window-position=0,0',
      '--start-maximized',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--disable-features=Translate,ChromeWhatsNewUI,MediaRouter',
      '--disable-component-update',
      '--disable-background-networking',
    ],
  });

  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();

  try{
    const winId = await new Promise(res => {
      exec("xdotool search --onlyvisible --class 'google-chrome' | head -n1",
        { env: { ...process.env, DISPLAY: ':99' } },
        (err, stdout) => res(stdout.trim())
      );
    });
    if(winId){
      await xdo('windowsize ' + winId + ' ' + W + ' ' + H);
      await xdo('windowmove ' + winId + ' 0 0');
    }
  }catch(e){}

  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

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
    timeout: 60000,
  });

  try { await page.evaluate(() => document.fonts.ready); } catch(e){}
  await page.addStyleTag({ content: FILL_STYLES });
  await sleep(3500);

  const vp = await page.evaluate(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
    shellW: document.querySelector('.shell') ? document.querySelector('.shell').offsetWidth : null,
  }));
  console.log('Viewport: ' + vp.w + 'x' + vp.h + ' · .shell width: ' + vp.shellW);

  console.log('Starting ffmpeg…');
  const ffmpeg = spawn('ffmpeg', [
    '-y',
    '-f', 'x11grab',
    '-framerate', String(FPS),
    '-video_size', W + 'x' + H,
    '-draw_mouse', '1',
    '-i', ':99',
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-vf', 'scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease,pad=' + W + ':' + H + ':(ow-iw)/2:(oh-ih)/2:color=black,setsar=1',
    '-c:v', 'libx264',
    '-preset', PRESET,
    '-crf', String(CRF),
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-level', '4.2',
    '-maxrate', '30M',
    '-bufsize', '60M',
    '-g', String(FPS * 2),
    '-r', String(FPS),
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-ac', '2',
    '-shortest',
    '-movflags', '+faststart',
    'output.mp4',
  ], {
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env, DISPLAY: ':99' },
  });

  await sleep(2500);

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
  console.log('✓ output.mp4 — ' + (size / 1048576).toFixed(1) + ' MB');
}

async function replayEvents(page, events){
  console.log('Replaying ' + events.length + ' events…');
  events.sort((a, b) => a.t - b.t);
  const t0 = Date.now();

  // No scaling — render is 1920x1080, same as where events were recorded
  for(const ev of events){
    const wait = ev.t - (Date.now() - t0);
    if(wait > 0) await sleep(wait);

    try{
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
        if(ev.x != null && ev.y != null){
          await xdo('mousemove ' + ev.x + ' ' + ev.y);
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
    }catch(e){ console.log('skip ' + ev.type + ': ' + e.message); }
  }
  console.log('Replay complete');
}

async function scriptedTour(page){
  console.log('Scripted tour…');
  await sleep(2000);
  await page.evaluate(async () => {
    const max = document.body.scrollHeight - window.innerHeight;
    const steps = 200, dt = 30;
    for(let i = 0; i <= steps; i++){
      const t = i / steps;
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      window.scrollTo(0, max * e);
      await new Promise(r => setTimeout(r, dt));
    }
  });
  await sleep(1000);
  await page.evaluate(async () => {
    const start = window.scrollY;
    const steps = 150, dt = 25;
    for(let i = 0; i <= steps; i++){
      const t = i / steps;
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      window.scrollTo(0, start * (1 - e));
      await new Promise(r => setTimeout(r, dt));
    }
  });
  await sleep(500);
  const click = async sel => { try { await page.click(sel); return true; } catch(e){ return false; } };
  await click('.ai-report-btn');  await sleep(7000);
  await click('.mcls');           await sleep(800);
  await click('.bhold');          await sleep(3000);
  await click('.mcls');           await sleep(800);
  await click('.bpw');            await sleep(3000);
  await sleep(1500);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
