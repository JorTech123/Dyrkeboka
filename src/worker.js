// Dyrkeboka – Cloudflare Worker
// Serverer appen (public/), lagrer felles data i D1, henter værvarsel fra MET og (valgfritt) svarer via Claude.
//
// API:
//   GET    /api/info              åpen   – hva serveren støtter
//   GET    /api/vaer              åpen   – forenklet værvarsel for gården (bufret 30 min)
//   GET    /api/state             kode   – hele planen (bed, trær, oppgaver, oppsett)
//   PUT    /api/state             kode   – lagre planen (siste skriving vinner, eldre avvises)
//   GET    /api/logg?since=ms     kode   – loggendringer siden et tidspunkt (inkl. slettinger)
//   PUT    /api/logg/:id          kode   – lagre ett loggnotat
//   DELETE /api/logg/:id          kode   – slette ett loggnotat
//   POST   /api/spor              kode   – spørsmål til Claude (krever ANTHROPIC_API_KEY)
//
// «kode» = familiekoden i hemmeligheten FAMILY_KEY, sendt som «Authorization: Bearer <kode>».

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS state (garden TEXT PRIMARY KEY, data TEXT NOT NULL, t INTEGER NOT NULL, st INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS logg (garden TEXT NOT NULL, id TEXT NOT NULL, data TEXT, del INTEGER NOT NULL DEFAULT 0, st INTEGER NOT NULL, PRIMARY KEY (garden, id))`,
  `CREATE INDEX IF NOT EXISTS logg_st ON logg (garden, st)`,
];
let schemaReady = false;
let memWeather = null; // { key, at, body }

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function authorized(req, env) {
  if (!env.FAMILY_KEY) return true; // uten kode er alt åpent – sett FAMILY_KEY i produksjon
  const h = req.headers.get('authorization') || '';
  return safeEqual(h.startsWith('Bearer ') ? h.slice(7) : '', env.FAMILY_KEY);
}

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  schemaReady = true;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);

    const garden = env.GARDEN || 'tveitan';
    try {
      if (p === '/api/info') {
        return json({ ok: true, garden, auth: !!env.FAMILY_KEY, ai: !!env.ANTHROPIC_API_KEY });
      }
      if (p === '/api/vaer' && req.method === 'GET') return await weather(env, ctx);

      if (!authorized(req, env)) return json({ error: 'Feil familiekode' }, 401);
      await ensureSchema(env);

      if (p === '/api/state') {
        if (req.method === 'GET') {
          const row = await env.DB.prepare('SELECT data, t FROM state WHERE garden = ?').bind(garden).first();
          return json(row || null);
        }
        if (req.method === 'PUT') {
          const b = await req.json().catch(() => null);
          if (!b || typeof b.data !== 'string' || !Number.isFinite(b.t)) return json({ error: 'Ugyldig innhold' }, 400);
          if (b.data.length > 900_000) return json({ error: 'For stor' }, 413);
          try { JSON.parse(b.data); } catch { return json({ error: 'Ugyldig JSON' }, 400); }
          const cur = await env.DB.prepare('SELECT t FROM state WHERE garden = ?').bind(garden).first();
          if (cur && cur.t > b.t) return json({ accepted: false, t: cur.t });
          await env.DB.prepare(
            'INSERT INTO state (garden, data, t, st) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(garden) DO UPDATE SET data = ?2, t = ?3, st = ?4'
          ).bind(garden, b.data, b.t, Date.now()).run();
          return json({ accepted: true, t: b.t });
        }
      }

      if (p === '/api/logg' && req.method === 'GET') {
        const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
        const { results } = await env.DB.prepare(
          'SELECT id, data, del, st FROM logg WHERE garden = ? AND st > ? ORDER BY st LIMIT 5000'
        ).bind(garden, since).all();
        return json({
          entries: results.map((r) => ({ id: r.id, del: !!r.del, st: r.st, e: r.del ? null : JSON.parse(r.data) })),
        });
      }

      const m = p.match(/^\/api\/logg\/([A-Za-z0-9_-]{1,64})$/);
      if (m) {
        const id = m[1];
        const st = Date.now();
        if (req.method === 'PUT') {
          const e = await req.json().catch(() => null);
          if (!e || typeof e !== 'object') return json({ error: 'Ugyldig innhold' }, 400);
          e.id = id;
          const s = JSON.stringify(e);
          if (s.length > 20_000) return json({ error: 'For stor' }, 413);
          await env.DB.prepare(
            'INSERT INTO logg (garden, id, data, del, st) VALUES (?1, ?2, ?3, 0, ?4) ON CONFLICT(garden, id) DO UPDATE SET data = ?3, del = 0, st = ?4'
          ).bind(garden, id, s, st).run();
          return json({ ok: true, st });
        }
        if (req.method === 'DELETE') {
          await env.DB.prepare(
            'INSERT INTO logg (garden, id, data, del, st) VALUES (?1, ?2, NULL, 1, ?3) ON CONFLICT(garden, id) DO UPDATE SET data = NULL, del = 1, st = ?3'
          ).bind(garden, id, st).run();
          return json({ ok: true, st });
        }
      }

      if (p === '/api/spor' && req.method === 'POST') return await askClaude(req, env);
      return json({ error: 'Finnes ikke' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: 'Serverfeil' }, 500);
    }
  },
};

// ---------- vær fra Meteorologisk institutt ----------
async function weather(env, ctx) {
  const lat = Number(env.LAT || 59.45).toFixed(4);
  const lon = Number(env.LON || 10.42).toFixed(4);
  const alt = parseInt(env.ALT || '70', 10);
  const key = `${lat},${lon},${alt}`;
  const maxAge = 30 * 60 * 1000;

  if (memWeather && memWeather.key === key && Date.now() - memWeather.at < maxAge) {
    return json(memWeather.body, 200, { 'cache-control': 'public, max-age=900' });
  }
  const cacheKey = new Request(`https://dyrkeboka.internal/vaer/${key}`);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const src = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}&altitude=${alt}`;
  let r;
  try {
    r = await fetch(src, { headers: { 'user-agent': env.MET_UA || 'Dyrkeboka/1.0 https://jortech.no' } });
  } catch (e) {
    r = { ok: false };
  }
  if (!r.ok) {
    if (memWeather) return json(memWeather.body, 200); // gammelt varsel er bedre enn ingenting
    return json({ error: 'MET svarte ikke' }, 502);
  }
  const body = simplify(await r.json());
  memWeather = { key, at: Date.now(), body };
  const res = json(body, 200, { 'cache-control': 'public, max-age=1800' });
  if (cache) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// Gjør MET-varselet om til døgn: min/maks, nattemin (kl. 20–08), nedbør og et symbol rundt midt på dagen.
function simplify(raw, tz = 'Europe/Oslo') {
  const ts = (raw && raw.properties && raw.properties.timeseries) || [];
  const dayFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' });
  const days = new Map();
  const nights = new Map();
  const getDay = (k) => {
    if (!days.has(k)) days.set(k, { date: k, min: Infinity, max: -Infinity, precip: 0, sym: null, symDist: 99 });
    return days.get(k);
  };
  const hours = [];
  for (let i = 0; i < ts.length; i++) {
    const s = ts[i];
    const when = new Date(s.time);
    const day = dayFmt.format(when);
    const h = Number(hourFmt.format(when));
    const t = s.data && s.data.instant && s.data.instant.details ? s.data.instant.details.air_temperature : null;
    if (typeof t !== 'number') continue;
    const d = getDay(day);
    d.min = Math.min(d.min, t);
    d.max = Math.max(d.max, t);

    // nedbør: timesverdier der serien er time for time, ellers seks-timers verdier
    const next = ts[i + 1] ? new Date(ts[i + 1].time) - when : 3600e3;
    const n1 = s.data.next_1_hours, n6 = s.data.next_6_hours, n12 = s.data.next_12_hours;
    if (next < 2 * 3600e3 && n1) d.precip += n1.details?.precipitation_amount || 0;
    else if (n6) d.precip += n6.details?.precipitation_amount || 0;

    const sym = (n6 || n1 || n12)?.summary?.symbol_code;
    const dist = Math.abs(h - 12);
    if (sym && dist < d.symDist) { d.sym = sym; d.symDist = dist; }

    // natt til dato D = kl. 20–23 dagen før + kl. 00–08 på D
    let nk = null;
    if (h <= 8) nk = day;
    else if (h >= 20) nk = dayFmt.format(new Date(when.getTime() + 12 * 3600e3));
    if (nk) nights.set(nk, Math.min(nights.has(nk) ? nights.get(nk) : Infinity, t));

    if (hours.length < 24) hours.push({ time: s.time, t, sym: n1?.summary?.symbol_code || null, p: n1?.details?.precipitation_amount ?? null, wind: s.data.instant.details.wind_speed ?? null });
  }
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    updated: raw?.properties?.meta?.updated_at || null,
    days: [...days.values()].slice(0, 10).map((d) => ({
      date: d.date,
      min: r1(d.min),
      max: r1(d.max),
      night: nights.has(d.date) ? r1(nights.get(d.date)) : null,
      precip: r1(d.precip),
      sym: d.sym,
    })),
    hours,
  };
}

// ---------- Claude (valgfritt) ----------
async function askClaude(req, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'AI er ikke satt opp' }, 501);
  const b = await req.json().catch(() => null);
  const prompt = String((b && b.prompt) || '').slice(0, 15000);
  if (!prompt.trim()) return json({ error: 'Tomt spørsmål' }, 400);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.ANTHROPIC_API_KEY}`,
      'anthropic-version': '2026-10-21',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.AI_MODEL || 'claude-sonnet-5-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: j?.error?.message || 'AI-feil' }, 502);
  const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  return json({ text });
}
