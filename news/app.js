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
  { name: 'Spiegel Wirtschaft',    cat: 'wirtschaft', prio: 1, url: 'https://www.spiegel.de/wirtschaft/index.rss' },
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
  (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
  (u) => 'https://thingproxy.freeboard.io/fetch/' + u,
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
};

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
async function fetchViaProxy(url) {
  let lastErr;
  for (const build of PROXIES) {
    try {
      const res = await fetch(build(url), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (text && text.length > 80) return text;
      throw new Error('leere Antwort');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Alle Proxies fehlgeschlagen');
}
async function fetchJsonViaProxy(url) {
  const t = await fetchViaProxy(url);
  return JSON.parse(t);
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

async function fetchAllFeeds(feeds) {
  const results = await Promise.allSettled(
    feeds.map((f) => fetchViaProxy(f.url).then((xml) => parseFeed(xml, f)))
  );
  const all = [];
  results.forEach((r) => { if (r.status === 'fulfilled') all.push(...r.value); });
  return all;
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

  const activeFeeds = FEEDS.filter((f) => settings.topics.includes(f.cat));
  if (!activeFeeds.length) activeFeeds.push(...FEEDS);

  if (useCacheFirst) {
    const cached = readCache();
    if (cached) { render(cached.clusters); setUpdated(cached.ts, true); }
    else showSkeletons(el.skeletons, true);
  } else {
    showSkeletons(el.skeletons, true);
    hideStatus();
  }

  try {
    const all = await fetchAllFeeds(activeFeeds);

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
async function loadTicker() {
  if (tickerLoading) return;
  tickerLoading = true;
  if (!el.tickerList.children.length) showSkeletons(el.tickerSkeletons, true, 6);

  try {
    const all = await fetchAllFeeds(FEEDS);
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
    if (document.visibilityState === 'visible' && currentView === 'ticker') loadTicker();
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

// ---------- Aktien: Daten laden ----------
async function searchStocks(q) {
  try {
    const data = await fetchJsonViaProxy(YQ.search(q));
    return (data.quotes || [])
      .filter((r) => ['EQUITY', 'ETF'].includes(r.quoteType))
      .map((r) => ({ symbol: r.symbol, name: r.shortname || r.longname || r.symbol, exch: r.exchDisp || '' }));
  } catch { return []; }
}

async function loadStock(symbol, name) {
  const seq = ++stockLoadSeq;
  currentStock = { symbol, name };
  localStorage.setItem(STOCK_KEY, JSON.stringify(currentStock));
  el.stockContent.dataset.loaded = '1';
  el.stockContent.innerHTML = '<div class="skeletons"><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>';
  markQuickActive();

  // Chart, KGV-Historie und Nachrichten parallel laden – jedes darf einzeln scheitern
  const [chartR, peR, newsR] = await Promise.allSettled([
    fetchJsonViaProxy(YQ.chart(symbol)),
    fetchJsonViaProxy(YQ.pe(symbol)),
    fetchViaProxy(YQ.news(symbol)).then((xml) =>
      parseFeed(xml, { name: 'Yahoo Finance', cat: 'aktien', prio: 1 })),
  ]);
  if (seq !== stockLoadSeq) return; // Nutzer hat inzwischen andere Aktie gewählt

  const chart = chartR.status === 'fulfilled' ? chartR.value?.chart?.result?.[0] : null;
  const peSeries = peR.status === 'fulfilled' ? parsePeSeries(peR.value) : [];
  let stockNews = newsR.status === 'fulfilled' ? newsR.value : [];

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

  // Nachrichten aus den allgemeinen Feeds ergänzen, die die Firma erwähnen
  const token = name.toLowerCase().replace(/\s+(ag|se|inc\.?|corp\.?|co\.?|plc)\b.*$/i, '').trim();
  try {
    const cached = readCache();
    if (cached) {
      for (const cl of cached.clusters) {
        const t = (cl.lead.title + ' ' + (cl.lead.desc || '')).toLowerCase();
        if (token.length > 2 && t.includes(token)) stockNews.push(cl.lead);
      }
    }
  } catch {}
  // Duplikate raus, auf 8 begrenzen, neueste zuerst
  const seen = new Set();
  stockNews = stockNews.filter((n) => {
    const k = n.title.slice(0, 60);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, 8);

  const analysis = analyzeStock(points, peSeries, stockNews);
  renderStock(symbol, name, points, stockNews, analysis, chart.meta || {});
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

  // Nachrichten-Stimmung
  let posN = 0, negN = 0;
  const pros = [], cons = [];
  for (const n of news) {
    const s = sentimentOf(n);
    n.senti = s;
    if (s === 'pos') { posN++; if (pros.length < 3) pros.push(`Positive Meldung: „${truncate(n.title, 90)}“`); }
    if (s === 'neg') { negN++; if (cons.length < 3) cons.push(`Negative Meldung: „${truncate(n.title, 90)}“`); }
  }

  // Technische Pro/Kontra
  if (nowP > sma50) pros.push('Kurs liegt über dem 50-Tage-Durchschnitt (kurzfristiger Aufwärtstrend)');
  else cons.push('Kurs liegt unter dem 50-Tage-Durchschnitt (kurzfristiger Abwärtstrend)');
  if (mom30 > 3) pros.push(`Positives Momentum: ${fmtPct(mom30)} in den letzten ~30 Tagen`);
  else if (mom30 < -3) cons.push(`Negatives Momentum: ${fmtPct(mom30)} in den letzten ~30 Tagen`);
  if (chg6m > 15) pros.push(`Starker 6-Monats-Trend: ${fmtPct(chg6m)}`);
  else if (chg6m < -15) cons.push(`Schwacher 6-Monats-Trend: ${fmtPct(chg6m)}`);
  if (peNow != null && peNow > 40) cons.push(`Hohes KGV von ${fmtNum(peNow)} – die Aktie ist sportlich bewertet`);
  if (peNow != null && peNow > 0 && peNow < 12) pros.push(`Niedriges KGV von ${fmtNum(peNow)} – vergleichsweise günstige Bewertung`);

  // Gesamtscore → Tendenz
  const newsScore = clampNum(posN - negN, -4, 4);
  let techScore = 0;
  techScore += nowP > sma50 ? 1 : -1;
  if (mom30 > 3) techScore += 1; else if (mom30 < -3) techScore -= 1;
  const total = newsScore + techScore;

  let dir, label, icon;
  if (total >= 2) { dir = 'up'; label = 'Tendenz: eher steigend'; icon = '📈'; }
  else if (total <= -2) { dir = 'down'; label = 'Tendenz: eher fallend'; icon = '📉'; }
  else { dir = 'flat'; label = 'Tendenz: neutral / seitwärts'; icon = '➖'; }
  const conf = Math.abs(total) >= 3 ? 'mittlere Sicherheit' : 'geringe Sicherheit';

  // Begründung
  const parts = [];
  if (posN || negN) parts.push(`In den aktuellen Meldungen überwiegen ${posN > negN ? 'positive' : posN < negN ? 'negative' : 'weder positive noch negative'} Signale (${posN} positiv, ${negN} negativ)`);
  else parts.push('Es wurden kaum aussagekräftige Meldungen zu dieser Aktie gefunden');
  parts.push(`der Kurs notiert ${nowP > sma50 ? 'über' : 'unter'} dem 50-Tage-Durchschnitt`);
  parts.push(`das Momentum der letzten ~30 Tage beträgt ${fmtPct(mom30)}`);
  if (peNow != null && pePast != null) {
    const dirWord = peNow > pePast ? 'gestiegen' : 'gefallen';
    parts.push(`das KGV ist von ca. ${fmtNum(pePast)} (${shortDate(pePastDate)}) auf aktuell ca. ${fmtNum(peNow)} ${dirWord}, die Aktie ist also ${peNow > pePast ? 'teurer' : 'günstiger'} bewertet als zuvor`);
  }
  const reason = parts.join('; ') + '.';

  return { dir, label, icon, conf, reason, pros, cons, posN, negN,
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
      Das KGV (Kurs-Gewinn-Verhältnis) ist seit ${shortDate(an.pePastDate)} ${an.peNow > an.pePast ? 'gestiegen – die Aktie ist <strong>teurer</strong> bewertet' : 'gefallen – die Aktie ist <strong>günstiger</strong> bewertet'} als zuvor.
      Ein hohes KGV heißt: Anleger zahlen viel pro Euro Gewinn.<br/>
      <em>Berichtete Werte von Yahoo Finance (Stand ${shortDate(an.peLastDate)}); „aktuell" anhand des Kurses fortgeschrieben.</em>
    </p>` : `
    <p class="kgv-note">Für diese Aktie sind gerade keine KGV-Daten verfügbar (z. B. bei Verlust oder wenn der Kennzahlen-Dienst nicht antwortet). Chart und Nachrichten-Analyse funktionieren trotzdem.</p>`;

  const newsHtml = news.length ? news.map((n) => `
    <li><a href="${escapeHtml(n.link)}" target="_blank" rel="noopener noreferrer">
      <span class="senti ${n.senti || 'neu'}">${n.senti === 'pos' ? '▲' : n.senti === 'neg' ? '▼' : '•'}</span>
      <span>${escapeHtml(n.title)}
        <span class="snews-meta">${escapeHtml(n.source)}${n.date ? ' · ' + relTime(n.date) : ''}</span>
      </span>
    </a></li>`).join('') : '<li class="none" style="list-style:none;color:var(--text-faint);font-size:0.85rem;">Keine aktuellen Meldungen gefunden.</li>';

  const liHtml = (arr, none) => arr.length
    ? arr.map((p) => `<li>${escapeHtml(p)}</li>`).join('')
    : `<li class="none">${none}</li>`;

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
      <div class="stat-row">
        <div class="stat"><div class="k">6 Monate</div><div class="v ${chgCls(an.chg6m)}">${fmtPct(an.chg6m)}</div></div>
        <div class="stat"><div class="k">1 Jahr</div><div class="v ${chgCls(an.chg1y)}">${fmtPct(an.chg1y)}</div></div>
        <div class="stat"><div class="k">52W-Hoch</div><div class="v">${fmtNum(an.hi52, 2)}</div></div>
        <div class="stat"><div class="k">52W-Tief</div><div class="v">${fmtNum(an.lo52, 2)}</div></div>
      </div>
    </div>

    <div class="stock-block" style="animation-delay:60ms">
      <div class="block-title">Kursverlauf · 1 Jahr</div>
      <div class="chart-wrap">${buildChartSVG(points)}</div>
    </div>

    <div class="stock-block" style="animation-delay:120ms">
      <div class="verdict ${an.dir}">
        <div class="verdict-icon">${an.icon}</div>
        <div>
          <h3>${an.label}</h3>
          <span class="conf">${an.conf} · automatische Einschätzung</span>
        </div>
      </div>
      <p class="verdict-reason"><strong>Begründung:</strong> ${an.reason}</p>
    </div>

    <div class="stock-block" style="animation-delay:180ms">
      <div class="block-title">Pro & Kontra</div>
      <div class="procon">
        <div class="procon-col pro">
          <h4>✅ Spricht für steigende Kurse</h4>
          <ul>${liHtml(an.pros, 'Keine positiven Signale gefunden.')}</ul>
        </div>
        <div class="procon-col con">
          <h4>⛔ Spricht für fallende Kurse</h4>
          <ul>${liHtml(an.cons, 'Keine negativen Signale gefunden.')}</ul>
        </div>
      </div>
    </div>

    <div class="stock-block" style="animation-delay:240ms">
      <div class="block-title">KGV – was ist passiert?</div>
      ${kgvHtml}
    </div>

    <div class="stock-block" style="animation-delay:300ms">
      <div class="block-title">Was ist passiert? · Aktuelle Meldungen</div>
      <ul class="snews-list">${newsHtml}</ul>
    </div>

    <div class="disclaimer">
      ⚠️ <strong>Keine Anlageberatung:</strong> Diese Einschätzung wird automatisch aus Schlagworten in Nachrichten und einfacher Chart-Statistik berechnet. Sie kann falsch liegen und ersetzt keine eigene Recherche oder professionelle Beratung.
    </div>
  `;
}

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
  else if (currentView === 'ticker') loadTicker();
  else if (currentView === 'stock' && currentStock) loadStock(currentStock.symbol, currentStock.name);
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
    if (currentView === 'ticker') loadTicker();
  }
});

// Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// Start
buildQuickChips();
loadNews(true);
