const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');

const PORT = process.env.PORT || 7000;

const CINEMETA = 'https://v3-cinemeta.strem.io';
const CHANNELS = 10;
const DAY = 24 * 60 * 60 * 1000;
const STAGGER = DAY / CHANNELS;        // each channel's "day" is offset so they don't all reset together
// How many of Cinemeta's top movies to draw from (100 per page). Bigger = more variety,
// but deeper pages get more obscure. Override with e.g. $env:POOL_SIZE="3000"
const POOL_SIZE = parseInt(process.env.POOL_SIZE, 10) || 2000;
const POOL_PAGES = Array.from({ length: Math.ceil(POOL_SIZE / 100) }, (_, i) => i * 100);

const manifest = {
  id: 'community.randomtv',
  version: '2.0.0',
  name: 'Random TV',
  description: '10 movie channels, each already part-way through. Like channel surfing.',
  resources: ['catalog', 'meta'],
  types: ['movie'],
  idPrefixes: ['tt'],
  catalogs: [{ type: 'movie', id: 'random-tv', name: 'Now Showing' }],
};

const builder = new addonBuilder(manifest);

// ---------- helpers ----------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const getJSON = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
};

// ---------- pool of films (cached 24h), shuffled once with a fixed seed ----------
let pool = null, poolAt = 0;
async function getPool() {
  if (pool && Date.now() - poolAt < DAY) return pool;
  // one retry per page, so a blip doesn't quietly change the pool (and the channel split)
  const fetchPage = async (skip) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return (await getJSON(`${CINEMETA}/catalog/movie/top/skip=${skip}.json`)).metas || []; }
      catch (_) { /* retry */ }
    }
    return [];
  };
  const pages = await Promise.all(POOL_PAGES.map(fetchPage));
  const seen = new Set();
  const films = pages.flat().filter((f) => f && f.id && !seen.has(f.id) && seen.add(f.id));
  pool = shuffle(films, mulberry32(12345));
  poolAt = Date.now();
  console.log(`Pool ready: ${pool.length} films`);
  return pool;
}

// ---------- film info (meta + runtime), cached ----------
const infoCache = new Map();
function getInfo(id) {
  if (!infoCache.has(id)) {
    infoCache.set(
      id,
      getJSON(`${CINEMETA}/meta/movie/${id}.json`)
        .then(({ meta }) => {
          const runtime = parseInt(meta.runtime, 10); // e.g. "136 min"
          return runtime && runtime >= 75 ? { meta, runtime } : null;
        })
        .catch(() => { infoCache.delete(id); return null; })
    );
  }
  return infoCache.get(id);
}

// ---------- channels ----------
// Each channel owns 1/10th of the pool, so no film is on two channels at once.
// A channel's schedule is a back-to-back sequence of films, seeded by its "day"
// (24h, offset per channel), so it is identical across restarts and refreshes.
const schedules = new Map();

async function getSchedule(ch, now) {
  const offset = ch * STAGGER;
  const anchor = Math.floor((now - offset) / DAY) * DAY + offset;
  const key = `${anchor}:${ch}`;
  const films = await getPool();
  if (!schedules.has(key)) {
    const mine = films.filter((_, i) => i % CHANNELS === ch);
    const rand = mulberry32((Math.floor(anchor / 60000) ^ Math.imul(ch + 1, 2654435761)) | 0);
    schedules.set(key, {
      anchor, rand,
      order: shuffle(mine, rand),
      cursor: 0, entries: [], nextStart: null,
      chain: Promise.resolve(),
    });
    for (const [k, s] of schedules) if (s.anchor < now - 2 * DAY) schedules.delete(k);
  }
  return schedules.get(key);
}

// Extend a channel's schedule until it covers `until`
function extend(s, until) {
  s.chain = s.chain
    .then(async () => {
      while ((s.nextStart === null || s.nextStart <= until) && s.cursor < s.order.length) {
        const info = await getInfo(s.order[s.cursor++].id);
        if (!info) continue;
        // first film of the day is already 0-60% through when the channel "day" begins
        const startedAt =
          s.nextStart === null ? s.anchor - s.rand() * 0.6 * info.runtime * 60000 : s.nextStart;
        s.entries.push({ meta: info.meta, runtime: info.runtime, startedAt });
        s.nextStart = startedAt + info.runtime * 60000;
      }
    })
    .catch((e) => console.error('schedule error:', e.message));
  return s.chain;
}

async function onAir(ch, now) {
  const s = await getSchedule(ch, now);
  await extend(s, now);
  return s.entries.find((e) => e.startedAt <= now && now < e.startedAt + e.runtime * 60000) || null;
}

let lineupCache = { at: 0, data: [] };
async function getLineup() {
  const now = Date.now();
  if (lineupCache.data.length && now - lineupCache.at < 30000) return lineupCache.data;
  const all = await Promise.all(Array.from({ length: CHANNELS }, (_, ch) => onAir(ch, now)));
  const data = all.filter(Boolean);
  lineupCache = { at: now, data };
  return data;
}

// ---------- catalog ----------
builder.defineCatalogHandler(async ({ type, id }) => {
  if (type !== 'movie' || id !== 'random-tv') return { metas: [] };
  const lineup = await getLineup();

  const metas = lineup.map((e) => ({
    id: e.meta.id,
    type: 'movie',
    name: e.meta.name,
    poster: e.meta.poster,
    background: e.meta.background,
    releaseInfo: e.meta.releaseInfo,
    genres: e.meta.genres,
    description: e.meta.description,
  }));

  return { metas, cacheMaxAge: 60 };
});

// ---------- meta (film detail page) ----------
builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== 'movie') return { meta: null };
  try {
    const info = await getInfo(id);
    const meta = info ? info.meta : (await getJSON(`${CINEMETA}/meta/movie/${id}.json`)).meta;
    return { meta, cacheMaxAge: 60 };
  } catch (e) {
    return { meta: null };
  }
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Random TV running: http://127.0.0.1:${PORT}/manifest.json`);

// warm the schedules so the first catalog load is quick
getLineup()
  .then((l) => console.log(`Lineup ready: ${l.length} channels on air`))
  .catch((e) => console.error('warm-up failed:', e.message));