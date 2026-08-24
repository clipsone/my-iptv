#!/usr/bin/env node
/**
 * IPTV 直播源聚合器（零依赖，Node 18+）
 * 流程：拉取订阅 -> 解析(m3u/txt) -> 名称归一去重 -> 并发测速 -> 生成 output/iptv.m3u + report.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const CFG = JSON.parse(readFileSync(new URL('sources.json', ROOT)));
const OUT_DIR = new URL('output/', ROOT);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const env = process.env;
const TIMEOUT = Number(env.TIMEOUT ?? CFG.timeoutMs ?? 8000);
const CONCURRENCY = Number(env.CONCURRENCY ?? CFG.concurrency ?? 16);
const MAX_PROBE = Number(env.MAX_PROBE ?? CFG.maxProbe ?? 1500);
const MAX_PER_CH = Number(env.MAX_PER_CH ?? CFG.maxUrlsPerChannel ?? 3);
const RETRY_SUB = 1;
const DROP_KW = (CFG.dropKeywords || ['提示', '公告', '测试', '维护', '色情', '广告']);

/* ---------------- 工具 ---------------- */

function fetchT(url, opts, ms) {
  opts = opts || {}; ms = ms || TIMEOUT;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return fetch(url, { redirect: 'follow', ...opts, signal: ac.signal,
    headers: { 'user-agent': UA, ...(opts.headers || {}) } })
    .finally(() => clearTimeout(timer));
}

async function getText(url) {
  let lastErr;
  for (let i = 0; i <= RETRY_SUB; i++) {
    try {
      const r = await fetchT(url, {}, Math.max(TIMEOUT, 12000));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/** EXTINF 行按「引号外的第一个逗号」切分（属性值里可能带逗号） */
function splitExtinf(line) {
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ',' && !inQ) return [line.slice(0, i), line.slice(i + 1)];
  }
  return [line, ''];
}

function parseM3U(text) {
  const out = []; let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXTINF/i.test(line)) {
      const parts = splitExtinf(line);
      const attrPart = parts[0], name = parts[1];
      const attrs = {};
      for (const m of attrPart.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1].toLowerCase()] = m[2];
      cur = { name: (name || '').trim() || '未知频道', attrs: attrs, opts: [] };
    } else if (/^#EXTVLCOPT/i.test(line)) {
      if (cur) cur.opts.push(line);
    } else if (line.startsWith('#')) {
      /* 其他注释忽略 */
    } else if (cur) {
      cur.url = line; out.push(cur); cur = null;
    } else {
      out.push({ name: '未知频道', attrs: {}, opts: [], url: line });
    }
  }
  return out;
}

/** DIYP 风格 txt：「分组,#genre#」标记分组；普通行「名称,地址」 */
function parseTXT(text) {
  const out = []; let group = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.lastIndexOf(',');
    if (i < 1) continue;
    const left = line.slice(0, i).trim(), right = line.slice(i + 1).trim();
    if (/#genre#/i.test(right)) { group = left; continue; }
    if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(right)) {
      const attrs = group ? { 'group-title': group } : {};
      out.push({ name: left, attrs: attrs, opts: [], url: right });
    }
  }
  return out;
}

/* ---------------- 频道名归一 ---------------- */

const ALIAS = [
  [/^CCTV(\d{1,2})K$/, 'CCTV$1K'],
  [/^CCTV(\d{1,2})\+/, 'CCTV$1+'],
  [/^CCTV[-\u2014]?(\d{1,2})(K)?(综合|新闻|财经|综艺|中文国际|体育|少儿|农业|国防军事|戏曲|社会与法|法律|纪录|科教|频道)?$/, 'CCTV$1$2'],
  [/^央视(\d{1,2})$/, 'CCTV$1'],
  [/凤凰中文/, '凤凰中文'],
  [/凤凰资讯/, '凤凰资讯'],
  [/凤凰(卫视)?香港台?$|凤凰香港/, '凤凰香港'],
];

function normalizeName(raw) {
  let s = String(raw || '').trim()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[【\[]/g, '').replace(/[】\]]/g, '');
  s = s.replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.toUpperCase().replace(/^[-_.]+|[-_.]+$/g, '');
  for (const rule of ALIAS) {
    if (rule[0].test(s)) return s.replace(rule[0], rule[1]);
  }
  return s || raw;
}

const GROUP_RULES = [
  [/体育|赛事|足球|篮球|nba|cba|竞技/i, '体育'],
  [/港澳台|港台|凤凰/i, '港澳台'],
  [/纪录|documentary/i, '纪录'],
  [/少儿|卡通|动画|动漫|kids/i, '少儿'],
  [/电影|影院|movie/i, '电影'],
  [/剧场|连续剧|剧集/i, '剧场'],
  [/教育|纪实/i, '教育'],
  [/新视听|4k|8k|超高清/i, '4K/8K'],
];
const GROUP_ORDER = ['央视', '卫视', '体育', '港澳台', '国际', '电影', '剧场', '纪录', '少儿', '教育', '4K/8K'];

function normalizeGroup(group, name) {
  const g = String(group || '').trim();
  if (g && g !== '其他' && g !== '未分类') return g; // 上游已有分组原样保留
  if (/cctv|^cgtn|央视/i.test(name)) return '央视';
  if (/卫视$/.test(name)) return '卫视';
  for (const rule of GROUP_RULES) if (rule[0].test(name)) return rule[1];
  return '其他';
}

function orderOf(g) {
  const i = GROUP_ORDER.indexOf(g);
  return i < 0 ? 50 : i;
}

/* ---------------- 测速 ---------------- */

function extractOpts(opts) {
  const o = {};
  for (const line of opts || []) {
    const m = line.match(/:(http-[\w-]+)=(.+)/i);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'http-referrer') o.referer = v;
    if (k === 'http-user-agent') o.ua = v;
  }
  return o;
}

async function probe(item) {
  const headers = { Range: 'bytes=0-2047' };
  const ex = extractOpts(item.opts);
  if (ex.referer) headers['referer'] = ex.referer;
  if (ex.ua) headers['user-agent'] = ex.ua;
  const t0 = Date.now();
  try {
    const r = await fetchT(item.url, { headers: headers });
    const ms = Date.now() - t0;
    try { await r.body.cancel(); } catch (e) {}
    if (r.status >= 200 && r.status < 400) return { ok: true, ms: ms };
    return { ok: false, err: 'HTTP ' + r.status };
  } catch (e) {
    return { ok: false, err: e.name === 'AbortError' ? '超时' : String(e.message || e).slice(0, 30) };
  }
}

async function pool(items, worker, n) {
  n = n || CONCURRENCY;
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i).catch(() => {});
    }
  }));
}

/* ---------------- 主流程 ---------------- */

console.log('== IPTV 聚合开始 ==');
const t0 = Date.now();

// 1. 收集条目
const subs = (CFG.subscriptions || []).filter(s => s.enabled !== false && s.url);
const custom = (CFG.customChannels || []).filter(c => c.enabled !== false && c.url)
  .map(c => ({ name: c.name, attrs: { 'group-title': c.group || '自定义' }, opts: [], url: c.url }));
if (CFG.homeSource && CFG.homeSource.url) {
  subs.push({ name: CFG.homeSource.name || '家庭自托管', url: CFG.homeSource.url });
}
const sourceReport = [];

let all = [];
for (const sub of subs) {
  process.stdout.write('拉取 [' + sub.name + '] ' + sub.url + ' ... ');
  try {
    const text = await getText(sub.url);
    const items = /^#EXTM3U/m.test(text) ? parseM3U(text) : parseTXT(text);
    console.log(items.length + ' 条');
    sourceReport.push({ name: sub.name, ok: true, channels: items.length });
    all = all.concat(items.map(it => ({ ...it, src: sub.name })));
  } catch (e) {
    console.log('失败: ' + (e.message || e));
    sourceReport.push({ name: sub.name, ok: false, channels: 0 });
  }
}
all = all.concat(custom.map(c => ({ ...c, src: '自定义' })));
console.log('共解析 ' + all.length + ' 条原始记录');

// 2. 归一 + 去重聚合
const channels = new Map();
for (const it of all) {
  if (!it.name || !String(it.name).trim()) continue;
  const key = normalizeName(it.name);
  if (!key || key === '未知频道') continue;
  if (DROP_KW.some(kw => key.includes(kw))) continue;
  const group = normalizeGroup(it.attrs['group-title'] || it.groupHint, key);
  if (!channels.has(key)) channels.set(key, {
    display: key, group: group, logo: '', tvgId: '',
    urls: new Map(),
  });
  const ch = channels.get(key);
  if (!ch.logo && it.attrs['tvg-logo']) ch.logo = it.attrs['tvg-logo'];
  if (!ch.tvgId && it.attrs['tvg-id']) ch.tvgId = it.attrs['tvg-id'];
  if (!ch.urls.has(it.url)) ch.urls.set(it.url, { opts: it.opts || [] });
}

// 3. 测速
let urls = [];
for (const kv of channels) {
  for (const uv of kv[1].urls) urls.push({ key: kv[0], url: uv[0], meta: uv[1] });
}
const skippedProbe = Math.max(0, urls.length - MAX_PROBE);
urls = urls.slice(0, MAX_PROBE);
console.log('待测速 URL: ' + urls.length + (skippedProbe ? '（另有 ' + skippedProbe + ' 条超出 maxProbe 未测）' : ''));

let done = 0;
await pool(urls, async (u) => {
  const r = await probe(u);
  u.ok = r.ok; u.ms = r.ms; u.err = r.err;
  u.meta.ok = !!r.ok; u.meta.ms = r.ms;
  done++;
  if (done % 200 === 0) console.log('  测速进度 ' + done + '/' + urls.length);
});

// 4. 组装输出
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true });
const entries = [];
for (const kv of channels) {
  const ch = kv[1];
  const list = Array.from(ch.urls.entries())
    .map(pair => ({ url: pair[0], ms: pair[1].ms == null ? Infinity : pair[1].ms, ok: !!pair[1].ok, opts: pair[1].opts }))
    .sort((a, b) => ((b.ok ? 1 : 0) - (a.ok ? 1 : 0)) || (a.ms - b.ms))
    .slice(0, MAX_PER_CH);
  if (!list.some(x => x.ok)) continue; // 全部失效的频道丢弃
  entries.push({ key: kv[0], group: ch.group, logo: ch.logo, tvgId: ch.tvgId, urls: list });
}
entries.sort((a, b) =>
  (orderOf(a.group) - orderOf(b.group)) ||
  a.group.localeCompare(b.group, 'zh-Hans-CN') ||
  collator.compare(a.key, b.key));

const lines = ['#EXTM3U' + (CFG.epgUrl ? ' x-tvg-url="' + CFG.epgUrl + '"' : '')];
for (const e of entries) {
  const attrs = ' tvg-id="' + (e.tvgId || e.key.toLowerCase()) + '"' +
    (e.logo ? ' tvg-logo="' + e.logo + '"' : '') +
    ' group-title="' + e.group + '"';
  for (const u of e.urls) {
    lines.push('#EXTINF:-1' + attrs + ',' + e.key);
    const ex = extractOpts(u.opts);
    if (ex.referer) lines.push('#EXTVLCOPT:http-referrer=' + ex.referer);
    if (ex.ua) lines.push('#EXTVLCOPT:http-user-agent=' + ex.ua);
    lines.push(u.url);
  }
}
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(new URL('iptv.m3u', OUT_DIR), lines.join('\n') + '\n');

const aliveUrls = urls.filter(u => u.ok).length;
const report = {
  generatedAt: new Date().toISOString(),
  durationSec: Math.round((Date.now() - t0) / 1000),
  sources: sourceReport,
  totals: { rawRecords: all.length, uniqueChannels: channels.size, keptChannels: entries.length, probedUrls: urls.length, aliveUrls: aliveUrls },
  skippedProbe: skippedProbe,
};
writeFileSync(new URL('report.json', OUT_DIR), JSON.stringify(report, null, 2));

console.log('== 完成 ==');
console.log('有效频道 ' + entries.length + ' 个（唯一名 ' + channels.size + '），存活 URL ' + aliveUrls + '/' + urls.length + '，耗时 ' + report.durationSec + 's');
