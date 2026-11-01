// Cache manager for the Kampe Meds Revenue KPI. The heavy lifting (parsing
// the 24MB Odoo orderlines workbook + fuzzy matching against the drug list
// and the Kampe pharmacy list) lives in odoo_meds.py; this module feeds it
// the current Kampe pharmacy names, spawns it when the source files change,
// and serves the cached JSON to the API.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..');
const ORDERLINES_XLSX = path.join(BASE, 'Kampe(DB_connection).xlsx');
const DRUGLIST_XLSX = path.join(BASE, 'Kampe Drug List.xlsx');
const TRAINED_XLSX = path.join(BASE, 'Pharmacies Lolades List.xlsx');
const CACHE = path.join(__dirname, 'odoo_meds_cache.json');
const SCRIPT = path.join(__dirname, 'odoo_meds.py');

let cached = null;
let pending = null;

function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    // Cache stores source mtimes in milliseconds (Node mtimeMs); allow 2s
    // tolerance for filesystem timestamp jitter.
    const fresh =
      j.sources &&
      Math.abs(j.sources.orderlinesMtime - fs.statSync(ORDERLINES_XLSX).mtimeMs) < 2000 &&
      Math.abs(j.sources.druglistMtime - fs.statSync(DRUGLIST_XLSX).mtimeMs) < 2000 &&
      Math.abs((j.sources.loladesMtime || 0) - fs.statSync(TRAINED_XLSX).mtimeMs) < 2000;
    if (fresh) {
      cached = j;
      return j;
    }
  } catch (_) { /* missing or stale cache */ }
  return null;
}

// Runs the python computation once (deduplicating concurrent callers) and
// resolves with the fresh cache. Rejects if the computation fails.
function compute() {
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const py = spawn('python', [SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      py.stderr.on('data', d => { err += d; });
      py.on('error', reject);
      py.on('close', code => {
        pending = null;
        const j = readCache();
        if (code === 0 && j) resolve(j);
        else reject(new Error(err.trim() || `odoo_meds.py exited ${code}`));
      });
    });
  }
  return pending;
}

// Cached value if fresh; otherwise waits for the computation. If the
// recomputation fails (e.g. the workbook is open in Excel and locked), the
// last cache is served with a stale flag rather than failing the request.
async function get() {
  const j = readCache();
  if (j) return j;
  try {
    return await compute();
  } catch (e) {
    try {
      const stale = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
      stale.stale = true;
      return stale;
    } catch (_) {
      throw e;
    }
  }
}

// Warm the cache at startup without blocking the server.
function warm() {
  if (!readCache()) compute().catch(e => console.error('Kampe meds precompute failed:', e.message));
}

module.exports = { get, warm };
