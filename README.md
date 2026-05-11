# FirmeRO API — Backend Railway

Backend Node.js/Express pentru platforma FirmeRO. Oferă:
- 🔍 **Search după denumire** (funcționalitate absentă în ANAF direct)
- 📊 **Bilanțuri** 10 ani per firmă
- ⚡ **Cache in-memory** pentru performanță
- 🛡️ **Rate limiting** (100 req/15min per IP)

## Deploy pe Railway (gratuit)

### 1. Creează cont Railway
Mergi la [railway.app](https://railway.app) și loghează-te cu GitHub.

### 2. Deploy din GitHub
```bash
# Inițializează repo și push
cd firme-ro-api
git init
git add .
git commit -m "Initial commit FirmeRO API"
git remote add origin https://github.com/username/firme-ro-api.git
git push -u origin main
```
Apoi în Railway: **New Project → Deploy from GitHub repo**.

### 3. Deploy Direct (fără GitHub)
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### 4. Variabile de Mediu (Railway Dashboard)
```
PORT=3000              # setat automat de Railway
ALLOWED_ORIGIN=*       # sau domeniul tău: https://firme-ro.netlify.app
NODE_ENV=production
```

### 5. Configurează Frontend
După deploy, copiază URL-ul Railway (ex: `https://firme-ro-api.up.railway.app`) și adaugă în `index.html`:
```html
<script>
  window.FIRME_API_URL = 'https://firme-ro-api.up.railway.app';
</script>
```
Sau setează în toate paginile HTML înainte de `<script src="js/api.js">`.

## Endpoints

| Method | Path | Descriere |
|--------|------|-----------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/firma/:cui` | Date generale firmă |
| `GET` | `/api/bilant/:cui` | Bilanțuri 10 ani |
| `GET` | `/api/search?q=` | Căutare după denumire sau CUI |

## Arhitectura Datelor

```
Browser → Railway API → Cache Hit? → Răspuns imediat
                      ↓ Cache Miss
                      → getcif.dev (date firmă)
                      → ANAF Bilanțuri
                      → Cache Set → Răspuns
```

**Notă**: ANAF blochează request-uri server-to-server pentru date generale.
Datele de bază (CUI lookup) se fac **direct din browser** via ANAF CORS.
Backend-ul Railway adaugă: search după denumire + cache + bilanțuri centralizate.

## Limite Railway Free Tier
- 500 ore/lună (suficient pentru proiect personal)
- 512MB RAM
- Fără limită de request-uri

## Dezvoltare Locală
```bash
npm install
npm run dev    # nodemon cu auto-reload
# sau
npm start      # producție
```
API disponibil la `http://localhost:3000`
