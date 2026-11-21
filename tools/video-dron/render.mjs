#!/usr/bin/env node
/**
 * Renderiza la animación del dron (index.html) a MP4, cuadro a cuadro.
 *
 *   node tools/video-dron/render.mjs                    → out/vigia-dron.mp4 (1920×1080, 30 fps)
 *   node tools/video-dron/render.mjs --stills 2,8,20,30  → out/still-<t>.png (revisión rápida)
 *   node tools/video-dron/render.mjs --serve             → http://localhost:8767/?play (vista en vivo)
 *   opciones: --fps 30 --from 0 --to 38 --out out/x.mp4
 *
 * Requiere ffmpeg en el PATH y Playwright (ya está en node_modules de vigia).
 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { extname, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const THREE_DIR = resolve(HERE, "../../node_modules/three/build");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1]; };
const has = (k) => args.includes(`--${k}`);

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".woff2": "font/woff2", ".png": "image/png" };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let file = url.pathname === "/" ? join(HERE, "index.html") : url.pathname.startsWith("/three/")
    ? join(THREE_DIR, url.pathname.slice(7)) : join(HERE, url.pathname);
  if (!file.startsWith(HERE) && !file.startsWith(THREE_DIR)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(await readFile(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(Number(opt("port", has("serve") ? 8767 : 0)), "127.0.0.1", r));
const port = server.address().port;

if (has("serve")) { console.log(`Vista en vivo: http://localhost:${port}/?play`); await new Promise(() => {}); }

const browser = await chromium.launch({
  args: ["--use-angle=vulkan", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.error("[página]", m.text()); });
page.on("pageerror", (e) => console.error("[página]", e.message));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.ready);
await page.evaluate(() => window.ready);
const gl = await page.evaluate(() => { const g = document.getElementById("gl").getContext("webgl2"); const d = g.getExtension("WEBGL_debug_renderer_info"); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?"; });
console.log("GPU:", gl);

await mkdir(join(HERE, "out"), { recursive: true });
const shot = () => page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1920, height: 1080 } });

if (has("stills")) {
  for (const t of opt("stills", "").split(",").map(Number)) {
    await page.evaluate((x) => window.renderAt(x), t);
    const out = join(HERE, "out", `still-${t}.png`);
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
    console.log(out);
  }
} else {
  const fps = Number(opt("fps", 30));
  const from = Number(opt("from", 0));
  const to = Number(opt("to", await page.evaluate(() => window.DURATION)));
  const out = resolve(HERE, opt("out", "out/vigia-dron.mp4"));
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
  const n = Math.round((to - from) * fps);
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    await page.evaluate((x) => window.renderAt(x), from + i / fps);
    const buf = await shot();
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    if (i % 30 === 0) process.stdout.write(`\rcuadro ${i}/${n} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  console.log(`\n${out}`);
}
await browser.close();
server.close();
