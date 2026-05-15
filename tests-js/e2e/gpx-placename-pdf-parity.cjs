'use strict';

/**
 * Browser E2E: after uploading the Rotterdam marathon GPX fixture, compares
 * (a) unique `ExportUtilities.exportUniqueSymbolKey` values from
 * Mapbox `queryRenderedFeatures` with (b) the count of `data-export-symbol-key`
 * attributes in `SVGExporter.buildSVGString` (same dedupe key as the exporter).
 *
 * Skips with exit 0 when no real Mapbox token is configured, or in CI unless
 * RUN_MAPBOX_E2E=1. Requires: npm install && npx playwright install chromium
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const GPX_FIXTURE = path.join(
    ROOT,
    'tests',
    'files',
    'NN-Marathon-Rotterdam-2026-Marathon-DEF.gpx'
);

function tokenLooksReal(token) {
    if (!token || typeof token !== 'string') return false;
    const t = token.trim();
    if (t.length < 80) return false;
    if (!t.startsWith('pk.')) return false;
    if (/ci-test|test-token/i.test(t)) return false;
    return true;
}

function shouldSkip() {
    const inCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
    if (inCi && process.env.RUN_MAPBOX_E2E !== '1') {
        return 'CI without RUN_MAPBOX_E2E=1';
    }
    if (!tokenLooksReal(process.env.MAPBOX_ACCESS_TOKEN)) {
        return 'MAPBOX_ACCESS_TOKEN missing or not a real pk.* token';
    }
    return null;
}

function waitForHealth(port, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        function tryOnce() {
            const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
                res.resume();
                if (res.statusCode === 200) {
                    resolve();
                    return;
                }
                schedule();
            });
            req.on('error', schedule);
        }
        function schedule() {
            if (Date.now() > deadline) {
                reject(new Error(`Flask did not become healthy on port ${port}`));
                return;
            }
            setTimeout(tryOnce, 400);
        }
        tryOnce();
    });
}

function countExportSymbolKeys(svg) {
    if (!svg || typeof svg !== 'string') return 0;
    const m = svg.match(/data-export-symbol-key="/g);
    return m ? m.length : 0;
}

async function main() {
    const skipReason = shouldSkip();
    if (skipReason) {
        console.log(`SKIP placename parity E2E: ${skipReason}`);
        process.exit(0);
    }

    if (!fs.existsSync(GPX_FIXTURE)) {
        console.error(`Missing GPX fixture: ${GPX_FIXTURE}`);
        process.exit(1);
    }

    const port = Number(process.env.E2E_HTTP_PORT) || 8765;
    const env = {
        ...process.env,
        MAPBOX_ACCESS_TOKEN: process.env.MAPBOX_ACCESS_TOKEN.trim(),
        FLASK_CONFIG: 'development',
    };

    const py = process.platform === 'win32' ? 'python' : 'python3';
    const flaskProc = spawn(
        py,
        [
            '-c',
            `from app import app
app.run(host="127.0.0.1", port=${port}, threaded=False, use_reloader=False)`,
        ],
        {
            cwd: ROOT,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        }
    );

    let stderr = '';
    flaskProc.stderr.on('data', (d) => {
        stderr += d.toString();
    });

    let browser;

    try {
        await waitForHealth(port);

        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
        });
        const page = await context.newPage();
        page.setDefaultTimeout(180000);

        const baseUrl = `http://127.0.0.1:${port}`;
        await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });

        await page.waitForFunction(
            () =>
                window.gpxApp &&
                window.gpxApp.mapManager &&
                typeof window.gpxApp.mapManager.getMap === 'function',
            { timeout: 120000 }
        );

        await page.waitForFunction(
            () => {
                const map = window.gpxApp.mapManager.getMap();
                return map && typeof map.loaded === 'function' && map.loaded();
            },
            { timeout: 120000 }
        );

        await page.waitForFunction(
            () => {
                const map = window.gpxApp.mapManager.getMap();
                return map && typeof map.isStyleLoaded === 'function' && map.isStyleLoaded();
            },
            { timeout: 120000 }
        );

        await page.setInputFiles('#gpxFiles', GPX_FIXTURE);
        await page.click('#uploadBtn');

        await page.waitForFunction(() => (window.gpxApp.uploadedRoutes?.size || 0) > 0, {
            timeout: 120000,
        });

        await page.evaluate(
            () =>
                new Promise((resolve) => {
                    const map = window.gpxApp.mapManager.getMap();
                    const finish = () => resolve(undefined);
                    try {
                        map.once('idle', finish);
                    } catch (_) {
                        finish();
                    }
                    setTimeout(finish, 45000);
                })
        );

        const canvasKeys = await page.evaluate(() => {
            const map = window.gpxApp.mapManager.getMap();
            const z = map.getZoom();
            const feats = map.queryRenderedFeatures();
            const keys = new Set();
            for (const f of feats) {
                const k = ExportUtilities.exportUniqueSymbolKey(f, z);
                if (k) keys.add(k);
            }
            return Array.from(keys);
        });

        const svgInfo = await page.evaluate(async () => {
            const exporter = new SVGExporter(window.gpxApp.mapManager);
            const svg = await exporter.buildSVGString('forex');
            const matches = svg.match(/data-export-symbol-key="([^"]+)"/g) || [];
            const keys = matches.map((m) =>
                m.replace(/^data-export-symbol-key="/, '').replace(/"$/, '')
            );
            return { count: keys.length, keys };
        });

        await context.close();
        await browser.close();
        browser = null;

        const canvasSet = new Set(canvasKeys);
        const svgSet = new Set(svgInfo.keys);
        const droppedFromCanvas = canvasKeys.filter((k) => !svgSet.has(k));
        const extraInSvg = svgInfo.keys.filter((k) => !canvasSet.has(k));

        console.log(`Canvas exportUniqueSymbolKey count (deduped): ${canvasSet.size}`);
        console.log(`SVG data-export-symbol-key count: ${svgInfo.count}`);

        if (droppedFromCanvas.length > 0) {
            console.error(
                `Lost ${droppedFromCanvas.length} canvas label(s) in SVG export (first 10):\n` +
                    droppedFromCanvas.slice(0, 10).map((k) => '  - ' + k).join('\n')
            );
            process.exit(1);
        }
        if (extraInSvg.length > 0) {
            console.error(
                `SVG export contains ${extraInSvg.length} label(s) not on the canvas (first 10):\n` +
                    extraInSvg.slice(0, 10).map((k) => '  - ' + k).join('\n') +
                    '\nSVG/canvas parity is required — neither side may emit extras.'
            );
            process.exit(1);
        }

        console.log('OK: SVG export label set matches the canvas exactly.');
    } catch (e) {
        console.error(stderr.slice(-4000));
        throw e;
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
        }
        flaskProc.kill('SIGTERM');
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
