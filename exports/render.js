// Render preloader animation to PNG frames.
// Usage: node render.js [--bg=white|transparent] [--width=1080] [--height=756] [--fps=60] [--duration=4500] [--out=frames]
//
// Each call writes ./frames-<bg>/frame_NNNN.png.
//
// Why we drive setProgress() per frame instead of letting the page run real-time:
// puppeteer screenshots aren't synchronized to rAF — driving progress manually
// guarantees deterministic, evenly-spaced frames.

const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

function parseArgs() {
    const args = {
        bg: 'white',
        width: 1080,
        height: 756,
        fps: 60,
        duration: 4500,
        out: null,
    };
    for (const arg of process.argv.slice(2)) {
        const m = arg.match(/^--([^=]+)=(.+)$/);
        if (!m) continue;
        const [, k, v] = m;
        args[k] = isNaN(Number(v)) ? v : Number(v);
    }
    if (!args.out) args.out = `frames-${args.bg}`;
    return args;
}

(async () => {
    const args = parseArgs();
    const totalFrames = Math.round((args.duration / 1000) * args.fps);
    const outDir = path.resolve(__dirname, args.out);
    fs.mkdirSync(outDir, { recursive: true });
    // Clear any leftover frames from a prior run so frame counts stay correct.
    for (const f of fs.readdirSync(outDir)) {
        if (f.startsWith('frame_')) fs.unlinkSync(path.join(outDir, f));
    }

    console.log(`[render] ${totalFrames} frames @ ${args.fps}fps, bg=${args.bg}, ${args.width}x${args.height}`);

    const browser = await puppeteer.launch({
        defaultViewport: { width: args.width, height: args.height, deviceScaleFactor: 1 },
        args: ['--no-sandbox', '--disable-web-security'],
    });
    const page = await browser.newPage();

    const fileUrl = 'file://' + path.resolve(__dirname, 'preloader/intro.html') + `?bg=${args.bg}`;
    await page.goto(fileUrl, { waitUntil: 'load' });
    await page.waitForFunction('window.__intro_ready === true', { timeout: 10_000 });

    const omitBackground = args.bg === 'transparent';

    for (let i = 0; i <= totalFrames; i++) {
        const t = i / totalFrames;
        await page.evaluate((t) => window.setProgress(t), t);
        const frameNum = String(i).padStart(4, '0');
        await page.screenshot({
            path: path.join(outDir, `frame_${frameNum}.png`),
            type: 'png',
            omitBackground,
            clip: { x: 0, y: 0, width: args.width, height: args.height },
        });
        if (i % 30 === 0) process.stdout.write(`\r[render] frame ${i}/${totalFrames}`);
    }
    process.stdout.write(`\r[render] frame ${totalFrames}/${totalFrames}\n`);

    await browser.close();
    console.log(`[render] wrote ${totalFrames + 1} frames to ${outDir}`);
})();
