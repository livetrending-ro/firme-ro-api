/**
 * server.js — FirmeRO API Backend (Railway)
 * Proxy complet pentru ANAF — rezolvă CORS și accesul din file://
 */

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import fetch from 'node-fetch';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 3000;
const ANAF_TVA_URL = 'https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva';
const ANAF_BILANT_URL = 'https://webservicesp.anaf.ro/bilant';

// Agent HTTPS cu keepAlive pentru performanță
const httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

// Headers care mimează un browser real — ANAF blochează altfel
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  'Origin': 'https://www.anaf.ro',
  'Referer': 'https://www.anaf.ro/',
};

// ── MIDDLEWARE ───────────────────────────────────────────
app.use(compression());
app.use(express.json());
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.options('*', cors());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Prea multe cereri. Încearcă din nou în 15 minute.' }
});
app.use('/api/', limiter);

// ── IN-MEMORY CACHE ──────────────────────────────────────
const cache = new Map();
function cacheGet(key) {
  const e = cache.get(key);
  if (!e || Date.now() > e.exp) { cache.delete(key); return null; }
  return e.val;
}
function cacheSet(key, val, ttlMs) {
  if (cache.size > 10000) {
    const now = Date.now();
    for (const [k, v] of cache) if (v.exp < now) cache.delete(k);
  }
  cache.set(key, { val, exp: Date.now() + ttlMs });
}

// ── HEALTH CHECK ─────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()), cacheSize: cache.size, version: '2.0' });
});

// ── PROXY ANAF TVA → GET /api/firma/:cui ─────────────────
// Acesta e un proxy pur — trimite requestul la ANAF în numele browser-ului
app.get('/api/firma/:cui', async (req, res) => {
  const cui = req.params.cui.replace(/\D/g, '');
  if (!cui || cui.length < 4 || cui.length > 10)
    return res.status(400).json({ error: 'CUI invalid' });

  const cKey = `f_${cui}`;
  const cached = cacheGet(cKey);
  if (cached) return res.json({ source: 'cache', data: cached });

  const today = new Date().toISOString().split('T')[0];
  const body = JSON.stringify([{ cui: parseInt(cui), data: today }]);

  // Încearcă ANAF direct (proxy)
  try {
    const r = await fetch(ANAF_TVA_URL, {
      method: 'POST',
      headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json' },
      body,
      agent: httpsAgent,
      signal: AbortSignal.timeout(12000)
    });
    if (r.ok) {
      const json = await r.json();
      
      // Dacă CUI-ul a fost validat ca inexistent de ANAF
      if (json?.notFound?.includes(parseInt(cui))) {
        return res.status(404).json({ error: 'Firma nu a fost găsită în baza de date ANAF.' });
      }

      const f = json?.found?.[0];
      if (f && f.date_generale && f.date_generale.cui) {
        const mapped = {
          cui: f.date_generale.cui,
          denumire: f.date_generale.denumire,
          adresa: f.date_generale.adresa,
          judet: f.adresa_sediu_social?.sdenumire_Judet || '',
          localitate: f.adresa_sediu_social?.sdenumire_Localitate || '',
          statusInactivi: f.stare_inactiv?.statusInactivi ? 1 : 0,
          scpTva: f.inregistrare_scop_Tva?.scpTVA ? 'DA' : 'NU',
          dataInregistrare: f.date_generale.data_inregistrare,
          stare_inregistrare: f.date_generale.stare_inregistrare,
          telefon: f.date_generale.telefon,
          codCaen: f.date_generale.cod_CAEN
        };
        cacheSet(cKey, mapped, 3600_000);
        return res.json({ source: 'anaf', data: mapped });
      }
    }
    console.log(`ANAF TVA status: ${r.status} for CUI ${cui}`);
  } catch (e) {
    console.log(`ANAF TVA error: ${e.message}`);
  }

  // Fallback: getcif.ro (API public românesc)
  try {
    const r2 = await fetch(`https://api.mfinante.gov.ro/opendata/regFiscRec/firme/${cui}`, {
      headers: { ...BROWSER_HEADERS, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (r2.ok) {
      const j2 = await r2.json();
      if (j2 && (j2.cui || j2.cif)) {
        const data = normalizeMFinante(j2);
        cacheSet(cKey, data, 3600_000);
        return res.json({ source: 'mfinante', data });
      }
    }
  } catch {}

  // Fallback final: date minime din ONRC Open Data
  return res.status(503).json({
    error: 'Date ANAF indisponibile temporar. Reîncercați sau accesați direct webservicesp.anaf.ro',
    fallback: true,
    cui
  });
});

// ── PROXY ANAF BILANT → GET /api/bilant/:cui ─────────────
app.get('/api/bilant/:cui', async (req, res) => {
  const cui = req.params.cui.replace(/\D/g, '');
  if (!cui || cui.length < 4) return res.status(400).json({ error: 'CUI invalid' });

  const cKey = `b_${cui}`;
  const cached = cacheGet(cKey);
  if (cached) return res.json({ source: 'cache', data: cached });

  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 10 }, (_, i) => currentYear - 1 - i);
  const results = [];

  await Promise.allSettled(years.map(async (an) => {
    try {
      const r = await fetch(`${ANAF_BILANT_URL}?an=${an}&cui=${cui}`, {
        headers: BROWSER_HEADERS,
        agent: httpsAgent,
        signal: AbortSignal.timeout(10000)
      });
      if (!r.ok) return;
      const json = await r.json();
      if (json?.i?.length > 0) results.push({ an, ...parseIndicatori(json.i) });
    } catch {}
  }));

  results.sort((a, b) => a.an - b.an);
  cacheSet(cKey, results, 86400_000); // 24h
  return res.json({ source: 'anaf', data: results });
});

// ── SEARCH ───────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ data: [] });

  const cKey = `s_${q.toLowerCase()}`;
  const cached = cacheGet(cKey);
  if (cached) return res.json({ source: 'cache', data: cached });

  // CUI numeric → lookup direct
  if (/^\d{4,10}$/.test(q)) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const r = await fetch(ANAF_TVA_URL, {
        method: 'POST',
        headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ cui: parseInt(q), data: today }]),
        agent: httpsAgent,
        signal: AbortSignal.timeout(10000)
      });
      if (r.ok) {
        const json = await r.json();
        const results = (json.found || []).map(f => {
          const dg = f.date_generale || {};
          const adr = f.adresa_sediu_social || {};
          const st = f.stare_inactiv || {};
          return {
            cui: dg.cui, 
            denumire: dg.denumire, 
            adresa: dg.adresa,
            judet: adr.sdenumire_Judet || '', 
            stare: st.statusInactivi === false ? 'ACTIV' : 'INACTIV'
          };
        });
        cacheSet(cKey, results, 600_000);
        return res.json({ source: 'anaf', data: results });
      }
    } catch {}
  }

  // Text search din cache intern
  const hits = [];
  for (const [k, e] of cache) {
    if (!k.startsWith('f_') || Date.now() > e.exp) continue;
    const d = e.val;
    if (d?.denumire?.toLowerCase().includes(q.toLowerCase())) {
      hits.push({ cui: d.cui, denumire: d.denumire, adresa: d.adresa, judet: d.judet });
      if (hits.length >= 10) break;
    }
  }
  cacheSet(cKey, hits, 300_000);
  return res.json({ source: 'cache', data: hits });
});

// ── UTILS ────────────────────────────────────────────────
function normalizeMFinante(j) {
  return {
    cui: j.cui || j.cif,
    denumire: j.denumire || j.denumire_contribuabil,
    adresa: j.adresa || j.adresa_domiciliu_fiscal,
    judet: j.judet,
    localitate: j.localitate,
    statusInactivi: j.stare_inregistrare === 'ACTIV' ? 0 : 1,
    scpTva: j.platitor_tva ? 'DA' : 'NU',
    dataInregistrare: j.data_inregistrare,
  };
}

function parseIndicatori(items) {
  const m = {};
  items.forEach(i => { m[i.indicator] = parseFloat(i.val_indicator) || 0; });
  return {
    cifraAfaceri: m['I2'] || 0, profitNet: m['I13'] || 0,
    totalActive: m['I1'] || 0, capitalPropriu: m['I10'] || 0,
    datoriiTotale: m['I6'] || 0, nrAngajati: m['I17'] || 0,
    activeCirculante: m['I3'] || 0, datoriiCurente: m['I8'] || 0,
    stocuri: m['I4'] || 0, creante: m['I5'] || 0,
    casaConturi: m['I7'] || 0, venituriTotale: m['I11'] || 0,
    cheltuieliTotale: m['I12'] || 0,
  };
}

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Eroare server' }); });
app.use((req, res) => res.status(404).json({ error: 'Endpoint inexistent' }));

app.listen(PORT, () => console.log(`🚀 FirmeRO API v2 pe portul ${PORT}`));
