const puppeteer = require('puppeteer');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
const http = require('http');
const fs = require('fs');
const path = require('path');

/* ──────────────────────────────────────────────────────────
   CONFIG — tweak these to change the output
   ────────────────────────────────────────────────────────── */
const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 60;
const DEVICE_SCALE = 2;      // 2 = retina-quality text and gradients
const VIDEO_QUALITY_CRF = 16; // lower = higher quality (16 is visually lossless)
const VIDEO_BITRATE_KBPS = 30000;

async function main() {
  console.log('Reading study-planner.html…');
  const htmlPath = path.join(__dirname, 'study-planner.html');
  if (!fs.existsSync(htmlPath)) {
    throw new Error('study-planner.html not found in repo root. Upload it first.');
  }
  const html = fs.readFileSync(htmlPath, 'utf8');

  // Optional: real recorded events, if events.json is present
  let events = null;
  const eventsPath = path.join(__dirname, 'events.json');
  if (fs.existsSync(eventsPath)) {
    events = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
    console.log(`Found events.json — will replay ${events.length} real events`);
  } else {
    console.log('No events.json — using scripted tour');
  }

  // Spin up a tiny local HTTP server so the page loads over http://
  // (file:// blocks some APIs and makes font loading flaky)
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log(`Local server on port ${port}`);

  console.log('Launching headless Chrome…');
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu-sandbox',
      '--window-size=' + WIDTH + ',' + HEIGHT,
      '--force-device-scale-factor=' + DEVICE_SCALE,
      '--font-render-hinting=none',
      '--disable-web-security',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: DEVICE_SCALE,
  });

  // Swallow any alert/confirm/prompt so nothing blocks the render
  page.on('dialog', async d => { try { await d.accept(); } catch(e) {} });

  // Some environments block localStorage — inject a shim just in case
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('_t','1'); localStorage.removeItem('_t'); }
    catch(e) {
      const m = {};
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
          getItem: k => (k in m ? m[k] : null),
          setItem: (k,v) => { m[k] = String(v); },
          removeItem: k => { delete m[k]; },
          clear: () => { for (const k in m) delete m[k]; },
          key: i => Object.keys(m)[i] || null,
          get length() { return Object.keys(m).length; },
        },
      });
    }
  });

  console.log('Loading page…');
  await page.goto(`http://127.0.0.1:${port}/`, {
    waitUntil: 'networkidle0',
    timeout: 60000,
  });

  // Wait for Google Fonts + Font Awesome to finish
  try { await page.evaluate(() => document.fonts.ready); } catch (e) {}
  await new Promise(r => setTimeout(r, 2500));

  console.log('Starting recorder…');
  const recorder = new PuppeteerScreenRecorder(page, {
    followNewTab: false,
    fps: FPS,
    videoFrame: { width: WIDTH, height: HEIGHT },
    videoCrf: VIDEO_QUALITY_CRF,
    videoCodec: 'libx264',
    videoPreset: 'slow',
    videoBitrate: VIDEO_BITRATE_KBPS,
    aspectRatio: '16:9',
  });

  await recorder.start('./output.mp4');

  try {
    if (events && events.length) {
      await replayEvents(page, events);
    } else {
      await scriptedTour(page);
    }
  } catch (err) {
    console.error('Tour error:', err);
  }

  // Give the last frame a moment before stopping
  await new Promise(r => setTimeout(r, 1200));

  console.log('Stopping recorder…');
  await recorder.stop();
  await browser.close();
  server.close();

  const size = fs.statSync('./output.mp4').size;
  console.log(`✓ output.mp4 generated — ${(size / 1048576).toFixed(1)} MB`);
}

/* ──────────────────────────────────────────────────────────
   SCRIPTED TOUR — used when there's no events.json.
   Plays a clean, predictable demo of the app.
   ────────────────────────────────────────────────────────── */
async function scriptedTour(page) {
  console.log('Running scripted tour…');

  // 1. Hold on the top of the dashboard
  await sleep(2000);

  // 2. Slow scroll all the way down (shows the whole app)
  await smoothScroll(page, 'down', 6000);
  await sleep(800);

  // 3. Scroll back to top
  await smoothScroll(page, 'up', 3000);
  await sleep(500);

  // 4. Open the AI Report
  await safeClick(page, '.ai-report-btn');
  await sleep(6500); // loading animation + reveal

  // 5. Close it
  await safeClick(page, '.mcls');
  await sleep(700);

  // 6. Open My Hold
  await safeClick(page, '.bhold');
  await sleep(2500);
  await safeClick(page, '.mcls');
  await sleep(700);

  // 7. Open PW Schedule
  await safeClick(page, '.bpw');
  await sleep(2500);
  await safeClick(page, '.mcls');
  await sleep(700);

  // 8. Open Profile
  await safeClick(page, '.btn.bp:not(.ai-report-btn)'); // fallback
  await sleep(2500);

  // 9. Hold on the final frame
  await sleep(1500);
}

/* Smooth scrolling that looks natural on video */
async function smoothScroll(page, direction, durationMs) {
  await page.evaluate(async (dir, dur) => {
    const max = document.body.scrollHeight - window.innerHeight;
    const start = window.scrollY;
    const end = dir === 'down' ? max : 0;
    const steps = Math.max(40, Math.round(dur / 25));
    const dt = dur / steps;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // ease in-out
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      window.scrollTo(0, start + (end - start) * e);
      await new Promise(r => setTimeout(r, dt));
    }
  }, direction, durationMs);
}

async function safeClick(page, selector) {
  try {
    await page.waitForSelector(selector, { timeout: 2000 });
    await page.click(selector);
  } catch (e) {
    console.log(`(skip) could not click ${selector}`);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ──────────────────────────────────────────────────────────
   EVENT REPLAY — used when events.json is present.
   Replays your actual scrolls, taps and clicks at the original
   timestamps, in the original order.
   ────────────────────────────────────────────────────────── */
async function replayEvents(page, events) {
  console.log('Replaying recorded events…');
  events.sort((a, b) => a.t - b.t);

  const start = Date.now();

  for (const ev of events) {
    const wait = ev.t - (Date.now() - start);
    if (wait > 0) await sleep(wait);

    try {
      if (ev.type === 'scroll') {
        await page.evaluate(top => window.scrollTo(0, top), ev.top || 0);
      } else if (ev.type === 'click') {
        if (ev.x != null && ev.y != null) {
          await page.mouse.click(ev.x, ev.y);
        } else if (ev.target) {
          await page.evaluate(sel => {
            const el = document.querySelector(sel);
            if (el) {
              el.scrollIntoView({ block: 'center' });
              el.click();
            }
          }, ev.target);
        }
      } else if (ev.type === 'move') {
        if (ev.x != null && ev.y != null) {
          await page.mouse.move(ev.x, ev.y);
        }
      } else if (ev.type === 'input') {
        await page.evaluate((sel, val) => {
          const el = document.querySelector(sel);
          if (el) {
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, ev.target, ev.value);
      }
    } catch (e) {
      console.log(`(skip event ${ev.type}): ${e.message}`);
    }
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});