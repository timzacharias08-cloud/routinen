'use strict';

/* ---------------------------------------------------------------------------
 * Top News PWA
 *  - Top News:   mehrere deutsche RSS-Feeds, Duplikate zusammengeführt, gerankt
 *  - Live-Ticker: alle Meldungen chronologisch, Auto-Refresh
 *  - Aktien:     Kurs/Chart/KGV von Yahoo Finance + Nachrichten-Stimmung
 *                → heuristische Tendenz mit Pro/Kontra (keine Anlageberatung!)
 * ------------------------------------------------------------------------- */

// Feeds mit Kategorie-Zuordnung. Kategorie muss zu den TOPICS unten passen.
const FEEDS = [
  { name: 'Tagesschau',            cat: 'top',        prio: 3, url: 'https://www.tagesschau.de/index~rss2.xml' },
  { name: 'Tagesschau Inland',     cat: 'politik',    prio: 2, url: 'https://www.tagesschau.de/inland/index~rss2.xml' },
  { name: 'Tagesschau Ausland',    cat: 'politik',    prio: 2, url: 'https://www.tagesschau.de/ausland/index~rss2.xml' },
  { name: 'Tagesschau Wirtschaft', cat: 'wirtschaft', prio: 2, url: 'https://www.tagesschau.de/wirtschaft/index~rss2.xml' },
  { name: 'finanzen.net',          cat: 'aktien',     prio: 1, url: 'https://www.finanzen.net/rss/news' },
];

const TOPICS = [
  { id: 'top',        label: 'Wichtigstes' },
  { id: 'politik',    label: 'Politik' },
  { id: 'wirtschaft', label: 'Wirtschaft' },
  { id: 'aktien',     label: 'Aktien & Börse' },
];

// Öffentliche CORS-Proxies (mit Fallback, falls einer ausfällt).
const PROXIES = [
  (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
  (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  (u) => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u),
];

// Yahoo-Finance-Endpunkte (kostenlos, ohne Key; via Proxy wegen CORS)
const YQ = {
  search: (q) => `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&lang=de-DE&region=DE&quotesCount=6&newsCount=0`,
  chart:  (s) => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=1y&interval=1d`,
  // Historische KGV-Werte (TTM) – funktioniert ohne Auth, anders als v7/quote
  pe:     (s) => {
    const now = Math.floor(Date.now() / 1000);
    return `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(s)}?type=trailingPeRatio&period1=${now - 400 * 86400}&period2=${now}`;
  },
  news:   (s) => `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(s)}&region=DE&lang=de-DE`,
  // Batch-Kurse für viele Symbole auf einmal (für Top Moves).
  // Kommas NICHT vorkodieren – die Proxy-Builder kodieren die ganze URL genau einmal.
  spark:  (syms) => `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${syms.join(',')}&range=5d&interval=1d`,
};

// Universum für "Top Moves": DAX 40 + große US-Techwerte
const MOVERS_UNIVERSE = [
  ['ADS.DE', 'Adidas'], ['AIR.DE', 'Airbus'], ['ALV.DE', 'Allianz'], ['BAS.DE', 'BASF'],
  ['BAYN.DE', 'Bayer'], ['BEI.DE', 'Beiersdorf'], ['BMW.DE', 'BMW'], ['CBK.DE', 'Commerzbank'],
  ['CON.DE', 'Continental'], ['DBK.DE', 'Deutsche Bank'], ['DB1.DE', 'Deutsche Börse'],
  ['DHL.DE', 'DHL Group'], ['DTE.DE', 'Deutsche Telekom'], ['DTG.DE', 'Daimler Truck'],
  ['EOAN.DE', 'E.ON'], ['FRE.DE', 'Fresenius'], ['HEI.DE', 'Heidelberg Materials'],
  ['HEN3.DE', 'Henkel'], ['HNR1.DE', 'Hannover Rück'], ['IFX.DE', 'Infineon'],
  ['MBG.DE', 'Mercedes-Benz'], ['MRK.DE', 'Merck'], ['MTX.DE', 'MTU Aero Engines'],
  ['MUV2.DE', 'Münchener Rück'], ['P911.DE', 'Porsche AG'], ['QIA.DE', 'Qiagen'],
  ['RHM.DE', 'Rheinmetall'], ['RWE.DE', 'RWE'], ['SAP.DE', 'SAP'], ['SHL.DE', 'Siemens Healthineers'],
  ['SIE.DE', 'Siemens'], ['ENR.DE', 'Siemens Energy'], ['SRT3.DE', 'Sartorius'],
  ['SY1.DE', 'Symrise'], ['VNA.DE', 'Vonovia'], ['VOW3.DE', 'Volkswagen'], ['ZAL.DE', 'Zalando'],
  ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'NVIDIA'], ['TSLA', 'Tesla'],
  ['AMZN', 'Amazon'], ['META', 'Meta'], ['GOOGL', 'Alphabet'],
];
const MARKET_INDEX = '^GDAXI';
const MOVES_COUNT = 6;

const QUICK_STOCKS = [
  ['SAP.DE', 'SAP'], ['SIE.DE', 'Siemens'], ['VOW3.DE', 'Volkswagen'],
  ['RHM.DE', 'Rheinmetall'], ['AAPL', 'Apple'], ['TSLA', 'Tesla'],
  ['NVDA', 'NVIDIA'], ['MSFT', 'Microsoft'],
];

const STORAGE_KEY = 'topnews:settings:v1';
const CACHE_KEY = 'topnews:cache:v1';
const STOCK_KEY = 'topnews:stock:v1';

const DEFAULTS = {
  count: 6,
  topics: ['top', 'politik', 'wirtschaft', 'aktien'],
};

const VIEW_TITLES = {
  news:   ['Top News', null],           // null → Datum anzeigen
  ticker: ['Live-Ticker', 'Alle Meldungen in Echtzeit'],
  stock:  ['Aktien-Analyse', 'Kurs, KGV & Nachrichten-Check'],
};

// ---------- State ----------
let settings = loadSettings();
let currentView = 'news';
let tickerTimer = null;
let tickerLastTs = 0;
let currentStock = loadJson(STOCK_KEY); // {symbol, name} | null
let stockLoadSeq = 0;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const el = {
  list: $('newsList'), skeletons: $('skeletons'), status: $('status'),
  dateLine: $('dateLine'), viewTitle: $('viewTitle'), updatedLine: $('updatedLine'),
  refreshBtn: $('refreshBtn'), settingsBtn: $('settingsBtn'),
  overlay: $('settingsOverlay'), closeSettings: $('closeSettings'),
  countRange: $('countRange'), countValue: $('countValue'), topicChips: $('topicChips'),
  viewNews: $('viewNews'), viewTicker: $('viewTicker'), viewStock: $('viewStock'),
  tickerList: $('tickerList'), tickerUpdated: $('tickerUpdated'), tickerSkeletons: $('tickerSkeletons'),
  stockInput: $('stockInput'), stockResults: $('stockResults'),
  stockQuick: $('stockQuick'), stockContent: $('stockContent'),
};

// ---------- Storage helpers ----------
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      count: clamp(parsed.count ?? DEFAULTS.count, 3, 10),
      topics: Array.isArray(parsed.topics) && parsed.topics.length ? parsed.topics : [...DEFAULTS.topics],
    };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings() { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); }
function loadJson(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Number(n) || lo)); }

// ---------- Fetch helpers ----------
// Merkt sich sitzungsübergreifend, welcher Proxy zuletzt schnell war → zuerst probieren.
let preferredProxy = 0;
try {
  const p = parseInt(localStorage.getItem('topnews:proxy'), 10);
  if (p >= 0 && p < PROXIES.length) preferredProxy = p;
} catch {}

const HEDGE_MS = 1400;      // so lange auf den laufenden Proxy warten, bevor der nächste dazugeschaltet wird
const PROXY_TIMEOUT = 9000; // harte Obergrenze pro Proxy-Versuch
const DIRECT_TIMEOUT = 5000;

async function fetchOnce(url) {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(PROXY_TIMEOUT) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  if (!text || text.length < 80) throw new Error('leere Antwort');
  return text;
}

// Manche Quellen (z. B. Tagesschau) erlauben CORS und sind ohne Proxy DIREKT ladbar –
// das ist um ein Vielfaches schneller. Welche Hosts das können, wird zur Laufzeit gelernt.
const directHosts = new Map([['www.tagesschau.de', true]]); // verifiziert direkt ladbar
function hostOf(url) { try { return new URL(url).host; } catch { return ''; } }

async function fetchDirect(url) {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(DIRECT_TIMEOUT) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  if (!text || text.length < 80) throw new Error('leere Antwort');
  return text;
}

// Bevorzugt Direktzugriff, fällt sonst auf den (hedged) Proxy-Weg zurück.
async function fetchText(url) {
  const host = hostOf(url);
  const known = directHosts.get(host);
  if (known !== false) {                 // bekannt-direkt oder noch unbekannt → direkt versuchen
    try {
      const t = await fetchDirect(url);
      directHosts.set(host, true);
      return t;
    } catch {
      if (known === undefined) directHosts.set(host, false); // unbekannt & gescheitert → künftig Proxy
    }
  }
  return fetchViaProxy(url);
}

// "Hedged request": Proxies werden in bevorzugter Reihenfolge gestartet, aber nicht
// erst nach vollem Timeout – nach HEDGE_MS (oder sofort bei Fehler) kommt der nächste
// dazu. Der erste Erfolg gewinnt: kurze Latenz bei gesundem Proxy, schnelles Failover.
function fetchViaProxy(url) {
  const order = PROXIES.map((_, i) => (preferredProxy + i) % PROXIES.length);
  return new Promise((resolve, reject) => {
    let settled = false, started = 0, failures = 0, timer = null;
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

    const startNext = () => {
      if (settled || started >= order.length) return;
      const idx = order[started++];
      clearTimer();
      if (started < order.length) timer = setTimeout(startNext, HEDGE_MS);
      fetchOnce(PROXIES[idx](url)).then((text) => {
        if (settled) return;
        settled = true; clearTimer();
        if (idx !== preferredProxy) {
          preferredProxy = idx;
          try { localStorage.setItem('topnews:proxy', String(idx)); } catch {}
        }
        resolve(text);
      }).catch(() => {
        if (settled) return;
        if (++failures >= order.length) { settled = true; clearTimer(); reject(new Error('Alle Proxies fehlgeschlagen')); return; }
        clearTimer(); startNext(); // bei frühem Fehler sofort weiter statt auf HEDGE_MS zu warten
      });
    };
    startNext();
  });
}
async function fetchJsonViaProxy(url) {
  return JSON.parse(await fetchText(url));
}

function parseFeed(xmlText, feed) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) return [];
  const items = [...doc.querySelectorAll('item, entry')];
  return items.map((node) => {
    const title = text(node, 'title');
    const link = text(node, 'link') || node.querySelector('link')?.getAttribute('href') || '';
    const desc = stripHtml(text(node, 'description') || text(node, 'summary') || text(node, 'content'));
    const dateStr = text(node, 'pubDate') || text(node, 'published') || text(node, 'updated') || text(node, 'dc\\:date');
    const date = dateStr ? new Date(dateStr) : null;
    return {
      title: title.trim(),
      link: link.trim(),
      desc: desc.trim(),
      date: date && !isNaN(date) ? date : null,
      source: feed.name,
      cat: feed.cat,
      prio: feed.prio,
    };
  }).filter((it) => it.title && it.link);
}

function text(node, sel) {
  try { return node.querySelector(sel)?.textContent || ''; }
  catch { return ''; }
}
function stripHtml(s) {
  const d = document.createElement('div');
  d.innerHTML = s;
  return (d.textContent || '').replace(/\s+/g, ' ');
}
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Prüft, ob ein Firmenname als GANZES Wort vorkommt (verhindert z. B. "Meta" in "Metall").
function mentionsCompany(text, token) {
  if (!token || token.length < 3) return false;
  return new RegExp('(^|[^0-9a-zà-ÿ])' + escapeRegex(token) + '([^0-9a-zà-ÿ]|$)', 'i').test(text);
}
// Leitet aus einem (evtl. langen) Firmennamen das Marken-Kürzel ab, das in Schlagzeilen
// tatsächlich benutzt wird: "Meta Platforms, Inc." → "meta", "Volkswagen AG" → "volkswagen".
const GENERIC_FIRST = ['deutsche', 'deutscher', 'münchener', 'muenchener', 'hannover', 'heidelberg', 'vereinigte', 'erste'];
function companyToken(name) {
  const cleaned = (name || '').toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(ag|se|inc|incorporated|corp|corporation|co|plc|group|holding|holdings|nv|sa|spa|the|platforms)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').filter(Boolean);
  if (!words.length) return (name || '').toLowerCase().trim();
  // Generische Anfangswörter ("Deutsche …") sind allein zu unspezifisch → zweites Wort dazu
  if (GENERIC_FIRST.includes(words[0]) && words[1]) return words[0] + ' ' + words[1];
  return words[0];
}

async function fetchAllFeeds(feeds) {
  const results = await Promise.allSettled(
    feeds.map((f) => fetchText(f.url).then((xml) => parseFeed(xml, f)))
  );
  const all = [];
  results.forEach((r) => { if (r.status === 'fulfilled') all.push(...r.value); });
  return all;
}

// Gemeinsamer In-Memory-Cache aller Feed-Items: News, Ticker und die Top-Moves-
// Erklärungen teilen sich EINEN Abruf. Parallele Aufrufe teilen dieselbe Anfrage.
let feedItemsCache = { items: [], ts: 0 };
let feedItemsInflight = null;
const FEED_TTL = 90 * 1000;

function getFeedItems(force = false) {
  const fresh = feedItemsCache.items.length && Date.now() - feedItemsCache.ts < FEED_TTL;
  if (!force && fresh) return Promise.resolve(feedItemsCache.items);
  if (feedItemsInflight) return feedItemsInflight;
  feedItemsInflight = fetchAllFeeds(FEEDS).then((items) => {
    feedItemsInflight = null;
    if (items.length) feedItemsCache = { items, ts: Date.now() };
    return items.length ? items : feedItemsCache.items;
  }).catch((e) => {
    feedItemsInflight = null;
    if (feedItemsCache.items.length) return feedItemsCache.items; // Offline: alte Items behalten
    throw e;
  });
  return feedItemsInflight;
}

// ---------- Ranking & dedup ----------
function normalizeTitle(t) {
  return t.toLowerCase()
    .replace(/[^\wäöüß\s]/g, ' ')
    .replace(/\b(der|die|das|und|in|im|von|für|mit|auf|nach|bei|zu|zum|zur|des|dem|ein|eine|ist|am|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function keywordSet(t) {
  return new Set(normalizeTitle(t).split(' ').filter((w) => w.length > 3));
}
function similarity(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const w of aSet) if (bSet.has(w)) inter++;
  return inter / Math.min(aSet.size, bSet.size);
}

function mergeAndRank(all) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const recent = all.filter((it) => !it.date || (now - it.date.getTime()) < 1.5 * dayMs);

  const clusters = [];
  for (const item of recent) {
    item.keys = keywordSet(item.title);
    let placed = false;
    for (const cl of clusters) {
      if (similarity(item.keys, cl.keys) >= 0.6) {
        cl.items.push(item);
        cl.sources.add(item.source);
        if (score(item) > score(cl.lead)) { cl.lead = item; cl.keys = item.keys; }
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push({ lead: item, keys: item.keys, items: [item], sources: new Set([item.source]) });
    }
  }

  for (const cl of clusters) {
    cl.finalScore = score(cl.lead) + (cl.sources.size - 1) * 6;
    cl.sourceCount = cl.sources.size;
  }
  clusters.sort((a, b) => b.finalScore - a.finalScore);
  return clusters;

  function score(it) {
    let s = it.prio * 4;
    if (it.date) {
      const ageH = (now - it.date.getTime()) / 3.6e6;
      s += Math.max(0, 30 - ageH);
    } else {
      s += 5;
    }
    if (it.cat === 'top') s += 6;
    return s;
  }
}

// ---------- View switching ----------
function switchView(view) {
  currentView = view;
  el.viewNews.hidden = view !== 'news';
  el.viewTicker.hidden = view !== 'ticker';
  el.viewStock.hidden = view !== 'stock';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));

  const [title, sub] = VIEW_TITLES[view];
  el.viewTitle.textContent = title;
  el.dateLine.textContent = sub || new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });

  stopTickerTimer();
  if (view === 'ticker') {
    if (!el.tickerList.children.length) loadTicker();
    startTickerTimer();
  }
  if (view === 'stock') {
    loadTopMoves();
    if (currentStock && !el.stockContent.dataset.loaded) loadStock(currentStock.symbol, currentStock.name);
  }
}

// ---------- Rendering: Top News ----------
function render(clusters) {
  el.list.innerHTML = '';
  const items = clusters.slice(0, settings.count);
  if (!items.length) {
    showStatus('Keine aktuellen Nachrichten gefunden. Versuch es später erneut.', true);
    return;
  }
  hideStatus();
  items.forEach((cl, i) => {
    const it = cl.lead;
    const a = document.createElement('a');
    a.className = 'news-card';
    a.href = it.link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.animationDelay = (i * 45) + 'ms';

    const topicLabel = (TOPICS.find((t) => t.id === it.cat) || {}).label || it.source;
    const multi = cl.sourceCount > 1
      ? `<span class="badge multi">${cl.sourceCount} Quellen</span>`
      : '';

    a.innerHTML = `
      <span class="rank">${i + 1}</span>
      <div class="card-title">${escapeHtml(it.title)}</div>
      ${it.desc ? `<div class="card-desc">${escapeHtml(it.desc)}</div>` : ''}
      <div class="card-meta">
        <span class="badge">${escapeHtml(topicLabel)}</span>
        ${multi}
        <span class="dot-sep">•</span>
        <span>${escapeHtml(it.source)}</span>
        ${it.date ? `<span class="dot-sep">•</span><span>${relTime(it.date)}</span>` : ''}
      </div>
    `;
    el.list.appendChild(a);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function relTime(date) {
  const diff = Date.now() - date.getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.round(h / 24);
  return `vor ${d} Tg.`;
}
function clockTime(date) {
  return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function showSkeletons(container, show, count = 5) {
  container.hidden = !show;
  if (show && !container.children.length) {
    for (let i = 0; i < count; i++) {
      const s = document.createElement('div');
      s.className = 'skel';
      container.appendChild(s);
    }
  }
}
function showStatus(msg, isError) {
  el.status.textContent = msg;
  el.status.hidden = false;
  el.status.classList.toggle('error', !!isError);
}
function hideStatus() { el.status.hidden = true; }

// ---------- Load flow: Top News ----------
let loading = false;
async function loadNews(useCacheFirst = false) {
  if (loading) return;
  loading = true;
  el.refreshBtn.classList.add('spin');

  if (useCacheFirst) {
    const cached = readCache();
    if (cached) { render(cached.clusters); setUpdated(cached.ts, true); }
    else showSkeletons(el.skeletons, true);
  } else {
    showSkeletons(el.skeletons, true);
    hideStatus();
  }

  try {
    const items = await getFeedItems(!useCacheFirst);
    const filtered = items.filter((it) => settings.topics.includes(it.cat));
    const all = filtered.length ? filtered : items;

    if (!all.length) {
      const cached = readCache();
      if (cached) {
        render(cached.clusters); setUpdated(cached.ts, true);
        showStatus('Keine Verbindung – zeige gespeicherte Nachrichten.', true);
      } else showStatus('Nachrichten konnten nicht geladen werden. Bist du online?', true);
      return;
    }

    const clusters = mergeAndRank(all);
    render(clusters);
    const ts = Date.now();
    writeCache(clusters, ts);
    setUpdated(ts, false);
  } catch (e) {
    showStatus('Fehler beim Laden: ' + e.message, true);
  } finally {
    showSkeletons(el.skeletons, false);
    el.refreshBtn.classList.remove('spin');
    loading = false;
  }
}

function setUpdated(ts, fromCache) {
  el.updatedLine.textContent = (fromCache ? 'Gespeichert · ' : 'Aktualisiert · ') + clockTime(new Date(ts)) + ' Uhr';
}

function writeCache(clusters, ts) {
  try {
    const slim = clusters.slice(0, 12).map((cl) => ({
      lead: { title: cl.lead.title, link: cl.lead.link, desc: cl.lead.desc,
              date: cl.lead.date ? cl.lead.date.toISOString() : null,
              source: cl.lead.source, cat: cl.lead.cat },
      sourceCount: cl.sourceCount,
    }));
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts, items: slim }));
  } catch {}
}
function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const clusters = data.items.map((c) => ({
      lead: { ...c.lead, date: c.lead.date ? new Date(c.lead.date) : null },
      sourceCount: c.sourceCount,
    }));
    return { clusters, ts: data.ts };
  } catch { return null; }
}

// ---------- Live-Ticker ----------
let tickerLoading = false;
async function loadTicker(force = false) {
  if (tickerLoading) return;
  tickerLoading = true;
  if (!el.tickerList.children.length) showSkeletons(el.tickerSkeletons, true, 6);

  try {
    const all = await getFeedItems(force);
    const dated = all.filter((it) => it.date).sort((a, b) => b.date - a.date).slice(0, 40);
    renderTicker(dated);
    el.tickerUpdated.textContent = 'aktualisiert ' + clockTime(new Date()) + ' Uhr · Auto-Update alle 90 s';
  } catch {
    el.tickerUpdated.textContent = 'Aktualisierung fehlgeschlagen – neuer Versuch folgt';
  } finally {
    showSkeletons(el.tickerSkeletons, false);
    tickerLoading = false;
  }
}

function renderTicker(items) {
  const prevTs = tickerLastTs;
  el.tickerList.innerHTML = '';
  items.forEach((it, i) => {
    const li = document.createElement('li');
    const isFresh = prevTs && it.date.getTime() > prevTs;
    li.className = 'ticker-item' + (isFresh ? ' fresh' : '');
    li.style.animationDelay = Math.min(i * 25, 400) + 'ms';
    li.innerHTML = `
      <div class="ticker-time">
        ${clockTime(it.date)} Uhr
        ${isFresh ? '<span class="ticker-new">NEU</span>' : ''}
      </div>
      <a href="${escapeHtml(it.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(it.title)}</a>
      <div class="ticker-src">${escapeHtml(it.source)} · ${relTime(it.date)}</div>
    `;
    el.tickerList.appendChild(li);
  });
  if (items.length) tickerLastTs = Math.max(tickerLastTs, items[0].date.getTime());
}

function startTickerTimer() {
  stopTickerTimer();
  tickerTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && currentView === 'ticker') loadTicker(true);
  }, 90 * 1000);
}
function stopTickerTimer() {
  if (tickerTimer) { clearInterval(tickerTimer); tickerTimer = null; }
}

// ---------- Aktien: Stimmungs-Lexikon ----------
const POS_WORDS = [
  'rekord', 'übertrifft', 'übertroffen', 'angehoben', 'aufschwung', 'kursziel erhöht',
  'kaufempfehlung', 'hochgestuft', 'hochstufung', 'großauftrag', 'auftragsplus', 'expansion',
  'durchbruch', 'erfolg', 'boom', 'steigt', 'springt', 'erholung', 'erholt', 'optimist',
  'profitiert', 'gewinnt', 'milliardengewinn', 'gewinnsprung', 'umsatzplus', 'wächst',
  'dividende erhöht', 'prognose angehoben', 'aufwärts',
  'record', 'beats', 'beat estimates', 'upgrade', 'upgraded', 'raises', 'raised', 'surge',
  'surges', 'jumps', 'rally', 'rallies', 'soars', 'outperform', 'strong growth', 'profit rises', 'wins',
];
const NEG_WORDS = [
  'verlust', 'gewinnwarnung', 'rückruf', 'klage', 'skandal', 'streik', 'insolvenz',
  'abstufung', 'abgestuft', 'herabgestuft', 'herabstufung', 'gesenkt', 'senkt prognose',
  'einbruch', 'bricht ein', 'crash', 'fällt', 'stürzt', 'absturz', 'rutscht', 'talfahrt',
  'ausverkauf', 'kursrutsch', 'entlassung', 'stellenabbau', 'ermittlung', 'strafe',
  'rezession', 'warnt', 'warnung', 'warnsignal', 'kritik', 'verfehlt', 'enttäuscht',
  'krise', 'sorgen', 'schwäch', 'zweifel', 'unter druck', 'allzeittief', 'neues tief',
  'jahrestief', 'rekordtief', 'abwärts',
  'loss', 'misses', 'missed', 'downgrade', 'downgraded', 'cuts', 'lawsuit', 'recall',
  'layoff', 'layoffs', 'plunge', 'plunges', 'falls', 'drops', 'probe', 'investigation',
  'fine', 'strike', 'bankruptcy', 'underperform', 'warning', 'weak', 'all-time low',
];

function sentimentOf(item) {
  const t = (item.title + ' ' + (item.desc || '')).toLowerCase();
  let pos = 0, neg = 0;
  for (const w of POS_WORDS) if (t.includes(w)) pos++;
  for (const w of NEG_WORDS) if (t.includes(w)) neg++;
  if (pos > neg) return 'pos';
  if (neg > pos) return 'neg';
  return 'neu';
}

// ---------- Aktien: Zukunfts-Argumente aus den News ableiten ----------
// Jede Regel formuliert, was eine Meldung für die KÜNFTIGE Kursentwicklung bedeutet.
const PRO_NEWS_RULES = [
  { words: ['großauftrag', 'milliardenauftrag', 'auftragsplus', 'auftragseingang', 'auftragsbücher', 'neuer auftrag', 'auftrag von'],
    text: 'Neue Aufträge könnten Umsatz und Gewinn in den kommenden Quartalen steigen lassen.' },
  { words: ['künstliche intelligenz', 'ki-', 'rechenzentrum', 'cloud', 'halbleiter', 'data center'],
    text: 'Der Boom bei KI und Cloud könnte dem Unternehmen weiteres Wachstum bringen.' },
  { words: ['kaufempfehlung', 'hochgestuft', 'hochstufung', 'kursziel erhöht', 'kursziel angehoben', 'outperform', 'overweight', 'zum kauf'],
    text: 'Analysten erwarten steigende Kurse – solche Empfehlungen ziehen oft weitere Käufer an.' },
  { words: ['übernahme', 'übernimmt', 'fusion', 'expansion', 'akquisition', 'markteintritt', 'investiert', 'baut werk', 'neues werk'],
    text: 'Investitionen und Zukäufe könnten das künftige Wachstum absichern.' },
  { words: ['rekord', 'gewinnsprung', 'übertrifft', 'übertroffen', 'umsatzplus', 'milliardengewinn', 'prognose angehoben', 'prognose erhöht', 'starke zahlen'],
    text: 'Nach starken Geschäftszahlen trauen Anleger dem Unternehmen künftig mehr zu.' },
  { words: ['sparprogramm', 'sparmaßnahmen', 'sparmassnahmen', 'restrukturierung', 'kostensenkung', 'sparkurs'],
    text: 'Das Sparprogramm könnte die Gewinne in den nächsten Quartalen verbessern.' },
  { words: ['dividende', 'aktienrückkauf', 'rückkauf', 'ausschüttung'],
    text: 'Dividenden oder Aktienrückkäufe dürften den Kurs künftig stützen.' },
  { words: ['zulassung', 'markteinführung', 'patent', 'durchbruch', 'produktstart', 'neues modell'],
    text: 'Neue Produkte oder Zulassungen könnten bald zusätzliche Umsätze bringen.' },
];
const CON_NEWS_RULES = [
  { words: ['gewinnwarnung', 'prognose gesenkt', 'senkt prognose', 'senkt die prognose'],
    text: 'Nach einer Gewinnwarnung folgen erfahrungsgemäß oft weitere Abwärtskorrekturen.' },
  { words: ['abstufung', 'abgestuft', 'herabgestuft', 'herabstufung', 'gestrichene kaufempfehlung', 'kaufempfehlung gestrichen', 'kursziel gesenkt', 'verkaufsempfehlung', 'underperform'],
    text: 'Analysten haben ihr Urteil gesenkt – das dürfte weitere Käufer abschrecken.' },
  { words: ['klage', 'ermittlung', 'skandal', 'strafe', 'lawsuit', 'investigation', 'kartell'],
    text: 'Rechtliche Risiken könnten den Kurs noch länger belasten.' },
  { words: ['einbruch', 'bricht ein', 'nachfrageschwäche', 'absatzflaute', 'gewinn fällt', 'umsatz fällt', 'verlust', 'schwaches quartal'],
    text: 'Die operative Schwäche könnte anhalten und weiter auf dem Kurs lasten.' },
  { words: ['streik', 'rückruf', 'produktionsstopp', 'lieferprobleme'],
    text: 'Produktionsprobleme oder Streiks könnten kurzfristig Umsatz kosten.' },
  { words: ['konkurrenz', 'wettbewerbsdruck', 'verliert marktanteile', 'marktanteil'],
    text: 'Wachsende Konkurrenz könnte Marktanteile und Gewinnmargen drücken.' },
];

// Findet pro Regel höchstens einen Treffer in den Meldungen → {text, item}
function matchNewsRules(news, rules, max = 3) {
  const out = [];
  for (const rule of rules) {
    if (out.length >= max) break;
    for (const it of news) {
      const t = (it.title + ' ' + (it.desc || '')).toLowerCase();
      if (rule.words.some((w) => t.includes(w))) {
        out.push({ text: rule.text, item: it });
        break;
      }
    }
  }
  return out;
}

// ---------- Aktien: Daten laden ----------
async function searchStocks(q) {
  try {
    const data = await fetchJsonViaProxy(YQ.search(q));
    return (data.quotes || [])
      .filter((r) => ['EQUITY', 'ETF'].includes(r.quoteType))
      .map((r) => ({ symbol: r.symbol, name: r.shortname || r.longname || r.symbol, exch: r.exchDisp || '' }));
  } catch { return []; }
}

const stockCache = new Map(); // symbol → { name, points, stockNews, analysis, meta, ts }

async function loadStock(symbol, name) {
  const seq = ++stockLoadSeq;
  currentStock = { symbol, name };
  localStorage.setItem(STOCK_KEY, JSON.stringify(currentStock));
  el.stockContent.dataset.loaded = '1';
  markQuickActive();
  const movesBox = $('topMovesBox');
  if (movesBox) movesBox.open = false; // Platz für die Analyse machen

  // Stale-while-revalidate: bereits geladene Aktie sofort anzeigen, dann im Hintergrund frisch holen
  const cachedStock = stockCache.get(symbol);
  if (cachedStock) {
    renderStock(symbol, cachedStock.name, cachedStock.points, cachedStock.stockNews, cachedStock.analysis, cachedStock.meta);
    el.stockContent.scrollIntoView({ block: 'nearest' });
  } else {
    el.stockContent.innerHTML = '<div class="skeletons"><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>';
  }

  // Kurs & KGV-Historie parallel laden – jedes darf einzeln scheitern
  const [chartR, peR] = await Promise.allSettled([
    fetchJsonViaProxy(YQ.chart(symbol)),
    fetchJsonViaProxy(YQ.pe(symbol)),
  ]);
  if (seq !== stockLoadSeq) return; // Nutzer hat inzwischen andere Aktie gewählt

  const chart = chartR.status === 'fulfilled' ? chartR.value?.chart?.result?.[0] : null;
  const peSeries = peR.status === 'fulfilled' ? parsePeSeries(peR.value) : [];
  let stockNews = [];

  if (!chart) {
    el.stockContent.innerHTML = `<div class="status error">Kursdaten für „${escapeHtml(name)}" konnten nicht geladen werden. Prüfe deine Verbindung und versuch es erneut.</div>`;
    return;
  }

  // Kurspunkte extrahieren
  const ts = chart.timestamp || [];
  const closesRaw = chart.indicators?.quote?.[0]?.close || [];
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    if (closesRaw[i] != null) points.push({ t: new Date(ts[i] * 1000), c: closesRaw[i] });
  }
  if (points.length < 10) {
    el.stockContent.innerHTML = '<div class="status error">Zu wenige Kursdaten für eine Analyse.</div>';
    return;
  }

  // Nachrichten aus den bereits geladenen Feeds ergänzen, die die Firma erwähnen
  if (!feedItemsCache.items.length) { try { await getFeedItems(false); } catch {} if (seq !== stockLoadSeq) return; }
  const token = companyToken(name);
  for (const it of feedItemsCache.items) {
    if (mentionsCompany(it.title + ' ' + (it.desc || ''), token)) stockNews.push(it);
  }
  // Duplikate raus, auf 8 begrenzen, neueste zuerst
  const seen = new Set();
  stockNews = stockNews.filter((n) => {
    const k = n.title.slice(0, 60);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, 8);

  const analysis = analyzeStock(points, peSeries, stockNews);
  const meta = chart.meta || {};
  stockCache.set(symbol, { name, points, stockNews, analysis, meta, ts: Date.now() });
  renderStock(symbol, name, points, stockNews, analysis, meta);
}

// KGV-Zeitreihe aus Yahoo-Antwort extrahieren → [{t: Date, v: number}]
function parsePeSeries(json) {
  try {
    const entries = json?.timeseries?.result?.[0]?.trailingPeRatio || [];
    return entries
      .filter(Boolean)
      .map((e) => ({ t: new Date(e.asOfDate), v: e.reportedValue?.raw }))
      .filter((e) => e.v != null && isFinite(e.v) && !isNaN(e.t))
      .sort((a, b) => a.t - b.t);
  } catch { return []; }
}

// ---------- Aktien: Analyse-Heuristik ----------
function analyzeStock(points, peSeries, news) {
  const closes = points.map((p) => p.c);
  const nowP = closes[closes.length - 1];

  // Technik
  const sma50 = avg(closes.slice(-50));
  const idx30 = Math.max(0, closes.length - 22);           // ~30 Kalendertage
  const mom30 = (nowP / closes[idx30] - 1) * 100;
  const idx6m = Math.max(0, closes.length - 126);          // ~6 Monate Handelstage
  const p6m = closes[idx6m];
  const chg6m = (nowP / p6m - 1) * 100;
  const chg1y = (nowP / closes[0] - 1) * 100;
  const hi52 = Math.max(...closes), lo52 = Math.min(...closes);

  // KGV aus berichteter Historie; "aktuell" anhand des Kurses fortgeschrieben
  let peNow = null, pePast = null, pePastDate = null, peLastDate = null;
  if (peSeries.length) {
    const priceAt = (d) => {
      let best = nowP, bd = Infinity;
      for (const p of points) {
        const diff = Math.abs(p.t - d);
        if (diff < bd) { bd = diff; best = p.c; }
      }
      return best;
    };
    const last = peSeries[peSeries.length - 1];
    peLastDate = last.t;
    peNow = last.v * (nowP / priceAt(last.t));   // Annahme: Gewinn seit letztem Bericht konstant
    const target = Date.now() - 183 * 24 * 3.6e6;
    let bestE = peSeries[0], bd = Infinity;
    for (const e of peSeries) {
      const diff = Math.abs(e.t - target);
      if (diff < bd) { bd = diff; bestE = e; }
    }
    pePast = bestE.v;
    pePastDate = bestE.t;
  }

  // Stimmung je Meldung markieren (für die Nachrichtenliste)
  let posN = 0, negN = 0;
  for (const n of news) {
    n.senti = sentimentOf(n);
    if (n.senti === 'pos') posN++;
    if (n.senti === 'neg') negN++;
  }

  // Zukunfts-Argumente sammeln: {text, item?, w} – w = Gewicht für den Gesamtscore
  const pros = [], cons = [];
  matchNewsRules(news, PRO_NEWS_RULES).forEach((f) => pros.push({ ...f, w: 2 }));
  matchNewsRules(news, CON_NEWS_RULES).forEach((f) => cons.push({ ...f, w: 2 }));

  // Trend: laufende Trends setzen sich statistisch öfter fort, als dass sie drehen.
  // Kurzfrist (1 Monat) und längerfristig (6 Monate) getrennt bewerten, damit eine
  // kleine Delle in einem intakten Aufwärtstrend nicht als "Absturz" gilt.
  const uptrend = nowP > sma50;
  if (uptrend && mom30 > 2) {
    pros.push({ text: `Der Aufwärtstrend ist intakt (${fmtPct(mom30)} im letzten Monat) – laufende Trends setzen sich öfter fort, als dass sie drehen.`, w: 1.5 });
  } else if (!uptrend && mom30 < -2 && chg6m < 0) {
    cons.push({ text: `Der Abwärtstrend ist ungebrochen (${fmtPct(mom30)} im letzten Monat) – ohne frische Kaufargumente dürfte die Schwäche zunächst anhalten.`, w: 1.5 });
  } else if (!uptrend && mom30 < -2) {
    cons.push({ text: `Kurzfristig hat der Kurs nachgegeben (${fmtPct(mom30)} im letzten Monat) – das kann eine Pause im Aufwärtstrend sein, birgt aber Rückschlagrisiko.`, w: 0.7 });
  } else if (uptrend) {
    pros.push({ text: 'Der Kurs hält sich über dem 50-Tage-Durchschnitt – die Käufer haben derzeit leicht die Oberhand.', w: 0.8 });
  } else {
    cons.push({ text: 'Der Kurs notiert unter dem 50-Tage-Durchschnitt – die Verkäufer haben derzeit leicht die Oberhand.', w: 0.8 });
  }

  // Längerfristige Richtung (6 Monate) zählt ebenfalls
  if (chg6m > 12) {
    pros.push({ text: `Auf 6-Monats-Sicht liegt die Aktie klar vorn (${fmtPct(chg6m)}) – längerfristige Stärke zieht oft weitere Anleger an.`, w: 1 });
  } else if (chg6m < -12) {
    cons.push({ text: `Auf 6-Monats-Sicht hat die Aktie deutlich verloren (${fmtPct(chg6m)}) – verlorenes Vertrauen kehrt meist nur langsam zurück.`, w: 1 });
  }

  // Boden-Suche nahe dem 52-Wochen-Tief
  if (!uptrend && chg6m < 0 && (nowP / lo52 - 1) * 100 < 8) {
    cons.push({ text: 'Die Aktie notiert nahe ihrem 52-Wochen-Tief und hat noch keinen Boden gefunden – viele Anleger warten ab, bis die Talfahrt stoppt.', w: 1 });
  }

  // Bewertung: entscheidet mit, wie viel Luft nach oben/unten bleibt
  if (peNow != null) {
    if (peNow > 40) {
      cons.push({ text: `Das hohe KGV von ${fmtNum(peNow)} lässt wenig Raum für Enttäuschungen – schlechte Nachrichten würden dann doppelt durchschlagen.`, w: 1 });
    } else if (peNow > 0 && peNow < 12) {
      pros.push({ text: `Das niedrige KGV von ${fmtNum(peNow)} begrenzt das Rückschlagrisiko – viel Pessimismus ist bereits eingepreist.`, w: 1 });
    }
    if (pePast != null && peNow < pePast * 0.7 && peNow <= 30) {
      pros.push({ text: `Die Bewertung ist deutlich gesunken (KGV ${fmtNum(pePast)} → ${fmtNum(peNow)}) – auf diesem Niveau steigen die Chancen auf eine Erholung.`, w: 0.8 });
    }
  }

  // Stärkste Argumente zuerst anzeigen
  pros.sort((a, b) => b.w - a.w);
  cons.sort((a, b) => b.w - a.w);

  // Gesamtscore → Ausblick
  const score = pros.reduce((s, f) => s + f.w, 0) - cons.reduce((s, f) => s + f.w, 0);
  let dir, label, icon, lead;
  if (score >= 1.5) {
    dir = 'up'; label = 'Ausblick: eher steigend'; icon = '📈';
    lead = 'Die Argumente für steigende Kurse überwiegen derzeit.';
  } else if (score <= -1.5) {
    dir = 'down'; label = 'Ausblick: eher fallend'; icon = '📉';
    lead = 'Die Argumente für fallende Kurse überwiegen derzeit.';
  } else {
    dir = 'flat'; label = 'Ausblick: unklar / seitwärts'; icon = '➖';
    lead = 'Die Argumente halten sich in etwa die Waage – keine klare Richtung erkennbar.';
  }
  if (!news.length) lead += ' Hinweis: Zu dieser Aktie wurden aktuell kaum Meldungen gefunden, die Einschätzung stützt sich vor allem auf Kursverlauf und Bewertung.';
  const conf = Math.abs(score) >= 3.5 ? 'mittlere Sicherheit' : 'geringe Sicherheit';

  return { dir, label, icon, conf, lead, pros, cons, posN, negN,
           sma50, mom30, chg6m, chg1y, hi52, lo52, peNow, pePast, pePastDate, peLastDate, peSeries, nowP };
}

const MONTHS_DE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
function shortDate(d) { return MONTHS_DE[d.getMonth()] + ' ' + String(d.getFullYear()).slice(2); }

function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function clampNum(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function fmtNum(n, digits = 1) {
  return n == null || !isFinite(n) ? '–' : n.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtPct(n) { return (n > 0 ? '+' : '') + fmtNum(n) + ' %'; }

// ---------- Aktien: Chart als SVG ----------
function buildChartSVG(points) {
  const w = 600, h = 210, padL = 6, padR = 6, padT = 12, padB = 24;
  const closes = points.map((p) => p.c);
  const min = Math.min(...closes), max = Math.max(...closes);
  const span = max - min || 1;
  const iw = w - padL - padR, ih = h - padT - padB;

  const x = (i) => padL + (i / (points.length - 1)) * iw;
  const y = (c) => padT + (1 - (c - min) / span) * ih;

  let d = '';
  points.forEach((p, i) => { d += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.c).toFixed(1); });
  const up = closes[closes.length - 1] >= closes[0];
  const col = up ? '#22c55e' : '#ef4444';
  const area = d + `L${(padL + iw).toFixed(1)} ${padT + ih}L${padL} ${padT + ih}Z`;

  const lbl = (p) => shortDate(p.t);
  const midP = points[Math.floor(points.length / 2)];

  return `
  <svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Kursverlauf 1 Jahr">
    <defs>
      <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${col}" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="${col}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${area}" fill="url(#chartFill)"/>
    <path d="${d}" fill="none" stroke="${col}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(closes[closes.length - 1]).toFixed(1)}" r="4" fill="${col}"/>
    <text x="${padL}" y="${h - 6}" font-size="11" fill="#64748b">${lbl(points[0])}</text>
    <text x="${w / 2}" y="${h - 6}" font-size="11" fill="#64748b" text-anchor="middle">${lbl(midP)}</text>
    <text x="${w - padR}" y="${h - 6}" font-size="11" fill="#64748b" text-anchor="end">${lbl(points[points.length - 1])}</text>
    <text x="${padL + 2}" y="${(y(max) + 12).toFixed(1)}" font-size="11" fill="#64748b">Hoch ${fmtNum(max, 2)}</text>
    <text x="${padL + 2}" y="${(y(min) - 5).toFixed(1)}" font-size="11" fill="#64748b">Tief ${fmtNum(min, 2)}</text>
  </svg>`;
}

// ---------- Aktien: Rendering ----------
function renderStock(symbol, name, points, news, an, meta) {
  const currency = meta.currency === 'EUR' ? '€' : meta.currency === 'USD' ? '$' : (meta.currency || '');
  const closes = points.map((p) => p.c);
  const dayChg = closes.length > 1 ? (closes[closes.length - 1] / closes[closes.length - 2] - 1) * 100 : 0;
  const chgCls = (v) => v > 0.05 ? 'up' : v < -0.05 ? 'down' : 'flat';

  const peTrend = an.peSeries && an.peSeries.length > 1
    ? `<p class="kgv-note">Berichteter Verlauf: ${an.peSeries.map((e) => `${shortDate(e.t)}: ${fmtNum(e.v)}`).join(' → ')}</p>`
    : '';
  const kgvHtml = an.peNow != null ? `
    <div class="kgv-row">
      <div class="kgv-box"><div class="k">KGV ${shortDate(an.pePastDate)}</div><div class="v">${fmtNum(an.pePast)}</div></div>
      <div class="kgv-arrow">${an.peNow > an.pePast ? '➜ 📈' : '➜ 📉'}</div>
      <div class="kgv-box"><div class="k">KGV aktuell (geschätzt)</div><div class="v">${fmtNum(an.peNow)}</div></div>
    </div>
    ${peTrend}
    <p class="kgv-note">
      Die Aktie ist aktuell <strong>${an.peNow > an.pePast ? 'teurer' : 'günstiger'}</strong> bewertet als im ${shortDate(an.pePastDate)}.
      ${an.peNow > an.pePast
        ? 'Für die Zukunft heißt das: Die Erwartungen sind hoch – Enttäuschungen könnten den Kurs stärker treffen.'
        : 'Für die Zukunft heißt das: Es ist bereits viel Pessimismus eingepreist – positive Überraschungen hätten Luft nach oben.'}<br/>
      <em>KGV = Kurs-Gewinn-Verhältnis. Berichtete Werte von Yahoo Finance (Stand ${shortDate(an.peLastDate)}); „aktuell" anhand des Kurses fortgeschrieben.</em>
    </p>` : `
    <p class="kgv-note">Für diese Aktie sind gerade keine KGV-Daten verfügbar (z. B. bei Verlust oder wenn der Kennzahlen-Dienst nicht antwortet). Chart und Nachrichten-Analyse funktionieren trotzdem.</p>`;

  const newsHtml = news.length ? news.map((n) => `
    <li><a href="${escapeHtml(n.link)}" target="_blank" rel="noopener noreferrer">
      <span class="senti ${n.senti || 'neu'}">${n.senti === 'pos' ? '▲' : n.senti === 'neg' ? '▼' : '•'}</span>
      <span>${escapeHtml(n.title)}
        <span class="snews-meta">${escapeHtml(n.source)}${n.date ? ' · ' + relTime(n.date) : ''}</span>
      </span>
    </a></li>`).join('') : '<li class="none" style="list-style:none;color:var(--text-faint);font-size:0.85rem;">Keine aktuellen Meldungen zu dieser Aktie gefunden.</li>';

  // Argument-Listen für den Ausblick (mit Quelle, wenn aus einer Meldung abgeleitet)
  const factorHtml = (arr, none) => arr.length ? arr.map((f) => `
    <li>${escapeHtml(f.text)}
      ${f.item ? `<a class="opp-src" href="${escapeHtml(f.item.link)}" target="_blank" rel="noopener noreferrer">↳ ${escapeHtml(truncate(f.item.title, 85))} · ${escapeHtml(f.item.source)}</a>` : ''}
    </li>`).join('') : `<li class="none">${none}</li>`;

  const sentiLine = news.length
    ? `${an.posN} positiv · ${an.negN} negativ · ${news.length - an.posN - an.negN} neutral`
    : '';

  el.stockContent.innerHTML = `
    <div class="stock-block" style="animation-delay:0ms">
      <div class="stock-head">
        <div class="stock-name">
          <h2>${escapeHtml(name)}</h2>
          <span class="sym">${escapeHtml(symbol)}${meta.exchangeName ? ' · ' + escapeHtml(meta.exchangeName) : ''}</span>
        </div>
        <div class="stock-price">
          <div class="val">${fmtNum(an.nowP, 2)} ${currency}</div>
          <span class="chg ${chgCls(dayChg)}">${fmtPct(dayChg)} heute</span>
        </div>
      </div>
      <div class="chart-wrap">${buildChartSVG(points)}</div>
      <div class="stat-row">
        <div class="stat"><div class="k">1 Monat</div><div class="v ${chgCls(an.mom30)}">${fmtPct(an.mom30)}</div></div>
        <div class="stat"><div class="k">6 Monate</div><div class="v ${chgCls(an.chg6m)}">${fmtPct(an.chg6m)}</div></div>
        <div class="stat"><div class="k">1 Jahr</div><div class="v ${chgCls(an.chg1y)}">${fmtPct(an.chg1y)}</div></div>
      </div>
    </div>

    <div class="stock-block" style="animation-delay:70ms">
      <div class="block-title">Ausblick – steigt oder fällt die Aktie?</div>
      <div class="verdict ${an.dir}">
        <div class="verdict-icon">${an.icon}</div>
        <div>
          <h3>${an.label}</h3>
          <span class="conf">${an.conf} · automatische Einschätzung</span>
        </div>
      </div>
      <p class="verdict-reason">${an.lead}</p>
      <div class="procon">
        <div class="procon-col pro">
          <h4>✅ Was für steigende Kurse spricht</h4>
          <ul>${factorHtml(an.pros, 'Derzeit keine überzeugenden Argumente für steigende Kurse gefunden.')}</ul>
        </div>
        <div class="procon-col con">
          <h4>⛔ Was für fallende Kurse spricht</h4>
          <ul>${factorHtml(an.cons, 'Derzeit keine klaren Warnsignale gefunden.')}</ul>
        </div>
      </div>
    </div>

    <div class="stock-block" style="animation-delay:140ms">
      <div class="block-title">Bewertung & Kennzahlen</div>
      ${kgvHtml}
      <div class="stat-row" style="margin-top:12px">
        <div class="stat"><div class="k">52W-Hoch</div><div class="v">${fmtNum(an.hi52, 2)}</div></div>
        <div class="stat"><div class="k">52W-Tief</div><div class="v">${fmtNum(an.lo52, 2)}</div></div>
      </div>
    </div>

    <div class="stock-block" style="animation-delay:210ms">
      <div class="block-title">Nachrichtenlage${sentiLine ? ` <span class="senti-line">${sentiLine}</span>` : ''}</div>
      <ul class="snews-list">${newsHtml}</ul>
    </div>

    <div class="disclaimer">
      ⚠️ <strong>Keine Anlageberatung:</strong> Der Ausblick wird automatisch aus Nachrichten, Trend und Bewertung abgeleitet. Er kann falsch liegen und ersetzt keine eigene Recherche oder professionelle Beratung.
    </div>
  `;
}

// ---------- Aktien: Top Moves ----------
let movesLoadedAt = 0;
let movesLoading = false;

async function loadTopMoves(force = false) {
  if (movesLoading) return;
  if (!force && movesLoadedAt && Date.now() - movesLoadedAt < 10 * 60 * 1000) return;
  movesLoading = true;
  const box = $('topMoves');

  try {
    // In 15er-Blöcken abfragen – längere URLs lehnen manche Proxies ab (HTTP 400)
    const syms = MOVERS_UNIVERSE.map(([s]) => s).concat(MARKET_INDEX);
    const chunks = [];
    for (let i = 0; i < syms.length; i += 15) chunks.push(syms.slice(i, i + 15));
    const results = await Promise.allSettled(chunks.map((c) => fetchJsonViaProxy(YQ.spark(c))));
    const data = {};
    for (const r of results) if (r.status === 'fulfilled') Object.assign(data, r.value);

    // Tagesbewegung je Symbol: letzter Schlusskurs vs. Vortag
    const moves = [];
    let idxChg = null;
    let lastTradeDay = null;
    for (const [sym, name] of MOVERS_UNIVERSE.concat([[MARKET_INDEX, 'DAX']])) {
      const d = data[sym];
      const closes = (d?.close || []).filter((c) => c != null);
      if (closes.length < 2) continue;
      const chg = (closes[closes.length - 1] / closes[closes.length - 2] - 1) * 100;
      if (sym === MARKET_INDEX) { idxChg = chg; continue; }
      moves.push({ symbol: sym, name, chg, price: closes[closes.length - 1] });
      const ts = d?.timestamp;
      if (ts?.length) {
        const day = new Date(ts[ts.length - 1] * 1000);
        if (!lastTradeDay || day > lastTradeDay) lastTradeDay = day;
      }
    }
    if (moves.length < 5) throw new Error('zu wenige Kursdaten');

    moves.sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg));
    const top = moves.slice(0, MOVES_COUNT);
    movesLoadedAt = Date.now();

    // Untertitel: Datum des Handelstags (falls nicht heute → "letzter Handelstag")
    if (lastTradeDay) {
      const today = new Date();
      const sameDay = lastTradeDay.toDateString() === today.toDateString();
      $('movesSub').textContent = (sameDay ? 'heute, ' : 'letzter Handelstag, ')
        + lastTradeDay.toLocaleDateString('de-DE', { day: 'numeric', month: 'long' });
    }

    renderTopMoves(top, idxChg);

    // Für die Erklärungen die geladenen Feeds nutzen – falls noch nicht da, kurz holen
    if (!feedItemsCache.items.length) { try { await getFeedItems(false); } catch {} }
    top.forEach((m) => explainMove(m, idxChg));
  } catch (e) {
    box.innerHTML = `<div class="moves-error">Top Moves konnten nicht geladen werden (${escapeHtml(e.message)}). Über ⟳ oben erneut versuchen.</div>`;
    movesLoadedAt = 0;
  } finally {
    movesLoading = false;
  }
}

function renderTopMoves(top, idxChg) {
  const box = $('topMoves');
  const chgCls = (v) => v > 0.05 ? 'up' : v < -0.05 ? 'down' : 'flat';
  box.innerHTML = top.map((m, i) => `
    <button class="move-row" data-symbol="${escapeHtml(m.symbol)}" data-name="${escapeHtml(m.name)}" style="animation-delay:${i * 40}ms">
      <div class="move-head">
        <span class="move-name">${escapeHtml(m.name)}<span class="sym">${escapeHtml(m.symbol)}</span></span>
        <span class="chg ${chgCls(m.chg)}">${fmtPct(m.chg)}</span>
      </div>
      <div class="move-reason" id="reason-${cssId(m.symbol)}"><span class="searching">Auslöser wird gesucht …</span></div>
    </button>`).join('')
    + (idxChg != null ? `<div class="moves-loading">Zum Vergleich: DAX ${fmtPct(idxChg)}</div>` : '');
}

function cssId(sym) { return sym.replace(/[^a-zA-Z0-9]/g, '_'); }

async function explainMove(m, idxChg) {
  const target = $('reason-' + cssId(m.symbol));
  if (!target) return;

  const token = companyToken(m.name);

  // Die bereits geladenen Feeds durchsuchen (kein Netz!) – finanzen.net nennt häufig
  // einzelne Aktien namentlich. Nur ganze Wörter zählen.
  const items = feedItemsCache.items.filter((it) =>
    mentionsCompany(it.title + ' ' + (it.desc || ''), token));

  // Nur frische Meldungen (letzte 4 Tage); passende Stimmung bevorzugen
  const fresh = items.filter((n) => n.date && Date.now() - n.date.getTime() < 4 * 24 * 3.6e6);
  const wanted = m.chg >= 0 ? 'pos' : 'neg';
  fresh.sort((a, b) => {
    const sa = sentimentOf(a) === wanted ? 0 : 1;
    const sb = sentimentOf(b) === wanted ? 0 : 1;
    return sa - sb || b.date - a.date;
  });
  const best = fresh[0];

  const marketNote = idxChg != null && Math.abs(idxChg) >= 0.8 && Math.sign(idxChg) === Math.sign(m.chg)
    ? ` Der Gesamtmarkt bewegte sich ähnlich (DAX ${fmtPct(idxChg)}) – vermutlich Teil einer breiten Marktbewegung.`
    : '';

  if (best) {
    const fits = sentimentOf(best) === wanted;
    target.innerHTML = `${fits ? 'Möglicher Auslöser' : 'Dazu gefunden'}: „<a href="${escapeHtml(best.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(truncate(best.title, 110))}</a>“ · ${escapeHtml(best.source)}${best.date ? ' · ' + relTime(best.date) : ''}${marketNote}`;
  } else if (marketNote) {
    target.innerHTML = `Kein firmenspezifischer Auslöser in unseren Quellen gefunden.${marketNote}`;
  } else {
    target.innerHTML = 'Kein klarer Nachrichten-Auslöser in unseren Quellen gefunden.';
  }
}

// Klick auf einen Top Move → volle Analyse
$('topMoves').addEventListener('click', (e) => {
  const row = e.target.closest('.move-row');
  if (!row || e.target.closest('a')) return; // Links in der Erklärung nicht abfangen
  loadStock(row.dataset.symbol, row.dataset.name);
});

// ---------- Aktien: Suche & Quick-Picks ----------
function buildQuickChips() {
  el.stockQuick.innerHTML = '';
  QUICK_STOCKS.forEach(([sym, label]) => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = label;
    chip.dataset.symbol = sym;
    chip.addEventListener('click', () => {
      el.stockInput.value = '';
      el.stockResults.hidden = true;
      loadStock(sym, label);
    });
    el.stockQuick.appendChild(chip);
  });
  markQuickActive();
}
function markQuickActive() {
  document.querySelectorAll('#stockQuick .chip').forEach((c) =>
    c.classList.toggle('active', currentStock && c.dataset.symbol === currentStock.symbol));
}

let searchTimer = null;
el.stockInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = el.stockInput.value.trim();
  if (q.length < 2) { el.stockResults.hidden = true; return; }
  searchTimer = setTimeout(async () => {
    const results = await searchStocks(q);
    if (el.stockInput.value.trim() !== q) return; // veraltet
    el.stockResults.innerHTML = results.length
      ? results.map((r) => `
        <button class="search-result" data-symbol="${escapeHtml(r.symbol)}" data-name="${escapeHtml(r.name)}">
          <span>${escapeHtml(r.name)}</span>
          <span class="sym">${escapeHtml(r.symbol)}${r.exch ? ' · ' + escapeHtml(r.exch) : ''}</span>
        </button>`).join('')
      : '<div class="search-result" style="cursor:default;color:var(--text-faint)">Nichts gefunden</div>';
    el.stockResults.hidden = false;
  }, 400);
});
el.stockResults.addEventListener('click', (e) => {
  const btn = e.target.closest('.search-result[data-symbol]');
  if (!btn) return;
  el.stockResults.hidden = true;
  el.stockInput.value = '';
  loadStock(btn.dataset.symbol, btn.dataset.name);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.stock-search')) el.stockResults.hidden = true;
});

// ---------- Settings UI ----------
function buildSettingsUI() {
  el.countRange.value = settings.count;
  el.countValue.textContent = settings.count;

  el.topicChips.innerHTML = '';
  TOPICS.forEach((t) => {
    const chip = document.createElement('button');
    chip.className = 'chip' + (settings.topics.includes(t.id) ? ' active' : '');
    chip.textContent = t.label;
    chip.dataset.id = t.id;
    chip.addEventListener('click', () => toggleTopic(t.id, chip));
    el.topicChips.appendChild(chip);
  });
}
function toggleTopic(id, chip) {
  const i = settings.topics.indexOf(id);
  if (i >= 0) {
    if (settings.topics.length === 1) return;
    settings.topics.splice(i, 1);
    chip.classList.remove('active');
  } else {
    settings.topics.push(id);
    chip.classList.add('active');
  }
  saveSettings();
}
function openSettings() { buildSettingsUI(); el.overlay.hidden = false; }
function closeSettings() { el.overlay.hidden = true; loadNews(); }

// ---------- Events ----------
el.refreshBtn.addEventListener('click', () => {
  if (currentView === 'news') loadNews(false);
  else if (currentView === 'ticker') loadTicker(true);
  else if (currentView === 'stock') {
    loadTopMoves(true);
    if (currentStock) loadStock(currentStock.symbol, currentStock.name);
  }
});
el.settingsBtn.addEventListener('click', openSettings);
el.closeSettings.addEventListener('click', closeSettings);
el.overlay.addEventListener('click', (e) => { if (e.target === el.overlay) closeSettings(); });
el.countRange.addEventListener('input', () => {
  settings.count = clamp(el.countRange.value, 3, 10);
  el.countValue.textContent = settings.count;
});
el.countRange.addEventListener('change', () => {
  saveSettings();
  const cached = readCache();
  if (cached) render(cached.clusters);
});

document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => switchView(t.dataset.view)));

el.dateLine.textContent = new Date().toLocaleDateString('de-DE', {
  weekday: 'long', day: 'numeric', month: 'long',
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const cached = readCache();
    if (!cached || Date.now() - cached.ts > 10 * 60 * 1000) loadNews(true);
    if (currentView === 'ticker') loadTicker(true);
  }
});

// ---------- Sprach-Begrüßung ----------
let greeted = false;

function greetingText() {
  const h = new Date().getHours();
  const teil = h < 5 ? 'Guten Abend' : h < 11 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend';
  return `${teil}, Herr Zacharias`;
}

function speakGreeting(force = false) {
  if (!('speechSynthesis' in window)) return;
  if (greeted && !force) return;

  let fired = false;
  const say = () => {
    if (fired) return;
    fired = true;
    const btn = $('speakBtn');
    const u = new SpeechSynthesisUtterance(greetingText());
    u.lang = 'de-DE';
    u.rate = 0.98;
    u.pitch = 1.0;
    const de = speechSynthesis.getVoices().find((v) => /^de/i.test(v.lang));
    if (de) u.voice = de;
    u.onstart = () => { greeted = true; btn?.classList.add('speaking'); };
    u.onend = () => btn?.classList.remove('speaking');
    u.onerror = () => btn?.classList.remove('speaking');
    try {
      // Nur abbrechen, wenn wirklich etwas läuft – cancel() direkt vor speak() lässt
      // die Ansage in manchen Browsern verstummen.
      if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch {}
  };

  // Stimmen werden in manchen Browsern erst asynchron geladen
  if (speechSynthesis.getVoices().length) say();
  else {
    speechSynthesis.addEventListener('voiceschanged', say, { once: true });
    setTimeout(say, 400); // Fallback, falls das Event ausbleibt
  }
}

if ('speechSynthesis' in window) {
  // Direktversuch beim Öffnen (klappt, wenn der Browser Audio ohne Geste erlaubt)
  setTimeout(() => speakGreeting(), 500);
  // Fallback: spätestens bei der ersten Berührung/Taste begrüßen (umgeht Autoplay-Sperre)
  window.addEventListener('pointerdown', () => speakGreeting(), { once: true });
  window.addEventListener('keydown', () => speakGreeting(), { once: true });
  // Lautsprecher-Knopf: jederzeit erneut abspielen
  $('speakBtn')?.addEventListener('click', (e) => { e.stopPropagation(); speakGreeting(true); });
} else {
  $('speakBtn')?.remove(); // Browser kann keine Sprachausgabe
}

// Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// Start
buildQuickChips();
loadNews(true);
