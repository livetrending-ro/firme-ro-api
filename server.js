/**
 * server.js — FirmeRO API Backend (Railway)
 * Funcționalități:
 *  - GET /api/firma/:cui        → date generale ANAF
 *  - GET /api/bilant/:cui       → bilanțuri 10 ani ANAF
 *  - GET /api/search?q=         → căutare după denumire (ANAF + index local)
 *  - GET /api/health            → health check
 */

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;
const ANAF_BASE = 'https://webservicesp.anaf.ro';

// Headers necesare pentru ANAF (blochează request-uri fără User-Agent browser)
const ANAF_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
  'Origin': 'https://www.anaf.ro',
  'Referer': 'https://www.anaf.ro/'
};

// ── MIDDLEWARE ───────────────────────────────────────────
app.use(compression());
app.use(express.json());
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST']
}));

// Rate limiting — 100 req/15min per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Prea multe cereri. Încearcă din nou în 15 minute.' }
});
app.use('/api/', limiter);

// ── IN-MEMORY CACHE ──────────────────────────────────────
const cache = new Map();
const CACHE_TTL = {
  firma: 3600 * 1000,      // 1h
  bilant: 24 * 3600 * 1000, // 24h
  search: 600 * 1000        // 10min
};

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) { cache.delete(key); return null; }
  return entry.val;
}
function cacheSet(key, val, ttl) {
  cache.set(key, { val, exp: Date.now() + ttl });
  // Curăță cache-ul dacă devine prea mare
  if (cache.size > 5000) {
    const now = Date.now();
    for (const [k, v] of cache) { if (v.exp < now) cache.delete(k); }
  }
}

// ── HEALTH CHECK ─────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), cacheSize: cache.size });
});

// ── GET FIRMA BY CUI ─────────────────────────────────────
// ANAF blochează server-to-server. Folosim getcif.dev ca alternativă.
// Dacă eșuează, frontend-ul face direct la ANAF din browser.
app.get('/api/firma/:cui', async (req, res) => {
  const cui = req.params.cui.replace(/\D/g, '');
  if (!cui || cui.length < 4 || cui.length > 10) {
    return res.status(400).json({ error: 'CUI invalid (4-10 cifre)' });
  }

  const cached = cacheGet(`firma_${cui}`);
  if (cached) return res.json({ source: 'cache', data: cached });

  // Încercare 1: getcif.dev (permite server-to-server)
  try {
    const r = await fetch(`https://getcif.dev/api/firma/${cui}`, {
      headers: { 'User-Agent': 'FirmeRO/1.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (r.ok) {
      const json = await r.json();
      if (json && (json.cui || json.cif)) {
        const data = {
          cui: json.cui || json.cif,
          denumire: json.denumire || json.name || json.denumire_firma,
          adresa: json.adresa || json.sediu,
          judet: json.judet,
          localitate: json.localitate || json.oras,
          statusInactivi: (json.stare_inregistrare === 'ACTIV' || json.activ) ? 0 : 1,
          scpTva: json.platitor_tva || json.scpTva,
          dataInregistrare: json.data_inregistrare || json.dataInregistrare,
        };
        cacheSet(`firma_${cui}`, data, CACHE_TTL.firma);
        return res.json({ source: 'getcif', data });
      }
    }
  } catch {}

  // Dacă eșuează — frontend-ul va face direct la ANAF
  return res.status(503).json({
    error: 'Date indisponibile server-side. Frontend-ul va accesa ANAF direct.',
    fallback: true
  });
});

// ── GET BILANT ───────────────────────────────────────────
app.get('/api/bilant/:cui', async (req, res) => {
  const cui = req.params.cui.replace(/\D/g, '');
  if (!cui || cui.length < 4) return res.status(400).json({ error: 'CUI invalid' });

  const cached = cacheGet(`bilant_${cui}`);
  if (cached) return res.json({ source: 'cache', data: cached });

  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 10 }, (_, i) => currentYear - 1 - i);
  const results = [];

  await Promise.allSettled(
    years.map(async (an) => {
      try {
        const r = await fetch(`${ANAF_BASE}/bilant/rest/bilant.php?an=${an}&cui=${cui}`, {
          signal: AbortSignal.timeout(8000)
        });
        if (!r.ok) return;
        const json = await r.json();
        if (json?.i?.length > 0) {
          const mapped = parseIndicatori(json.i);
          results.push({ an, ...mapped });
        }
      } catch {}
    })
  );

  results.sort((a, b) => a.an - b.an);
  cacheSet(`bilant_${cui}`, results, CACHE_TTL.bilant);
  return res.json({ source: 'anaf', data: results });
});

// ── SEARCH BY DENUMIRE ───────────────────────────────────
// Folosim ANAF pentru a valida CUI-uri sugerate
// Dacă query e numeric → direct CUI lookup
// Dacă query e text → returnăm sugestii din cache local + request ANAF pentru CUI-uri cunoscute
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ data: [] });

  const cacheKey = `search_${q.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ source: 'cache', data: cached });

  // Dacă e CUI numeric
  const isCUI = /^\d{4,10}$/.test(q.replace(/\s/g, ''));
  if (isCUI) {
    try {
      const cui = q.replace(/\D/g, '');
      const today = new Date().toISOString().split('T')[0];
      const r = await fetch(`${ANAF_BASE}/PlatitorTvaRest/api/v8/ws/tva`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ cui: parseInt(cui), data: today }]),
        signal: AbortSignal.timeout(8000)
      });
      const json = await r.json();
      const results = (json.found || []).map(f => ({
        cui: f.cui, denumire: f.denumire, adresa: f.adresa,
        judet: f.judet, stare: f.statusInactivi === 0 ? 'ACTIV' : 'INACTIV'
      }));
      cacheSet(cacheKey, results, CACHE_TTL.search);
      return res.json({ source: 'anaf', data: results });
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  }

  // Căutare text — returnăm rezultate din cache-ul serverului
  const textResults = [];
  for (const [key, entry] of cache) {
    if (!key.startsWith('firma_')) continue;
    if (Date.now() > entry.exp) continue;
    const d = entry.val;
    if (d.denumire && d.denumire.toLowerCase().includes(q.toLowerCase())) {
      textResults.push({
        cui: d.cui, denumire: d.denumire, adresa: d.adresa,
        judet: d.judet, stare: d.statusInactivi === 0 ? 'ACTIV' : 'INACTIV'
      });
    }
    if (textResults.length >= 10) break;
  }

  cacheSet(cacheKey, textResults, CACHE_TTL.search);
  return res.json({ source: 'cache', data: textResults });
});

// ── UTILS ────────────────────────────────────────────────
function parseIndicatori(items) {
  const map = {};
  items.forEach(item => { map[item.indicator] = parseFloat(item.val_indicator) || 0; });
  return {
    cifraAfaceri: map['I2'] || 0,
    profitNet: map['I13'] || 0,
    totalActive: map['I1'] || 0,
    capitalPropriu: map['I10'] || 0,
    datoriiTotale: map['I6'] || 0,
    nrAngajati: map['I17'] || 0,
    activeCirculante: map['I3'] || 0,
    datoriiCurente: map['I8'] || 0,
    stocuri: map['I4'] || 0,
    creante: map['I5'] || 0,
    casaConturi: map['I7'] || 0,
    venituriTotale: map['I11'] || 0,
    cheltuieliTotale: map['I12'] || 0,
  };
}

// ── ERROR HANDLER ────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Eroare internă server' });
});

app.use((req, res) => res.status(404).json({ error: 'Endpoint inexistent' }));

// ── START ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 FirmeRO API pornit pe portul ${PORT}`);
});
