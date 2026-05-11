/**
 * server.js — FirmeRO API Backend (Railway)
 * Proxy complet pentru ANAF — rezolvă CORS și accesul din file://
 * Integrează:
 *   - ANAF v9 (date TVA, bilanțuri) — gratuit
 *   - FirmeAPI.ro (detalii ONRC, administratori) — cheie API
 */

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import fetch from 'node-fetch';
import https from 'https';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const app = express();
const PORT = process.env.PORT || 3000;
const ANAF_TVA_URL = 'https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva';
const ANAF_BILANT_URL = 'https://webservicesp.anaf.ro/bilant';

// FirmeAPI.ro — date ONRC (administratori, detalii extinse)
const FIRMEAPI_KEY = process.env.FIRMEAPI_KEY || '';
const FIRMEAPI_BASE = 'https://www.firmeapi.ro/api/v1';
const FIRMEAPI_HEADERS = {
  'Accept': 'application/json',
  'Authorization': `Bearer ${FIRMEAPI_KEY}`
};

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
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    cacheSize: cache.size,
    version: '3.0',
    firmeapi: FIRMEAPI_KEY ? 'configured' : 'not_configured'
  });
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

// ── PROXY FirmeAPI.ro DETALII → GET /api/detalii/:cui ────
app.get('/api/detalii/:cui', async (req, res) => {
  const cui = req.params.cui.replace(/\D/g, '');
  if (!cui || cui.length < 4) return res.status(400).json({ error: 'CUI invalid' });
  if (!FIRMEAPI_KEY) return res.status(503).json({ error: 'FirmeAPI nu este configurat.' });

  const cKey = `fd_${cui}`;
  const cached = cacheGet(cKey);
  if (cached) return res.json({ source: 'cache', data: cached });

  try {
    const r = await fetch(`${FIRMEAPI_BASE}/firma/${cui}`, {
      headers: FIRMEAPI_HEADERS,
      signal: AbortSignal.timeout(10000)
    });
    const json = await r.json();
    if (json.success && json.data) {
      cacheSet(cKey, json.data, 3600_000); // 1h
      return res.json({ source: 'firmeapi', data: json.data });
    }
    console.log(`FirmeAPI detalii error:`, json.error || json.message);
    return res.status(r.status || 502).json({ error: json.error || json.message || 'Eroare FirmeAPI' });
  } catch (e) {
    console.log(`FirmeAPI detalii fetch error: ${e.message}`);
    return res.status(502).json({ error: 'FirmeAPI indisponibil momentan.' });
  }
});

// ── PROXY FirmeAPI.ro ADMINISTRATORI → GET /api/administratori/:cui ──
app.get('/api/administratori/:cui', async (req, res) => {
  const cui = req.params.cui.replace(/\D/g, '');
  if (!cui || cui.length < 4) return res.status(400).json({ error: 'CUI invalid' });
  if (!FIRMEAPI_KEY) return res.status(503).json({ error: 'FirmeAPI nu este configurat.' });

  const cKey = `fa_${cui}`;
  const cached = cacheGet(cKey);
  if (cached) return res.json({ source: 'cache', data: cached });

  try {
    const r = await fetch(`${FIRMEAPI_BASE}/administratori/${cui}`, {
      headers: FIRMEAPI_HEADERS,
      signal: AbortSignal.timeout(10000)
    });
    const json = await r.json();
    if (json.success && json.data) {
      cacheSet(cKey, json.data, 21600_000); // 6h — admins se schimbă rar
      return res.json({ source: 'firmeapi', data: json.data });
    }
    console.log(`FirmeAPI admin error:`, json.error || json.message);
    return res.status(r.status || 502).json({ error: json.error || json.message || 'Eroare FirmeAPI' });
  } catch (e) {
    console.log(`FirmeAPI admin fetch error: ${e.message}`);
    return res.status(502).json({ error: 'FirmeAPI indisponibil momentan.' });
  }
});

// ── AUTH & BAZĂ DE DATE ──────────────────────────────────
const { Pool } = pg;
const JWT_SECRET = process.env.JWT_SECRET || 'firme-ro-secret-key';
let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  // Inițializare tabele
  pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS favorites (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      cui VARCHAR(20) NOT NULL,
      denumire VARCHAR(255),
      notita TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, cui)
    );
  `).then(() => console.log('✅ PostgreSQL inițializat')).catch(err => console.error('Eroare DB:', err.message));
}

// Middleware autentificare
function authenticateToken(req, res, next) {
  if (!pool) return res.status(503).json({ error: 'Baza de date nu este configurată.' });
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Acces neautorizat. Lipsă token.' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token invalid sau expirat.' });
    req.user = user;
    next();
  });
}

// Înregistrare
app.post('/api/auth/register', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Baza de date nu este configurată.' });
  try {
    const { email, password } = req.body;
    if (!email || !password || password.length < 6) 
      return res.status(400).json({ error: 'Date invalide. Parola trebuie să aibă minim 6 caractere.' });
    
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email', [email, hash]);
    
    const token = jwt.sign({ id: result.rows[0].id, email }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Acest email este deja înregistrat.' });
    res.status(500).json({ error: 'Eroare la înregistrare.' });
  }
});

// Autentificare
app.post('/api/auth/login', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Baza de date nu este configurată.' });
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'Email sau parolă incorectă.' });
    
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Email sau parolă incorectă.' });
    
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: 'Eroare la autentificare.' });
  }
});

// GET Favorite
app.get('/api/favorites', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM favorites WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Eroare la obținerea favoritelor.' });
  }
});

// POST Favorite
app.post('/api/favorites', authenticateToken, async (req, res) => {
  try {
    const { cui, denumire, notita } = req.body;
    
    const count = await pool.query('SELECT COUNT(*) FROM favorites WHERE user_id = $1', [req.user.id]);
    if (parseInt(count.rows[0].count) >= 20) {
      return res.status(400).json({ error: 'Ai atins limita maximă de 20 de firme favorite.' });
    }
    
    const result = await pool.query(
      'INSERT INTO favorites (user_id, cui, denumire, notita) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, cui) DO NOTHING RETURNING *',
      [req.user.id, cui, denumire, notita || '']
    );
    if (result.rows.length === 0) return res.status(400).json({ error: 'Firma este deja în favorite.' });
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Eroare la salvarea firmei.' });
  }
});

// PUT Notiță
app.put('/api/favorites/:id', authenticateToken, async (req, res) => {
  try {
    const { notita } = req.body;
    const result = await pool.query(
      'UPDATE favorites SET notita = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
      [notita, req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Firmă negăsită.' });
    res.json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Eroare la actualizare.' });
  }
});

// DELETE Favorite
app.delete('/api/favorites/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM favorites WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Firmă negăsită.' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Eroare la ștergere.' });
  }
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
  // Mapare corectă ANAF bilanț (societăți comerciale):
  // I1  = Active imobilizate
  // I2  = Active circulante totale
  // I3  = Cheltuieli în avans
  // I4  = Datorii pe termen scurt (< 1 an)
  // I5  = Active circulante nete / Datorii curente nete
  // I6  = Total active minus datorii curente
  // I7  = Total active
  // I8  = Datorii pe termen lung (> 1 an)
  // I9  = Provizioane
  // I10 = Venituri în avans
  // I11 = Capital subscris vărsat
  // I12 = Patrimoniul regiei
  // I13 = Cifra de afaceri netă
  // I14 = Venituri totale
  // I15 = Cheltuieli totale
  // I16 = Profit / Pierdere netă
  // I17 = Profitul sau pierderea din exploatare
  // I18 = Capitaluri proprii
  // I19 = Capital social
  // I20 = Număr mediu salariați
  return {
    cifraAfaceri: m['I13'] || 0,
    profitNet: m['I16'] || 0,
    totalActive: m['I7'] || 0,
    capitalPropriu: m['I18'] || 0,
    datoriiTotale: (m['I4'] || 0) + (m['I8'] || 0),
    nrAngajati: m['I20'] || 0,
    activeImobilizate: m['I1'] || 0,
    activeCirculante: m['I2'] || 0,
    datoriiCurente: m['I4'] || 0,
    datoriiTermenLung: m['I8'] || 0,
    stocuri: 0,
    creante: 0,
    casaConturi: 0,
    venituriTotale: m['I14'] || 0,
    cheltuieliTotale: m['I15'] || 0,
    profitExploatare: m['I17'] || 0,
    capitalSocial: m['I19'] || 0,
  };
}

// ==========================================
// BVB PROXY — Stock data from Bucharest Stock Exchange
// ==========================================

// In-memory cache for BVB data (15 min TTL)
const bvbCache = { shares: null, sharesTs: 0, instruments: {} };
const BVB_CACHE_TTL = 15 * 60 * 1000;

/**
 * GET /api/bvb/shares — Proxy download of BVB shares CSV
 * Returns parsed JSON array of all listed shares
 */
app.get('/api/bvb/shares', async (req, res) => {
  try {
    if (bvbCache.shares && (Date.now() - bvbCache.sharesTs) < BVB_CACHE_TTL) {
      return res.json({ data: bvbCache.shares, cached: true });
    }

    const csvUrl = 'https://bvb.ro/FinancialInstruments/Markets/SharesListForDownload.ashx';
    const response = await fetch(csvUrl, {
      agent: httpsAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
        'Accept': 'text/csv, text/plain, */*',
        'Referer': 'https://bvb.ro/FinancialInstruments/Markets/Shares',
      },
      timeout: 15000
    });

    if (!response.ok) throw new Error(`BVB responded with ${response.status}`);

    const text = await response.text();
    const lines = text.split('\n').filter(l => l.trim());
    
    if (lines.length < 2) throw new Error('BVB CSV empty or invalid');

    // Parse CSV — detect separator (could be , or ;)
    const sep = lines[0].includes(';') ? ';' : ',';
    const headers = lines[0].split(sep).map(h => h.trim().replace(/"/g, ''));
    
    const shares = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(sep).map(c => c.trim().replace(/"/g, ''));
      if (cols.length < 4) continue;
      
      const row = {};
      headers.forEach((h, idx) => { row[h] = cols[idx] || ''; });
      shares.push(row);
    }

    bvbCache.shares = shares;
    bvbCache.sharesTs = Date.now();

    res.json({ data: shares, count: shares.length });
  } catch (err) {
    console.error('BVB shares error:', err.message);
    res.status(502).json({ error: 'Nu s-au putut prelua datele BVB: ' + err.message });
  }
});

/**
 * GET /api/bvb/instrument/:symbol — Scrape instrument details from BVB page
 * Returns: price, change, volume, marketCap, 52w range etc.
 */
app.get('/api/bvb/instrument/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  
  try {
    // Check cache
    const cached = bvbCache.instruments[symbol];
    if (cached && (Date.now() - cached.ts) < BVB_CACHE_TTL) {
      return res.json({ data: cached.data, cached: true });
    }

    const url = `https://bvb.ro/FinancialInstruments/Details/FinancialInstrumentsDetails.aspx?s=${symbol}`;
    const response = await fetch(url, {
      agent: httpsAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
        'Accept': 'text/html',
        'Accept-Language': 'ro-RO,ro;q=0.9',
        'Referer': 'https://bvb.ro/FinancialInstruments/Markets/Shares',
      },
      timeout: 15000
    });

    if (!response.ok) throw new Error(`BVB responded with ${response.status}`);

    const html = await response.text();

    // Parse key values from HTML using regex (BVB uses server-rendered pages)
    const extract = (pattern) => {
      const m = html.match(pattern);
      return m ? m[1].trim().replace(/,/g, '').replace(/\s/g, '') : null;
    };

    const parseNum = (val) => {
      if (!val) return 0;
      return parseFloat(val.replace(/[^\d.\-]/g, '')) || 0;
    };

    // BVB page structure — extract data from typical patterns
    const data = {
      symbol,
      price: parseNum(extract(/Pret\s*<\/.*?>([\d.,]+)/i) || extract(/class="value"[^>]*>([\d.,]+)/i)),
      change: parseNum(extract(/Var(?:iatia|iatie|\.)\s*%?\s*<\/.*?>([-\d.,]+)/i)),
      volume: parseNum(extract(/Volum\s*<\/.*?>([\d.,]+)/i)),
      marketCap: parseNum(extract(/Capitalizare\s*<\/.*?>([\d.,]+)/i)),
      high52w: parseNum(extract(/Max(?:im)?\s*52\s*[Ss](?:apt|ăpt)?\s*<\/.*?>([\d.,]+)/i)),
      low52w: parseNum(extract(/Min(?:im)?\s*52\s*[Ss](?:apt|ăpt)?\s*<\/.*?>([\d.,]+)/i)),
      open: parseNum(extract(/Deschidere\s*<\/.*?>([\d.,]+)/i)),
      previousClose: parseNum(extract(/Inchidere\s*(?:ant|prec)?\s*<\/.*?>([\d.,]+)/i)),
      // Try to extract number of shares
      shares: parseNum(extract(/Nr\.?\s*(?:de\s*)?actiuni\s*<\/.*?>([\d.,]+)/i) || extract(/Actiuni\s*emise\s*<\/.*?>([\d.,]+)/i)),
    };

    // If price extraction failed, try broader patterns
    if (!data.price) {
      // Look for the main price value on the page (usually prominent)
      const priceMatch = html.match(/id="[^"]*(?:price|pret|LastPrice)[^"]*"[^>]*>([\d.,]+)/i);
      if (priceMatch) data.price = parseNum(priceMatch[1]);
    }

    bvbCache.instruments[symbol] = { data, ts: Date.now() };
    res.json({ data });
  } catch (err) {
    console.error(`BVB instrument ${symbol} error:`, err.message);
    res.status(502).json({ error: 'Nu s-au putut prelua detaliile instrumentului: ' + err.message });
  }
});

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Eroare server' }); });
app.use((req, res) => res.status(404).json({ error: 'Endpoint inexistent' }));

app.listen(PORT, () => console.log(`🚀 FirmeRO API v2 pe portul ${PORT}`));
