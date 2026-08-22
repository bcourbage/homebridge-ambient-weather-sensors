/**
 * Standalone browser harness for the plugin UI — development only,
 * never packed (package.json "files" allowlist).
 *
 * Replicates what Homebridge UI X does around the custom-UI iframe so
 * page behavior can be reproduced and fixed OUTSIDE a live Homebridge:
 *
 *   - serves the COMMITTED homebridge-ui/public bundle, injecting a
 *     fake `window.homebridge` in place of HB UI X's ui.js;
 *   - routes homebridge.request() to the REAL compiled handlers
 *     (homebridge-ui/handlers.js) against a throwaway fixture rig, so
 *     the browser exercises the genuine pipeline;
 *   - reproduces HB UI X's config semantics faithfully, including the
 *     two beta.13-smoke behaviors that broke the editor: the
 *     getPluginConfig() copy is SCHEMA-FORM-CONTAMINATED (materialized
 *     defaults), and updatePluginConfig MERGES via Object.assign;
 *   - the host page (harness.html) iframes the plugin page, mirrors
 *     HB UI X's body theme classes with a toggle, and runs the same
 *     scrollHeight → iframe-height resize loop.
 *
 * Usage:  npm run build && node scripts/ui-harness/serve.mjs [port]
 * Then open http://localhost:8099/
 */
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const publicDir = path.join(repo, 'homebridge-ui', 'public');
const require = createRequire(import.meta.url);
const handlers = require(path.join(repo, 'homebridge-ui', 'handlers.js'));

const port = Number(process.argv[2] ?? 8099);

// ---- Fixture rig: a realistic legacy config (flag on) + discovery.
const rigRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'awn-ui-harness-'));
const persistDir = path.join(rigRoot, 'plugin-data', 'ambient-weather');
await fs.mkdir(persistDir, { recursive: true });
const configPath = path.join(rigRoot, 'config.json');
const MAC = '84:F3:EB:66:D2:67';
const LEGACY_BLOCK = {
  platform: 'AmbientWeatherSensors',
  name: 'Harness WS-2000',
  apiKey: 'harness-api-key',
  applicationKey: 'harness-app-key',
  _sensorMapV2: true,
  temperatureSensors: true,
  humiditySensors: true,
  windSensors: true,
  rainSensors: true,
  uvSensors: true,
  pressureSensors: true,
  extendedSensors: true,
  extendedDisplayMode: 'static',
  thresholds: { windSpeedMph: 25, uv: 3 },
  units: { windSpeed: 'kts' },
  excludeSensors: ['Indoor Dew Point'],
};
await fs.writeFile(configPath, JSON.stringify({
  bridge: { name: 'Harness Bridge' },
  platforms: [LEGACY_BLOCK],
}, null, 4));
const FIELDS = [
  'tempf', 'tempinf', 'humidity', 'humidityin', 'windspeedmph', 'windgustmph',
  'winddir', 'hourlyrainin', 'dailyrainin', 'uv', 'baromrelin', 'baromabsin',
  'solarradiation', 'dewPoint', 'dewPointin', 'lastRain', 'battout', 'battin',
];
await fs.writeFile(path.join(persistDir, 'discovery.json'), JSON.stringify({
  schemaVersion: 1,
  entries: FIELDS.map(dp => ({
    stationMac: MAC, stationName: 'Harness WS-2000', dataPoint: dp,
    firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-08-20T00:00:00Z',
  })),
}));
const deps = {
  persistDir,
  configPath,
  version: 'harness',
  log: {
    info: m => console.log('[handlers]', m),
    warn: m => console.warn('[handlers]', m),
    debug: () => {},
  },
};

// ---- HB UI X config-semantics twin. getPluginConfig serves the
// in-memory copy CONTAMINATED the way the schema form contaminates it;
// updatePluginConfig MERGES (Object.assign); save persists via JSON
// (dropping undefined tombstones), exactly like the real frontend.
let inMemoryBlocks = null;
async function loadBlocks() {
  const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
  return cfg.platforms.filter(b => b && b.platform === 'AmbientWeatherSensors');
}
async function getPluginConfig() {
  if (inMemoryBlocks === null) {
    inMemoryBlocks = (await loadBlocks()).map(b => ({
      ...b,
      // the schema form's materialized defaults
      includeOnly: [],
      stationFilter: [],
    }));
  }
  return inMemoryBlocks;
}
function updatePluginConfig(next) {
  for (let i = 0; i < next.length; i++) {
    if (inMemoryBlocks[i]) {
      Object.assign(inMemoryBlocks[i], next[i]);
    } else {
      inMemoryBlocks[i] = next[i];
    }
  }
  inMemoryBlocks.length = Math.min(inMemoryBlocks.length, next.length);
}
async function savePluginConfig() {
  const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const keep = cfg.platforms.filter(b => !(b && b.platform === 'AmbientWeatherSensors'));
  // JSON round trip mirrors the HTTP PUT: undefined-valued keys drop.
  cfg.platforms = [...keep, ...JSON.parse(JSON.stringify(inMemoryBlocks))];
  await fs.writeFile(configPath, JSON.stringify(cfg, null, 4));
  console.log('[harness] config.json persisted');
}

const ROUTES = {
  '/status': p => handlers.handleGetStatus(deps, p),
  '/discovery': () => handlers.handleGetDiscovery(deps),
  '/notices': () => handlers.handleGetNotices(deps),
  '/ui-state': () => handlers.handleGetUiState(deps),
  '/editor-state': p => handlers.handleGetEditorState(deps, p),
  '/vocabulary': () => handlers.handleGetVocabulary(),
  '/preview-save': p => handlers.handlePreviewSave(deps, p),
  '/compose-save': p => handlers.handleComposeSave(deps, p),
};

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.map': 'application/json',
};

async function body(req) {
  const chunks = [];
  for await (const c of req) {
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const send = (code, data, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  };
  try {
    if (url.pathname.startsWith('/hb/')) {
      const route = ROUTES[url.pathname.slice(3)];
      if (!route) {
        return send(404, { error: 'no such endpoint' });
      }
      return send(200, await route(await body(req)));
    }
    if (url.pathname === '/hb-config/get') {
      return send(200, await getPluginConfig());
    }
    if (url.pathname === '/hb-config/update') {
      updatePluginConfig(await body(req));
      return send(200, { ok: true });
    }
    if (url.pathname === '/hb-config/save') {
      await savePluginConfig();
      return send(200, { ok: true });
    }
    if (url.pathname === '/' || url.pathname === '/harness.html') {
      return send(200, await fs.readFile(path.join(here, 'harness.html')), 'text/html');
    }
    if (url.pathname === '/fake-homebridge.js') {
      return send(200, await fs.readFile(path.join(here, 'fake-homebridge.js')), 'text/javascript');
    }
    if (url.pathname.startsWith('/plugin/')) {
      const rel = url.pathname.slice('/plugin/'.length) || 'index.html';
      const file = path.normalize(path.join(publicDir, rel));
      if (!file.startsWith(publicDir)) {
        return send(403, { error: 'forbidden' });
      }
      let data = await fs.readFile(file);
      if (rel === 'index.html') {
        // Stand in for HB UI X's injected ui.js.
        data = data.toString('utf8')
          .replace('<head>', '<head><script src="/fake-homebridge.js"></script>');
        return send(200, data, 'text/html');
      }
      return send(200, data, MIME[path.extname(file)] ?? 'application/octet-stream');
    }
    send(404, { error: 'not found' });
  } catch (e) {
    console.error('[harness]', req.url, e);
    send(500, { error: String(e && e.message || e) });
  }
});
server.listen(port, () => {
  console.log(`[harness] http://localhost:${port}/  (fixture rig: ${rigRoot})`);
});
