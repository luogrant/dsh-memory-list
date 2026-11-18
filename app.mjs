// 记忆识海 · app.mjs —— 单文件服务：五轨记忆 / 记忆树 / 人设 / 星图
// 设计：全部数据落 data/识海.json 一份；代码全部在本文件；星图页在 pages/星轨.html。
// 参考：dsh-memory-tree（树/五轨格式）、dsh-agent-persona（人设 schema）。不依赖 DSH。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 会话日志根目录：DSH_HOME 指向装 DSH 数据的那层（默认 ~/.dsh）
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
// 数据根：默认落 $DSH_HOME/memory-list（本机用 junction 指到 E:/dsh-data/memory-list）；
// 也可以用 SHIRAM_HOME 直接指一个目录，或用 SHIRAM_DATA 单独指数据文件。
const 数据根 = process.env.SHIRAM_HOME || path.join(DSH_HOME, 'memory-list');
const DATA_FILE = process.env.SHIRAM_DATA || path.join(数据根, '识海.json');
const BACKUP_DIR = process.env.SHIRAM_BACKUP || path.join(数据根, 'backup');
// 首次运行时复制的空骨架（随包发布：data/识海.json）
const 骨架文件 = path.join(HERE, 'data', '识海.json');
const PAGES = path.join(HERE, 'pages');
const PORT = Number(process.env.SHIRAM_PORT || 8080);
const SESSIONS_ROOT = process.env.SHIRAM_SESSIONS || path.join(DSH_HOME, 'sessions');
// 模型配置：默认读同目录 llm.json，也可用 SHIRAM_LLM_CONFIG 指别处
const LLM_CONFIG = process.env.SHIRAM_LLM_CONFIG || path.join(HERE, 'llm.json');
const TRACKS = ['memory', 'user', 'project', 'key', 'daily'];
const TRACK_LABEL = { memory: '全局记忆', user: '用户档案', project: '项目记忆', key: '关键记忆', daily: '今日流水' };

// ---------------- 数据层 ----------------

let db = null;
let rev = '';

// 首次运行：数据文件不存在就从随包骨架复制一份 —— 插件模式下 import 不能因为缺文件就崩
function 确保数据文件() {
  fs.mkdirSync(数据根, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) return false;
  if (fs.existsSync(骨架文件)) fs.copyFileSync(骨架文件, DATA_FILE);
  else fs.writeFileSync(DATA_FILE, JSON.stringify({ built_at: new Date().toISOString(), tracks: {}, store: {}, state: {} }, null, 2), 'utf8');
  return true;
}

// 懒加载：插件模式下 import 不做任何磁盘 IO，第一个请求来了才读库
function 确保库() {
  if (db) return db;
  确保数据文件();
  return loadDb();
}

function loadDb() {
  const raw = fs.readFileSync(DATA_FILE, 'utf8').replace(/^\uFEFF/, '');
  db = JSON.parse(raw);
  db.tracks = db.tracks || {};
  db.store = db.store || {};
  db.state = db.state || {};
  db.auto = Object.assign({ intake: false, tidy: false, intakeEveryHours: 2, tidyEveryHours: 24, lastIntakeAt: 0, lastTidyAt: 0, doneSids: [] }, db.auto || {});
  rev = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10);
  return db;
}

function saveDb() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  // 每天一份基线备份：当天第一次写入时保存，之后同一天的写入不再重复备份（避免每写一条就多 1MB）
  const dayBackup = path.join(BACKUP_DIR, `识海-${dayOf()}.json`);
  if (fs.existsSync(DATA_FILE) && !fs.existsSync(dayBackup)) fs.copyFileSync(DATA_FILE, dayBackup);
  const keep = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort();
  for (const f of keep.slice(0, Math.max(0, keep.length - 30))) fs.unlinkSync(path.join(BACKUP_DIR, f));
  db.built_at = new Date().toISOString();
  const out = JSON.stringify(db, null, 2);
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, out, 'utf8');
  fs.renameSync(tmp, DATA_FILE);
  rev = crypto.createHash('sha1').update(out).digest('hex').slice(0, 10);
}

function pad(n) { return n < 10 ? '0' + n : String(n); }
function dayOf(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function hhmm(d = new Date()) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function nowStamp(d = new Date()) { return `${dayOf(d)} ${hhmm(d)}`; }
function shortId(text) { return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 8); }
function summarize(body, max = 100) {
  const one = String(body || '').replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : one.slice(0, max - 1) + '…';
}

// ---------------- 五轨（md 条目格式，兼容 § 分隔与 [summary:"…"]） ----------------

const SEP_RE = /^\s*§\s*$/;
const HEAD_RE = /^\[(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?|\d{2}:\d{2})\]\s*(.*)$/;

function parseEntries(text) {
  const blocks = [];
  let cur = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (SEP_RE.test(line)) {
      if (cur.join('').trim()) blocks.push(cur.join('\n'));
      cur = [];
    } else cur.push(line);
  }
  if (cur.join('').trim()) blocks.push(cur.join('\n'));

  const out = [];
  for (const raw0 of blocks) {
    const trimmed = raw0.trim();
    if (!trimmed) continue;
    const lines = trimmed.split('\n');
    const m = HEAD_RE.exec(lines[0]);
    let date = '';
    let rest = m ? [m[2], ...lines.slice(1)].join('\n') : trimmed;
    if (m) date = m[1];
    let summary = '';
    const sm = /^\[summary:"([\s\S]*?)"\]\s*/.exec(rest);
    if (sm) { summary = sm[1]; rest = rest.slice(sm[0].length); }
    out.push({ index: out.length, date, summary, body: rest.trim(), raw: trimmed, id: shortId(trimmed) });
  }
  return out;
}

function serializeEntries(entries) {
  if (!entries.length) return '';
  return entries.map(e => e.raw).join('\n§\n') + '\n§\n';
}

function trackText(track, opts = {}) {
  if (track === 'daily') {
    const day = opts.date || dayOf();
    return { text: db.tracks.daily?.[day] || '', key: day, slot: 'daily' };
  }
  return { text: db.tracks[track] || '', key: track, slot: track };
}

function setTrackText(track, text, opts = {}) {
  if (track === 'daily') {
    const day = opts.date || dayOf();
    db.tracks.daily = db.tracks.daily || {};
    db.tracks.daily[day] = text;
    return;
  }
  db.tracks[track] = text;
}

function readEntries(track, opts = {}) {
  const { text } = trackText(track, opts);
  return parseEntries(text);
}

function archivedText(track, opts = {}) {
  const key = track === 'daily' ? `daily:${opts.date || dayOf()}` : track;
  return db.archives?.[key] || '';
}

function readArchived(track, opts = {}) {
  return parseEntries(archivedText(track, opts));
}

function buildRaw(track, body, opts = {}) {
  const d = opts.now || new Date();
  const date = opts.date || (track === 'project' ? nowStamp(d) : track === 'daily' ? hhmm(d) : dayOf(d));
  const prefix = track === 'daily' ? `[${date}] [${opts.workspace || '默认'}] ` : `[${date}] `;
  const sm = track === 'key' && opts.summary ? `[summary:"${opts.summary}"] ` : '';
  return `${prefix}${sm}${String(body).trim()}`;
}

function matchOne(track, needle, opts = {}, allowMulti = false) {
  const q = String(needle || '').trim().replace(/^#+/, '');
  if (!q) return { error: '缺少定位片段' };
  const entries = readEntries(track, opts);
  const hits = entries.filter(e => e.id === q || e.id.startsWith(q) || e.raw.includes(q));
  if (!hits.length) return { error: '没找到匹配条目（用原文片段或 list 给的 #id）' };
  if (hits.length > 1 && !allowMulti) return { error: `匹配到 ${hits.length} 条，请给更长的唯一片段` };
  return { entries, target: hits[0], hits };
}

function addEntry(track, body, opts = {}) {
  const { text } = trackText(track, opts);
  const raw = buildRaw(track, body, opts);
  const head = text.trim() ? text.replace(/\s*$/, '') + '\n§\n' : '';
  setTrackText(track, head + raw + '\n§\n', opts);
  saveDb();
  return { raw, id: shortId(raw) };
}

function replaceEntry(track, needle, nextBody, opts = {}) {
  const r = matchOne(track, needle, opts);
  if (r.error) return { ok: false, error: r.error };
  const { entries, target } = r;
  const raw = buildRaw(track, nextBody, { ...opts, date: target.date || undefined });
  entries[target.index] = parseEntries(raw + '\n§\n')[0];
  setTrackText(track, serializeEntries(entries), opts);
  saveDb();
  return { ok: true, id: entries[target.index].id };
}

function removeEntry(track, needle, opts = {}) {
  const r = matchOne(track, needle, opts, opts.all === true);
  if (r.error) return { ok: false, error: r.error };
  if (opts.all === true) {
    const ids = new Set(r.hits.map(h => h.id));
    const keep = r.entries.filter(e => !ids.has(e.id));
    setTrackText(track, serializeEntries(keep), opts);
    saveDb();
    return { ok: true, removed: ids.size };
  }
  const { entries, target } = r;
  entries.splice(target.index, 1);
  setTrackText(track, serializeEntries(entries), opts);
  saveDb();
  return { ok: true };
}

function archiveEntry(track, needle, opts = {}) {
  if (!['memory', 'user', 'key'].includes(track)) return { ok: false, error: '只有 memory / user / key 三轨支持归档' };
  const r = matchOne(track, needle, opts);
  if (r.error) return { ok: false, error: r.error };
  const { entries, target } = r;
  db.archives = db.archives || {};
  const key = track;
  const atext = db.archives[key] || '';
  const head = atext.trim() ? atext.replace(/\s*$/, '') + '\n§\n' : '';
  db.archives[key] = head + target.raw + '\n§\n';
  entries.splice(target.index, 1);
  setTrackText(track, serializeEntries(entries), opts);
  saveDb();
  return { ok: true, archive: key };
}

// ---------------- 树 ----------------

function loadTree() { return db.tree; }
function kids(node) { return node?.children ?? node?.nodes ?? []; }
function nodeName(node) { return String(node?.name ?? node?.title ?? node?.id ?? ''); }

function walkTree(tree) {
  const out = [];
  const roots = Array.isArray(tree?.tree) ? tree.tree : Array.isArray(tree) ? tree : [];
  const visit = (node, parentKey, depth) => {
    const name = nodeName(node);
    if (!name) return;
    const key = parentKey ? `${parentKey}/${name}` : name;
    out.push({ key, name, depth, node, parentKey, limit: Number(node?.limit) || 0 });
    for (const k of kids(node)) visit(k, key, depth + 1);
  };
  for (const r of roots) visit(r, '', 0);
  return out;
}

function nodeMap(tree) {
  const map = new Map();
  for (const row of walkTree(tree)) map.set(row.key, row);
  return map;
}

function assertUniqueIds(tree) {
  const seen = new Map();
  const dup = [];
  const walk = (list) => {
    for (const n of list || []) {
      const id = n && n.id;
      if (id) {
        if (seen.has(id)) dup.push(`${id}（${seen.get(id)} 与 ${n.path}）`);
        else seen.set(id, n.path);
      }
      walk(kids(n));
    }
  };
  walk(tree?.tree ?? tree);
  if (dup.length) throw new Error(`节点 id 重复：${dup.join('、')}`);
}

function saveTree() {
  assertUniqueIds(db.tree);
  saveDb();
}

function attachMemories(tree, entries) {
  const map = nodeMap(tree);
  const buckets = new Map();
  const loose = [];
  for (const e of entries) {
    const p = String(e.path ?? '').trim().replace(/^\/+|\/+$/g, '');
    let key = null;
    if (map.has(p)) key = p;
    else {
      const parts = p.split('/').filter(Boolean);
      for (let i = parts.length - 1; i >= 1; i--) {
        const parent = parts.slice(0, i).join('/');
        if (map.has(parent)) { key = `${parent}/${parts[i]}`; break; }
      }
    }
    if (key) {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(e);
    } else loose.push(e);
  }
  return { buckets, loose };
}

const brief = m => ({ t: m.t, day: m.day, lv: m.lv, path: m.path, text: m.text, exp: m.exp ?? null });

function daysBetween(fromDay, toDay) {
  const a = Date.parse(`${fromDay}T00:00:00Z`);
  const b = Date.parse(`${toDay}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

function readPending() {
  const raw = db.suggestions || [];
  return raw.filter(o => !o.status || o.status === 'pending').map(o => {
    const stamp = String(o.createdAt ?? o.at ?? o.time ?? '');
    return {
      day: /^\d{4}-\d{2}-\d{2}/.test(stamp) ? stamp.slice(0, 10) : dayOf(),
      t: '--:--',
      lv: Number(o.lv ?? 2),
      path: String(o.path ?? o.target ?? '待确认'),
      text: String(o.content ?? o.text ?? o.summary ?? '').slice(0, 300),
      exp: null, tag: 'pending', why: '等待确认',
    };
  });
}

function allStoreEntries(filter = {}) {
  const out = [];
  for (const day of Object.keys(db.store).sort()) {
    if (filter.days && !filter.days.includes(day)) continue;
    for (const o of db.store[day] || []) {
      if (filter.lv && Number(o.lv) !== Number(filter.lv)) continue;
      const kw = filter.keyword ? String(filter.keyword).toLowerCase() : '';
      if (kw && !(String(o.text).toLowerCase().includes(kw) || String(o.path).toLowerCase().includes(kw))) continue;
      out.push({ ...o, day });
    }
  }
  return out;
}

function readSuggestions(entries) {
  const today = dayOf();
  const conf = db.suggestConfig || {};
  const warn = Number(conf.archiveWarnDays ?? 3);
  const lv3Days = Number(conf.promoteLv3Days ?? 7);
  const lv2Days = Number(conf.promoteLv2Days ?? 25);
  const archive = [];
  const promote = [];
  for (const m of entries || []) {
    const e = brief(m);
    if (e.exp && /^\d{4}-\d{2}-\d{2}$/.test(String(e.exp))) {
      const left = daysBetween(today, e.exp);
      if (left <= warn) {
        archive.push({ ...e, tag: 'archive', why: left < 0 ? `已过期 ${-left} 天` : left === 0 ? '今天到期' : `剩 ${left} 天到期` });
      }
    }
    if (!e.day) continue;
    const age = daysBetween(e.day, today);
    if (e.lv === 3 && age >= lv3Days) promote.push({ ...e, tag: 'promote', why: `短期记忆已放 ${age} 天，考虑升为长期` });
    else if (e.lv === 2 && age >= lv2Days) promote.push({ ...e, tag: 'promote', why: `长期记忆已放 ${age} 天，考虑归档或续期` });
  }
  const byTime = (a, b) => (b.day + b.t).localeCompare(a.day + a.t);
  return { pending: readPending(), archive: archive.sort(byTime), promote: promote.sort(byTime) };
}

function buildView(opts = {}) {
  const tree = loadTree();
  const allEntries = allStoreEntries({ keyword: opts.keyword ?? '' });
  const mEntries = allEntries.filter(e => Number(e.lv) === 4);
  const entries = allEntries.filter(e => Number(e.lv) !== 4);
  const { buckets, loose } = attachMemories(tree, entries);

  const rows = new Map();
  for (const r of walkTree(tree)) {
    rows.set(r.key, { key: r.key, name: r.name, dsc: r.node?.dsc ?? '', level: Number.isFinite(Number(r.node?.level)) ? Number(r.node.level) : r.depth, depth: r.depth, parentKey: r.parentKey, limit: r.limit, note: r.node?.note ?? '', noChain: !!r.node?.noChain, life: r.node?.life ?? (r.depth >= 3 ? '10 天' : r.depth === 2 ? '30 天' : '永久'), synthetic: false, memories: [] });
  }
  for (const key of buckets.keys()) {
    if (rows.has(key)) continue;
    const parts = key.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const k = parts.slice(0, i).join('/');
      if (rows.has(k)) continue;
      rows.set(k, { key: k, name: parts[i - 1], dsc: '', level: i - 1, depth: i - 1, parentKey: parts.slice(0, i - 1).join('/'), limit: 0, note: '', life: (i - 1) >= 3 ? '10 天' : (i - 1) === 2 ? '30 天' : '永久', synthetic: true, memories: [] });
    }
  }
  for (const [key, list] of buckets) {
    const row = rows.get(key);
    if (row) row.memories = list.map(brief);
  }

  // 「等待处理」「自主意识」两个虚拟分支：已移除，不再渲染
  const all = [...rows.values()];
  let ordered = all;

  const realRows = ordered.filter(r => !r.special && !String(r.key).startsWith('__'));
  const hasKids = key => realRows.some(r => String(r.parentKey) === key);
  const nameIsContent = n => {
    const s = String(n ?? '').trim();
    return s.length >= 16 || /[。；：！？]/.test(s);
  };
  const stats = {
    nodes: realRows.length,
    filled: realRows.filter(r => (r.memories || []).length > 0).length,
    category: realRows.filter(r => hasKids(r.key)).length,
    empty: realRows.filter(r => r.depth >= 2 && (r.memories || []).length === 0 && !hasKids(r.key) && !nameIsContent(r.name)).length,
  };

  const kw = String(opts.keyword ?? '').trim();
  if (kw) {
    const byKey = new Map(ordered.map(r => [r.key, r]));
    const keep = new Set();
    const mark = key => {
      for (let k = key; k; k = byKey.get(k)?.parentKey) {
        if (keep.has(k)) break;
        keep.add(k);
      }
    };
    for (const r of ordered) if ((r.memories || []).length) mark(r.key);
    ordered = ordered.filter(r => keep.has(r.key));
  }

  return { rules: tree.rules ?? null, rows: ordered, loose: loose.map(brief), total: entries.length, stats };
}

function levelMeta(t, depth) {
  const lv = t?.rules?.levels?.[String(depth)] ?? {};
  return {
    level: depth,
    level_label: lv.label ?? `T${depth}`,
    perm: lv.perm ?? '读写',
    limit: Number(lv.limit) || (depth >= 3 ? 60 : depth === 2 ? 30 : 10),
    life: lv.life ?? (depth >= 3 ? '10 天' : depth === 2 ? '30 天' : '永久'),
  };
}

function nextId(t, depth) {
  let max = 0;
  for (const row of walkTree(t)) {
    if (row.depth !== depth) continue;
    const m = /^L\d+-(\d+)$/.exec(String(row.node?.id ?? ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `L${depth}-${String(max + 1).padStart(3, '0')}`;
}

function makeNode(t, depth, name, key) {
  return { id: nextId(t, depth), name, path: key ?? name, ...levelMeta(t, depth), children: [] };
}

function ensureNode(t, key) {
  const parts = String(key).split('/').filter(Boolean);
  if (!Array.isArray(t?.tree)) t.tree = [];
  let list = t.tree;
  let node = null;
  for (let i = 0; i < parts.length; i++) {
    let found = list.find(n => nodeName(n) === parts[i]);
    if (!found) {
      found = makeNode(t, i, parts[i], parts.slice(0, i + 1).join('/'));
      list.push(found);
    }
    node = found;
    if (!Array.isArray(node.children) && !Array.isArray(node.nodes)) node.children = [];
    list = kids(node);
  }
  return node;
}

function refixPaths(t) {
  const visit = (node, parentKey, depth) => {
    if (!node || typeof node !== 'object') return;
    const name = nodeName(node);
    const key = parentKey ? `${parentKey}/${name}` : name;
    if (depth > 0 || 'path' in node) node.path = key;
    for (const k of kids(node)) visit(k, key, depth + 1);
  };
  for (const r of (Array.isArray(t?.tree) ? t.tree : [])) visit(r, '', 0);
}

function ensurePath(key) {
  const parts = String(key ?? '').split('/').map(s => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('记忆路径为空');
  if (parts.length > 4) throw new Error(`记忆路径超过四层（T0..T3）：${parts.join('/')}`);
  const full = parts.join('/');
  const tree = loadTree();
  const before = new Set(nodeMap(tree).keys());
  ensureNode(tree, full);
  const created = [...nodeMap(tree).keys()].filter(k => !before.has(k));
  if (!created.length) return { key: full, created: [] };
  refixPaths(tree);
  saveTree();
  return { key: full, created };
}

function addMemory(input) {
  const row = { lv: Number(input.lv ?? 3), path: input.path, text: input.text, ws: input.ws ?? '*', src: input.src || 'panel' };
  const node = ensurePath(row.path);
  const day = dayOf();
  const entry = {
    t: hhmm(), lv: row.lv, path: String(row.path).trim(),
    text: String(row.text ?? '').trim().slice(0, 400), exp: input.exp ?? null, hit: 0, ws: row.ws, src: row.src,
  };
  if (!entry.text) throw new Error('记忆内容为空');
  db.store[day] = db.store[day] || [];
  db.store[day].push(entry);
  saveDb();
  return { written: 1, day, createdNodes: node.created, entry: { ...entry, day } };
}

function sameMemory(o, { t, text, path: p }) {
  if (String(o?.t ?? '') !== String(t ?? '')) return false;
  if (String(o?.text ?? '') !== String(text ?? '')) return false;
  if (p !== undefined && p !== null && String(o?.path ?? '') !== String(p)) return false;
  return true;
}

function updateMemory(input) {
  const { day, t, text, path: memPath, newText } = input;
  const next = String(newText ?? '').trim();
  if (!next) throw new Error('新内容为空');
  if (!db.store[day]) throw new Error(`没有这一天的记忆：${day}`);
  let hit = 0;
  for (const o of db.store[day]) {
    if (!sameMemory(o, { t, text, path: memPath })) continue;
    hit++;
    o.text = next;
    if (!String(o.src ?? '').startsWith('edit:')) o.src = `edit:${o.src ?? 'panel'}`;
  }
  if (!hit) throw new Error('没找到这条记忆（日期/时间/内容对不上）');
  saveDb();
  return { day, matched: hit };
}

function deleteMemory(input) {
  const { day, t, text, path: memPath } = input;
  if (!db.store[day]) throw new Error(`没有这一天的记忆：${day}`);
  const before = db.store[day].length;
  db.store[day] = db.store[day].filter(o => !sameMemory(o, { t, text, path: memPath }));
  const hit = before - db.store[day].length;
  if (!hit) throw new Error('没找到这条记忆（日期/时间/内容对不上）');
  saveDb();
  return { day, matched: hit };
}

function renameNode(oldKey, newName) {
  const name = String(newName ?? '').trim();
  if (!name) throw new Error('新名称为空');
  if (name.includes('/')) throw new Error('名称不能含 /');
  const tree = loadTree();
  const map = nodeMap(tree);
  const hit = map.get(oldKey);
  const parts = oldKey.split('/');
  const parentKey = parts.slice(0, -1).join('/');
  const newKey = [...parts.slice(0, -1), name].join('/');
  if (map.has(newKey)) throw new Error(`同级已有同名节点：${newKey}`);
  let touched = 0;
  for (const day of Object.keys(db.store)) {
    for (const o of db.store[day]) {
      const p = String(o.path ?? '');
      if (p !== oldKey && !p.startsWith(oldKey + '/')) continue;
      o.path = newKey + p.slice(oldKey.length);
      touched++;
    }
  }
  if (hit) hit.node.name = name;
  else if (touched > 0) {
    const parent = ensureNode(tree, parentKey);
    const depth = parentKey ? parentKey.split('/').length : 0;
    kids(parent).push(makeNode(tree, depth, name, newKey));
  } else throw new Error(`节点不存在：${oldKey}`);
  refixPaths(tree);
  saveTree();
  return { oldKey, newKey, memories: touched };
}

function addChildNode(input) {
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('节点名为空');
  if (name.includes('/')) throw new Error('节点名不能含 /');
  const parentKey = String(input.parentKey ?? input.parent ?? '').trim().replace(/^\/+|\/+$/g, '');
  const tree = loadTree();
  const key = parentKey ? `${parentKey}/${name}` : name;
  if (nodeMap(tree).has(key)) throw new Error(`同级已有同名节点：${key}`);
  if (!parentKey && !Array.isArray(tree.tree)) tree.tree = [];
  const depth = parentKey ? parentKey.split('/').filter(Boolean).length : 0;
  if (depth > 8) throw new Error('这层已经够深了，再往下就该拆成新的 T0 分支。');
  let list;
  let parentNode = null;
  if (parentKey) {
    const parent = ensureNode(tree, parentKey);
    parentNode = parent;
    if (!Array.isArray(parent.children) && !Array.isArray(parent.nodes)) parent.children = [];
    list = kids(parent);
  } else list = tree.tree;
  // 层级必须一级一级长：T0 才能生 T1，T1 才能生 T2/T3，T2/T3 才能生 T4
  if (input.level != null && input.level !== '') {
    const lv = Number(input.level);
    const pLv = parentNode ? Number(parentNode.level ?? 0) : -1;
    const ok = lv === 0 ? !parentKey
      : lv === 1 ? pLv === 0
      : (lv === 2 || lv === 3) ? pLv === 1
      : lv === 4 ? (pLv === 2 || pLv === 3)
      : false;
    if (!ok) {
      const need = lv === 1 ? 'T0' : (lv === 2 || lv === 3) ? 'T1' : lv === 4 ? 'T2 或 T3' : '不认识的层级';
      throw new Error(`层级不对：T${lv} 必须挂在 ${need} 下面（父节点现在是 T${pLv < 0 ? '无' : pLv}）`);
    }
  }
  const node = makeNode(tree, depth, name, key);
  if (input.level != null && input.level !== '') {
    node.level = Number(input.level);
    node.level_label = String(input.levelLabel || `T${input.level}`);
  }
  if (input.life) node.life = String(input.life);
  list.push(node);
  refixPaths(tree);
  saveTree();
  return { key };
}

function deleteNode(input) {
  const key = String(input.key ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!key) throw new Error('节点路径为空');
  const tree = loadTree();
  const map = nodeMap(tree);
  const hit = map.get(key);
  if (!hit) throw new Error(`树里没有这个节点：${key}`);
  if (kids(hit.node).length) throw new Error('这个节点下还有子节点，先删子节点。');
  let attached = 0;
  for (const day of Object.keys(db.store)) {
    for (const o of db.store[day]) {
      const p = String(o.path ?? '');
      if (p === key || p.startsWith(key + '/')) attached++;
    }
  }
  if (attached) throw new Error(`这个节点下还挂着 ${attached} 条记忆，先删掉或迁走再删节点。`);
  const parent = hit.parentKey ? map.get(hit.parentKey) : null;
  const list = parent ? kids(parent.node) : tree.tree;
  const idx = list.findIndex(n => nodeName(n) === hit.name);
  if (idx < 0) throw new Error('节点在父级里找不到，未改动。');
  list.splice(idx, 1);
  refixPaths(tree);
  saveTree();
  return { key };
}

// ---------------- M 层（瞬间记忆）/ 整合 / 体检 ----------------
// 口径沿用 记忆系统 2026-11-08：M 不进树不进列表，只挂「自主意识」；hit>=3 升 T3(10 天)；
// idleDays 内没被提起 → 转入「整合记忆」(5 天)；整合期 5 天未处理 → 删除。
const M_LV = 4;

function mCfg() {
  return Object.assign({
    ttlDays: 5, promoteHits: 3, promoteToLv: 3, promoteToDays: 10,
    idleDays: 3, archiveNode: '整合记忆', archiveDays: 5,
    hitSimilarity: 0.42, hitOverlap: 0.45, hitMinBigrams: 4,
  }, db.mConfig || {});
}

function addDays(day, n) {
  const d = new Date(day + 'T00:00:00');
  d.setDate(d.getDate() + (Number(n) || 0));
  return dayOf(d);
}

// 节点 life（'永久' / '45 天'）→ 到期日；永久返回 null
function expByLife(life) {
  const s = String(life || '').trim();
  if (!s || s.includes('永久')) return null;
  const m = /(\d+)\s*天/.exec(s);
  return m ? addDays(dayOf(), Number(m[1])) : null;
}

function bigrams(s) {
  const t = String(s || '').replace(/[\s\p{P}]/gu, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function simScore(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return { ok: false, score: 0, overlap: 0, inter: 0 };
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const overlap = inter / Math.min(A.size, B.size);
  const sim = (2 * inter) / (A.size + B.size);
  const m = mCfg();
  return { ok: inter >= m.hitMinBigrams && (sim >= m.hitSimilarity || overlap >= m.hitOverlap), score: sim, overlap, inter };
}

// 提一条新事：与现有 M 比相似度，命中就 hit+1，不命中新建
function intakeM(text, opts = {}) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, message: '内容为空' };
  const today = dayOf();
  const m = mCfg();
  const list = allStoreEntries({ lv: M_LV }).filter(e => e.mState !== 'archive');
  let best = null;
  for (const e of list) {
    const s = simScore(body, e.text);
    if (s.ok && (!best || s.score > best.score)) best = { e, score: s.score };
  }
  if (best) {
    const rows = db.store[best.e.day] || [];
    const target = rows.find(o => o.t === best.e.t && o.path === best.e.path && o.text === best.e.text);
    if (target) {
      target.hit = (Number(target.hit) || 0) + 1;
      target.lastHit = today;
      saveDb();
      return { ok: true, action: 'hit', hit: target.hit, id: shortId(target.text), text: summarize(target.text, 60) };
    }
  }
  const entry = { t: hhmm(), lv: M_LV, path: '自主意识', text: body, exp: addDays(today, m.ttlDays), hit: 1, ws: opts.ws || 'local', src: 'm', lastHit: today };
  (db.store[today] = db.store[today] || []).push(entry);
  saveDb();
  return { ok: true, action: 'new', id: shortId(body), exp: entry.exp, text: summarize(body, 60) };
}

// 判定单条 M
function decideM(e, today) {
  const m = mCfg();
  if (e.mState === 'archive') {
    const waited = daysBetween(e.archivedAt || e.lastHit || e.day, today);
    if (waited >= m.archiveDays) return { action: 'drop', reason: `整合记忆 ${waited} 天未处理` };
    return { action: 'keep', reason: `整合记忆第 ${waited}/${m.archiveDays} 天` };
  }
  const hit = Number(e.hit) || 0;
  if (hit >= m.promoteHits) return { action: 'promote', lv: m.promoteToLv, days: m.promoteToDays, reason: `被提起 ${hit} 次` };
  const idle = daysBetween(e.lastHit || e.day, today);
  if (idle >= m.idleDays) return { action: 'archive', node: m.archiveNode, days: m.archiveDays, reason: `${idle} 天没被提起` };
  return { action: 'keep', reason: `M 期中（hit=${hit}, idle=${idle}）` };
}

// 跑 M 状态机；apply=false 只出计划
function runM(opts = {}) {
  const today = opts.today || dayOf();
  const m = mCfg();
  const all = allStoreEntries({ lv: M_LV });
  const plan = all.map(e => ({ entry: e, ...decideM(e, today) }));
  const summary = { keep: 0, promote: 0, archive: 0, drop: 0 };
  for (const p of plan) summary[p.action]++;
  const changes = plan.filter(p => p.action !== 'keep').map(p => ({
    action: p.action, reason: p.reason, day: p.entry.day,
    lv: p.action === 'promote' ? p.lv : M_LV,
    path: p.action === 'archive' ? p.node : p.entry.path,
    text: summarize(p.entry.text, 60),
  }));
  const report = { today, total: all.length, summary, changes, dryRun: !opts.apply };
  if (!opts.apply) return report;

  const byDay = new Map();
  for (const p of plan) {
    if (p.action === 'keep') continue;
    if (!byDay.has(p.entry.day)) byDay.set(p.entry.day, new Map());
    byDay.get(p.entry.day).set(`${p.entry.t}|${p.entry.path}|${p.entry.text}`, p);
  }
  for (const [day, map] of byDay) {
    const rows = db.store[day] || [];
    const next = [];
    for (const o of rows) {
      const p = map.get(`${o.t}|${o.path}|${o.text}`);
      if (!p) { next.push(o); continue; }
      if (p.action === 'drop') continue;
      const e = { ...o };
      if (p.action === 'promote') {
        e.lv = p.lv; e.exp = addDays(today, p.days); e.lastHit = today; e.promotedAt = today;
        delete e.mState;
      } else if (p.action === 'archive') {
        e.path = p.node; e.exp = addDays(today, p.days); e.mState = 'archive'; e.archivedAt = today;
      }
      next.push(e);
    }
    db.store[day] = next;
  }
  db.state.mLastRun = new Date().toISOString();
  saveDb();
  return report;
}

// 规则记忆整合：到期判断（60 小时）+ 相似候选分组，只出候选不改 store
// ---------------- 会话汲取（S 记忆汲取） ----------------
// 流程：选会话 → 解压会话日志 → 取已结束的 turn → 交模型按「树上已有节点」提炼 → 写库
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const S_NOISE = ['Current runtime context.', '以下是记忆宫殿中检索到的相关事实资料', '## 长期记忆（所有项目、会话都必须遵循）'];
let sCache = { at: 0, data: [] };

function sFrameStarts(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const p = buf.indexOf(ZSTD_MAGIC, i);
    if (p < 0) break;
    out.push(p);
    i = p + 4;
  }
  return out;
}

function sDecompress(buf, starts) {
  let text = '';
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { text += zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'); } catch { /* 半截帧跳过 */ }
  }
  return text;
}

function sTextOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c && c.type === 'text').map(c => c.text || '').join('\n').trim();
}

function sIsNoise(t) { return S_NOISE.some(n => t.includes(n)); }

function sExtractTurns(events, maxChars) {
  const turns = [];
  let cur = null;
  for (const ev of events) {
    if (ev.type === 'turn/start') { cur = { turn: ev.data?.turn ?? null, user: [], assistant: [] }; turns.push(cur); continue; }
    if (ev.type === 'turn/end') { cur = null; continue; }
    if (!cur) continue;
    if (ev.type === 'user/message') {
      if (ev.data?.source?.kind !== 'user') continue;
      const t = sTextOf(ev.data?.content);
      if (t && !sIsNoise(t)) cur.user.push(t.slice(0, maxChars));
    } else if (ev.type === 'assistant/message') {
      const t = sTextOf(ev.data?.message?.content);
      if (t) cur.assistant.push(t.slice(0, maxChars));
    }
  }
  return turns.filter(t => t.user.length || t.assistant.length);
}

function sReadEvents(file) {
  const buf = fs.readFileSync(file);
  return sDecompress(buf, sFrameStarts(buf)).split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function sListSessions() {
  if (sCache.data.length && Date.now() - sCache.at < 30000) return sCache.data;
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  const out = [];
  for (const bucket of fs.readdirSync(SESSIONS_ROOT)) {
    const bdir = path.join(SESSIONS_ROOT, bucket);
    let st;
    try { st = fs.statSync(bdir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const sid of fs.readdirSync(bdir)) {
      const file = path.join(bdir, sid, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      const fst = fs.statSync(file);
      let title = '';
      let cwd = '';
      try {
        const events = sReadEvents(file);
        const firstUser = events.find(e => e.type === 'user/message' && e.data?.source?.kind === 'user');
        title = (sTextOf(firstUser?.data?.content) || '').replace(/\s+/g, ' ').slice(0, 28);
        cwd = String(events[0]?.data?.cwd ?? events.find(e => e.data?.cwd)?.data?.cwd ?? '');
      } catch { /* 读不动就给空标题 */ }
      out.push({
        sid: sid.replace(/^session-/, ''), bucket, file, size: fst.size, mtime: fst.mtimeMs,
        title: title || ('会话 ' + sid.slice(0, 8)), cwd,
      });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  sCache = { at: Date.now(), data: out };
  return out;
}

function sApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  const f = path.join(DSH_HOME, '.credentials.yaml');
  if (!fs.existsSync(f)) return '';
  const m = fs.readFileSync(f, 'utf8').match(/DEEPSEEK_API_KEY\s*:\s*"?([^"\s]+)"?/);
  return m ? m[1] : '';
}

function sLlmCfg() {
  const f = LLM_CONFIG;
  try {
    const c = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    return c.llm || {};
  } catch { return {}; }
}

async function sChat(system, user, maxTokens = 0) {
  const cfg = sLlmCfg();
  const key = sApiKey();
  if (!key) throw new Error('没有找到 DEEPSEEK_API_KEY（env 或 ~/.dsh/.credentials.yaml）');
  const baseUrl = String(cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = cfg.model || 'deepseek-chat';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(cfg.timeoutMs || 60000));
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: Number(cfg.temperature ?? 0.2),
        max_tokens: Math.max(3000, Number(maxTokens || cfg.maxTokens || 0)),
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    const msg = j.choices?.[0]?.message || {};
    let txt = String(msg.content || '');
    if (!txt.trim()) {
      // reasoning 模型偶尔把答案全留在 reasoning_content 里、content 为空
      const rc = String(msg.reasoning_content || '');
      const m = rc.match(/[\[{][\s\S]*[\]}]\s*$/);
      txt = m ? m[0] : '';
    }
    if (!txt.trim()) throw new Error('模型返回空内容（finish=' + (j.choices?.[0]?.finish_reason || '?') + '）');
    return txt;
  } finally {
    clearTimeout(timer);
  }
}

function sParseJson(txt) {
  try {
    return JSON.parse(String(txt).replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim());
  } catch {
    throw new Error('模型返回不是 JSON：' + String(txt).slice(0, 200));
  }
}

async function sRefine(turns, nodePaths) {
  const system = `你是记忆整理器。从一段 user/assistant 对话里抽取值得长期记住的内容：明确说出的结论、决定、规则、偏好、踩坑与修法、被证伪的判断。
硬要求：
1. 只写对话里有直接依据的内容，不推断心理、不发散。
2. 不写过程、待办、寒暄、复述、工具执行状态。
3. 一条只讲一件事，陈述句，不超过 60 字。
4. path 必须从下面这份「树上已有的节点路径」里原样选一个，不许自造：
${nodePaths.join('\n')}
输出严格 JSON 数组，不要代码块、不要解释。每项：{"path":"节点路径","text":"一句话"}
没有值得记的就输出 []。`;
  const body = turns.map(t => `【第${t.turn}轮】\n用户: ${t.user.join('\n') || '(无)'}\n助手: ${t.assistant.join('\n') || '(无)'}`).join('\n\n');
  const arr = sParseJson(await sChat(system, body.slice(0, 12000)));
  return Array.isArray(arr) ? arr.filter(o => o && o.text && o.path) : [];
}

async function sScan(input = {}) {
  const ids = Array.isArray(input.ids) ? input.ids.map(String) : [];
  const totalCap = Math.max(1, Math.min(24, Number(input.maxTurns || 6)));
  const apply = input.apply !== false;
  const all = sListSessions();
  const picked = ids.length ? all.filter(s => ids.includes(s.sid)) : all;
  const nodePaths = walkTree(loadTree()).filter(r => r.depth > 0).map(r => r.key);
  const per = Math.max(1, Math.floor(totalCap / Math.max(1, picked.length)));
  const report = { sessions: [], written: 0, scannedTurns: 0, perSessionTurns: per, error: '' };
  for (const s of picked) {
    let items = [];
    let used = 0;
    try {
      const events = sReadEvents(s.file);
      const turns = sExtractTurns(events, Number(sLlmCfg().maxCharsPerTurn || 4000));
      if (!turns.length) { report.sessions.push({ sid: s.sid, title: s.title, turns: 0, items: [], written: 0 }); continue; }
      const use = turns.slice(-Math.min(turns.length, per));
      used = use.length;
      report.scannedTurns += used;
      items = await sRefine(use, nodePaths);
    } catch (e) {
      report.error = String(e?.message || e);
      report.sessions.push({ sid: s.sid, title: s.title, turns: 0, items: [], written: 0, error: report.error });
      continue;
    }
    let wrote = 0;
    for (const it of items) {
      const p = String(it.path || '').trim();
      const res = ensurePath(p);
      const lv = Number((nodeMap(loadTree()).get(res.key) || {}).level ?? 3);
      const exp = lv >= 3 ? addDays(dayOf(), ({ 3: 60, 4: 45, 5: 30 })[lv] || 30) : null;
      if (apply) { addMemory({ lv, path: res.key, text: it.text, ws: '*', src: 'intake', exp }); wrote++; }
    }
    report.written += wrote;
    report.sessions.push({ sid: s.sid, title: s.title, turns: used, items, written: wrote });
  }
  return report;
}

// ---------------- 记忆整理（Filter：S 汲取 → M 瞬时 / W 垃圾） ----------------
const S_NODE = 'S 记忆汲取';
const M_NODE = 'M 瞬时记忆';
const W_NODE = 'W 垃圾记忆';
const Q5_NODE = '主体 - 意识本体/碎片';

async function sTidy(input = {}) {
  const apply = input.apply !== false;
  const src = allStoreEntries({}).filter(e => String(e.path) === S_NODE);
  if (!src.length) return { ok: true, total: 0, keep: [], trash: [], merged: [], moved: 0, applied: apply, message: `「${S_NODE}」里没有待整理的条目` };
  const lines = src.map((e, i) => `${i + 1}. ${String(e.text).slice(0, 200)}`).join('\n');
  const system = `你在做记忆整理（海马体）。下面是从「${S_NODE}」取出的原始记忆，逐条编号。
要求：
1. 每条判一个去处：keep＝值得留下的有效记忆（结论、规则、偏好、踩坑与修法）；trash＝寒暄、复述、过程、工具状态、没有信息量的。
2. 同一个重点词或提示词在原文里出现超过三次（跨条目也算），把这几次合并成一条 merged，写清那个词和结论，不超过 60 字。
3. 不要把垃圾合并进有效记忆。
输出严格 JSON：{"keep":[序号],"trash":[序号],"merged":[{"text":"合并后的一句话","from":[序号]}]}
没有可合并的给空数组。只输出 JSON，不要解释、不要代码块。`;
  const obj = sParseJson(await sChat(system, lines, 2000));
  const idxOf = arr => (Array.isArray(arr) ? arr : []).map(n => Number(n) - 1).filter(i => i >= 0 && i < src.length);
  const keepIdx = idxOf(obj.keep);
  const trashIdx = idxOf(obj.trash);
  const merged = (Array.isArray(obj.merged) ? obj.merged : []).filter(m => m && String(m.text || '').trim());
  const mergedFrom = [];
  for (const m of merged) for (const i of idxOf(m.from)) mergedFrom.push(i);
  const out = {
    ok: true, total: src.length,
    keep: keepIdx.map(i => src[i].text), trash: trashIdx.map(i => src[i].text),
    merged: merged.map(m => m.text), moved: 0, applied: apply,
  };
  if (!apply) return out;
  let moved = 0;
  for (const i of keepIdx) {
    const e = src[i];
    addMemory({ lv: 2, path: M_NODE, text: e.text, ws: e.ws || '*', src: 'tidy', exp: addDays(dayOf(), 10) });
    moved++;
  }
  for (const i of trashIdx) {
    const e = src[i];
    addMemory({ lv: 2, path: W_NODE, text: e.text, ws: e.ws || '*', src: 'tidy', exp: addDays(dayOf(), 30) });
    moved++;
  }
  for (const m of merged) {
    addMemory({ lv: 2, path: M_NODE, text: m.text, ws: '*', src: 'tidy', exp: addDays(dayOf(), 10) });
    moved++;
  }
  for (const i of [...new Set([...keepIdx, ...trashIdx, ...mergedFrom])]) {
    const e = src[i];
    try { deleteMemory({ day: e.day, t: e.t, text: e.text, path: e.path }); } catch { /* 已被删就不管 */ }
  }
  out.moved = moved;
  if (apply) {
    try { out.promote = await sPromote({ apply: true }); } catch (e) { out.promote = { ok: false, error: String(e.message || e) }; }
  }
  return out;
}

// M → Q5 晋升：重点词/提示词累计出现超过门槛，才晋升；这是五轨唯一的自动写入触发点
async function sPromote(input = {}) {
  const apply = input.apply !== false;
  const minHits = Number(input.minHits || 3);
  const src = allStoreEntries({}).filter(e => String(e.path) === M_NODE);
  const out = { ok: true, total: src.length, minHits, promoted: [], applied: apply };
  if (src.length < minHits) {
    out.message = `M 里只有 ${src.length} 条，不到 ${minHits} 次的门槛`;
    return out;
  }
  const lines = src.map((e, i) => `${i + 1}. ${String(e.text).slice(0, 200)}`).join('\n');
  const system = `你在做记忆晋升（M 瞬时记忆 → Q5 主体短期记忆）。
下面是从「M 瞬时记忆」取出的条目，逐条编号。
判断标准：某个重点词或提示词（人、事、规则、偏好、反复出现的问题）在这些条目里累计出现 ${minHits} 次及以上（同一条里出现多次也算），才算稳定下来，可以合并成一条晋升；不到 ${minHits} 次的不晋升。
输出严格 JSON：{"promote":[{"word":"那个重点词","hit":出现次数,"from":[序号],"text":"合并后的一句话，不超过 60 字"}],"stay":[序号]}
没有可晋升的给空数组。只输出 JSON，不要解释、不要代码块。`;
  const obj = sParseJson(await sChat(system, lines, 2000));
  const idxOf = arr => (Array.isArray(arr) ? arr : []).map(n => Number(n) - 1).filter(i => i >= 0 && i < src.length);
  const list = (Array.isArray(obj.promote) ? obj.promote : []).filter(p => p && String(p.text || '').trim() && Number(p.hit) >= minHits);
  out.promoted = list.map(p => ({ word: String(p.word || ''), hit: Number(p.hit) || 0, text: String(p.text) }));
  if (!apply || !list.length) return out;
  const used = [];
  for (const p of list) {
    addMemory({ lv: 1, path: Q5_NODE, text: p.text, ws: '*', src: 'promote', exp: addDays(dayOf(), 30) });
    addEntry('key', `M 晋升：${p.word}（${p.hit} 次）—— ${p.text}`, { summary: `M晋升·${p.word}` });
    for (const i of idxOf(p.from)) used.push(i);
  }
  for (const i of [...new Set(used)]) {
    const e = src[i];
    try { deleteMemory({ day: e.day, t: e.t, text: e.text, path: e.path }); } catch { /* 已删就不管 */ }
  }
  try { out.q5 = await sPromoteQ5({ apply: true }); } catch (e) { out.q5 = { ok: false, error: String(e.message || e) }; }
  return out;
}

// Q5 → T2/T3/T4 晋升：按语义把 Q5 里稳定下来的记忆搬进 T1 下面的分层节点
async function sPromoteQ5(input = {}) {
  const apply = input.apply !== false;
  const src = allStoreEntries({}).filter(e => String(e.path) === Q5_NODE);
  const out = { ok: true, total: src.length, remember: [], forget: [], applied: apply };
  if (!src.length) { out.message = '「Q5 短期记忆」里没有条目'; return out; }
  const rows = walkTree(loadTree()).filter(r => { const lv = Number(r.node?.level ?? r.depth); return lv >= 2 && lv <= 4 && !r.synthetic && r.key !== Q5_NODE; });
  if (!rows.length) { out.message = '树里没有 T2/T3/T4 层节点，先建'; return out; }
  const targets = rows.map(r => `- ${r.key}`).join('\n');
  const lines = src.map((e, i) => `${i + 1}. ${String(e.text).slice(0, 200)}`).join('\n');
  const system = `你就是这条鱼本人，现在在做「自主意识」这一步：Q5 短期记忆里的东西，由你自己决定哪些该记住、哪些不该记住。
下面是从「Q5 短期记忆」取出的条目：
${lines}

可选的目标节点（必须原样使用其中一条）：
${targets}

判断标准（你自己拿主意，不是数次数）：
- 该记住：以后干活用得上、是你的规则/偏好/经历/能力/关系、或者反复撞到的东西。把它合并成一句话，挑最贴切的目标节点放进去。
- 不该记住：一次性的过程、废话、已经过时的状态、跟你无关的闲聊。列进 forget，等着被自然忘掉。
- 同一个主题的多条可以合并成一条再记。
输出严格 JSON：{"remember":[{"from":[序号],"to":"目标节点 key","text":"记成一句话，不超过 60 字","why":"一句话理由"}],"forget":[{"from":[序号],"why":"一句话理由"}]}
没有可记的给空数数组。只输出 JSON。`;
  const obj = sParseJson(await sChat(system, lines, 2000));
  const idxOf = arr => (Array.isArray(arr) ? arr : []).map(n => Number(n) - 1).filter(i => i >= 0 && i < src.length);
  const valid = new Set(rows.map(r => r.key));
  const remember = (Array.isArray(obj.remember) ? obj.remember : []).filter(p => p && String(p.text || '').trim() && valid.has(String(p.to || '').trim()) && idxOf(p.from).length);
  const forget = (Array.isArray(obj.forget) ? obj.forget : []).filter(p => p && idxOf(p.from).length);
  out.remember = remember.map(p => ({ from: idxOf(p.from).map(i => i + 1), to: String(p.to), text: String(p.text), why: String(p.why || '') }));
  out.forget = forget.map(p => ({ from: idxOf(p.from).map(i => i + 1), why: String(p.why || '') }));
  if (!apply) return out;
  const used = [];
  for (const p of remember) {
    const row = rows.find(r => r.key === p.to);
    addMemory({ lv: Number(row?.node?.level ?? row?.depth ?? 2), path: p.to, text: p.text, ws: '*', src: 'promote-q5', exp: expByLife(row?.life) });
    addEntry('key', `Q5 自主记住：${p.text} → ${p.to}`, { summary: `Q5记住·${row?.name || ''}` });
    for (const i of idxOf(p.from)) used.push(i);
  }
  for (const p of forget) for (const i of idxOf(p.from)) used.push(i);
  for (const i of [...new Set(used)]) {
    const e = src[i];
    try { deleteMemory({ day: e.day, t: e.t, text: e.text, path: e.path }); } catch { /* 已删就不管 */ }
  }
  return out;
}

function consolidateCheck(opts = {}) {
  const everyH = Number((db.consolidateConfig || {}).ruleEveryHours ?? 60);
  const last = Date.parse(db.state.consolidateAt || 0) || 0;
  const due = opts.force === true || (Date.now() - last) >= everyH * 3600 * 1000;
  const nodes = nodeMap(loadTree());
  let ruleKey = '';
  for (const [key, n] of nodes) if (nodeName(n) === '规则记忆') { ruleKey = key; break; }
  const entries = allStoreEntries({}).filter(e => !ruleKey || String(e.path || '').startsWith(ruleKey));
  const groups = [];
  const used = new Set();
  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    const g = [entries[i]];
    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue;
      const s = simScore(entries[i].text, entries[j].text);
      if (s.score >= Number((db.consolidateConfig || {}).similarity ?? 0.35)) { g.push(entries[j]); used.add(j); }
    }
    if (g.length > 1) { used.add(i); groups.push(g.map(e => ({ id: shortId(e.text), day: e.day, text: summarize(e.text, 80) }))); }
  }
  return {
    due, ruleKey, lastRun: db.state.consolidateAt || null,
    nextDueAt: last ? new Date(last + everyH * 3600 * 1000).toISOString() : null,
    scanned: entries.length, groups: groups.slice(0, 20), total: entries.length,
  };
}

// 生命周期体检（只读）
function lifecycleReport() {
  const today = dayOf();
  const entries = allStoreEntries({});
  const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const alive = entries.filter(e => Number(e.lv) !== M_LV);
  const expired = alive.filter(e => isDate(e.exp) && e.exp < today);
  const soon = alive.filter(e => isDate(e.exp) && e.exp >= today && daysBetween(today, e.exp) <= 3);
  const byLv = {};
  for (const e of entries) byLv[e.lv] = (byLv[e.lv] || 0) + 1;
  const mAlive = entries.filter(e => Number(e.lv) === M_LV && e.mState !== 'archive');
  const mArchive = entries.filter(e => Number(e.lv) === M_LV && e.mState === 'archive');
  return {
    today, total: entries.length, byLv,
    expired: expired.length, soon: soon.length,
    mAlive: mAlive.length, mArchive: mArchive.length,
    expiredSample: expired.slice(0, 10).map(e => ({ id: shortId(e.text), day: e.day, lv: e.lv, exp: e.exp, text: summarize(e.text, 60) })),
    soonSample: soon.slice(0, 10).map(e => ({ id: shortId(e.text), day: e.day, lv: e.lv, exp: e.exp, text: summarize(e.text, 60) })),
    mLastRun: db.state.mLastRun || null,
  };
}

// ---------------- 人设 ----------------

const PERSONA_MODES = new Set(['append', 'replace']);

function listPersonas() {
  const data = db.personas || { version: 1, personas: [] };
  return {
    total: data.personas.length,
    items: data.personas.map(p => ({
      id: p.id, name: p.name ?? '', enabled: p.enabled === true, fallback: p.fallback === true,
      mode: p.mode ?? 'append', text: p.text ?? '', targets: Array.isArray(p.targets) ? p.targets : [],
    })),
  };
}

function addPersona(input) {
  const data = db.personas = db.personas || { version: 1, personas: [], prefs: {} };
  const id = input.id ?? `psn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  if (data.personas.some(p => p.id === id)) throw new Error(`id 已存在：${id}`);
  data.personas.push({
    id,
    name: typeof input.name === 'string' && input.name ? input.name : '新的人设',
    enabled: input.enabled === true, fallback: input.fallback === true,
    text: typeof input.text === 'string' ? input.text : '',
    mode: PERSONA_MODES.has(input.mode) ? input.mode : 'append',
    targets: Array.isArray(input.targets) ? input.targets : [],
  });
  saveDb();
  return { id };
}

function updatePersona(input) {
  const { id } = input;
  if (!id) throw new Error('缺 id');
  const data = db.personas || { personas: [] };
  const hit = data.personas.find(p => p.id === id);
  if (!hit) throw new Error(`没有这条人设：${id}`);
  const changed = [];
  if (typeof input.name === 'string' && input.name !== hit.name) { hit.name = input.name; changed.push('name'); }
  if (typeof input.text === 'string' && input.text !== hit.text) {
    if (Buffer.byteLength(input.text, 'utf8') > 64 * 1024) throw new Error('人设正文超过 64KB');
    hit.text = input.text; changed.push('text');
  }
  if (typeof input.enabled === 'boolean' && input.enabled !== hit.enabled) { hit.enabled = input.enabled; changed.push('enabled'); }
  if (typeof input.fallback === 'boolean' && input.fallback !== hit.fallback) { hit.fallback = input.fallback; changed.push('fallback'); }
  if (typeof input.mode === 'string' && input.mode !== hit.mode) {
    if (!PERSONA_MODES.has(input.mode)) throw new Error('mode 只能是 append / replace');
    hit.mode = input.mode; changed.push('mode');
  }
  if (!changed.length) return { id, changed };
  saveDb();
  return { id, changed };
}

function deletePersona(input) {
  const { id } = input;
  if (!id) throw new Error('缺 id');
  const data = db.personas || { personas: [] };
  const before = data.personas.length;
  data.personas = data.personas.filter(p => p.id !== id);
  if (data.personas.length === before) throw new Error(`没有这条人设：${id}`);
  saveDb();
  return { id };
}

// ---------------- HTTP ----------------

function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

async function readJson(req, maxBytes = 2_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(Error('请求内容过大'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(Error('请求格式不正确'), { status: 400 });
  }
}

// 星轨页的数据：T0 主干 + T1 名称 + 全部 store 条目，页面启动时内联注入
let orbitCache = { rev: '', html: '' };
function orbitData() {
  const rows = walkTree(loadTree());
  // 星图只表达中心星 + 本我/自我/超我 三颗，其余根不上图
  const BODY = '主体 - 意识本体';
  const THREE = ['本我', '自我', '超我'];
  const depth0 = rows.filter(r => r.depth === 0);
  const body = depth0.find(r => r.name === BODY);
  const roots = body
    ? rows.filter(x => x.parentKey === BODY && THREE.includes(x.name)).map(x => ({
        name: x.name,
        t1: rows.filter(y => y.parentKey === x.name).map(y => y.name),
      }))
    : depth0.map(r => ({
        name: r.name,
        t1: rows.filter(x => x.parentKey === r.name).map(x => x.name),
      }));
  const mems = [];
  for (const day of Object.keys(db.store).sort()) {
    for (const o of db.store[day] || []) {
      mems.push({ t: o.t, lv: o.lv, path: o.path, text: o.text, exp: o.exp ?? null, hit: o.hit ?? 0, ws: o.ws ?? '*', src: o.src ?? '', d: day });
    }
  }
  return { roots, mems };
}

function sendPageData(res, file, marker, needsData) {
  if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: 'not found' });
  let html;
  if (orbitCache.rev === rev && orbitCache.file === file) html = orbitCache.html;
  else {
    html = fs.readFileSync(file, 'utf8');
    if (needsData) html = html.replace(marker, JSON.stringify(orbitData()));
    orbitCache = { rev, file, html };
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function sendFile(res, file, type) {
  if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: 'not found' });
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
}

function localOnly(req) {
  const addr = req.socket?.remoteAddress?.replace(/^::ffff:/, '') || '';
  return addr === '::1' || addr === '127.0.0.1' || addr.startsWith('127.');
}

async function 处理请求(req, res) {
  try {
    if (!db) 确保库();
    // 允许 DSH 页面（另一个端口）直接调用：跨源够用，仍只认本机来源
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (!localOnly(req)) return json(res, 403, { ok: false, error: '只允许本机访问' });
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const p = url.pathname;
    const q = Object.fromEntries(url.searchParams.entries());

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return sendFile(res, path.join(HERE, 'index.html'), 'text/html; charset=utf-8');
    if (req.method === 'GET' && p === '/orbit') return sendPageData(res, path.join(PAGES, '星轨.html'), '__DATA__', true);
    // 2026-11-15：DSH 记忆树面板的「星图」iframe 请求 /dsh-shiram/api/star3d → 上游 /api/star3d，
    // 这里给同一个星轨页做别名，面板里的星图才连得上（原来 404 白屏）。
    if (req.method === 'GET' && p === '/api/star3d') return sendPageData(res, path.join(PAGES, '星轨.html'), '__DATA__', true);
    if (req.method === 'GET' && p.startsWith('/bg/')) {
      const name = path.basename(decodeURIComponent(p.slice(4)));
      const file = path.join(PAGES, 'bg', name);
      if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: 'not found' });
      res.writeHead(200, { 'Content-Type': name.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream', 'Cache-Control': 'max-age=86400' });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'GET' && p === '/api/rev') return json(res, 200, { ok: true, rev, built_at: db.built_at });
    if (req.method === 'GET' && p === '/api/status') {
      const trackCounts = {};
      for (const t of TRACKS) trackCounts[t] = t === 'daily' ? Object.keys(db.tracks.daily || {}).length : readEntries(t).length;
      return json(res, 200, { ok: true, dataFile: DATA_FILE, size: fs.statSync(DATA_FILE).size, storeDays: Object.keys(db.store).length, storeEntries: Object.values(db.store).reduce((n, a) => n + a.length, 0), tracks: trackCounts, personas: (db.personas?.personas || []).length, rev });
    }
    if (req.method === 'GET' && p === '/api/tree') return json(res, 200, { ok: true, ...buildView({ keyword: q.q || '' }) });
    if (req.method === 'GET' && p === '/api/tracks') {
      return json(res, 200, {
        ok: true,
        tracks: TRACKS.map(t => ({
          track: t, label: TRACK_LABEL[t],
          count: t === 'daily' ? Object.keys(db.tracks.daily || {}).length : readEntries(t).length,
        })),
        dailyDays: Object.keys(db.tracks.daily || {}).sort().reverse(),
      });
    }
    const tm = /^\/api\/tracks\/([a-z]+)(?:\/([a-z]+))?$/.exec(p);
    if (tm) {
      const track = tm[1];
      if (!TRACKS.includes(track)) return json(res, 400, { ok: false, error: '未知轨' });
      const opts = { date: q.date, workspace: q.workspace };
      if (req.method === 'GET' && !tm[2]) {
        const entries = (q.archived === '1' ? readArchived(track, opts) : readEntries(track, opts))
          .filter(e => !q.filter || `${e.body} ${e.summary} ${e.date}`.toLowerCase().includes(String(q.filter).toLowerCase()));
        return json(res, 200, { ok: true, track, label: TRACK_LABEL[track], entries });
      }
      if (req.method === 'POST' && tm[2] === 'add') {
        const body = await readJson(req);
        const content = String(body.content ?? '').trim();
        if (!content) return json(res, 400, { ok: false, error: '内容为空' });
        const r = addEntry(track, content, { summary: body.summary, date: body.date, workspace: body.workspace });
        return json(res, 200, { ok: true, ...r });
      }
      if (req.method === 'POST' && tm[2] === 'replace') {
        const body = await readJson(req);
        return json(res, 200, replaceEntry(track, body.match, body.content, opts));
      }
      if (req.method === 'POST' && tm[2] === 'remove') {
        const body = await readJson(req);
        return json(res, 200, removeEntry(track, body.match, { ...opts, all: body.all === true }));
      }
      if (req.method === 'POST' && tm[2] === 'archive') {
        const body = await readJson(req);
        return json(res, 200, archiveEntry(track, body.match, opts));
      }
    }
    if (req.method === 'GET' && p === '/api/m/plan') return json(res, 200, { ok: true, ...runM({ apply: false }) });
    if (req.method === 'POST' && p === '/api/m/run') { const b = await readJson(req).catch(() => ({})); return json(res, 200, { ok: true, ...runM({ apply: b.apply !== false }) }); }
    if (req.method === 'POST' && p === '/api/m/intake') { const b = await readJson(req); return json(res, 200, intakeM(b.text, b)); }
    if (req.method === 'GET' && p === '/api/consolidate') return json(res, 200, { ok: true, ...consolidateCheck({ force: q.force === '1' }) });
    if (req.method === 'GET' && p === '/api/lifecycle') return json(res, 200, { ok: true, ...lifecycleReport() });
    if (req.method === 'GET' && p === '/api/personas') return json(res, 200, { ok: true, ...listPersonas() });
    if (req.method === 'POST' && p === '/api/personas/add') return json(res, 200, { ok: true, ...addPersona(await readJson(req)) });
    if (req.method === 'POST' && p === '/api/personas/update') return json(res, 200, { ok: true, ...updatePersona(await readJson(req)) });
    if (req.method === 'POST' && p === '/api/personas/delete') return json(res, 200, { ok: true, ...deletePersona(await readJson(req)) });
    if (req.method === 'POST' && p === '/api/memory/add') return json(res, 200, { ok: true, ...addMemory(await readJson(req)) });
    if (req.method === 'POST' && p === '/api/memory/update') return json(res, 200, { ok: true, ...updateMemory(await readJson(req)) });
    if (req.method === 'POST' && p === '/api/memory/delete') return json(res, 200, { ok: true, ...deleteMemory(await readJson(req)) });
    if (req.method === 'POST' && p === '/api/tree/rename') { const b = await readJson(req); return json(res, 200, { ok: true, ...renameNode(b.key, b.name) }); }
    if (req.method === 'POST' && p === '/api/tree/add-node') return json(res, 200, { ok: true, ...addChildNode(await readJson(req)) });
    if (req.method === 'POST' && p === '/api/tree/delete-node') return json(res, 200, { ok: true, ...deleteNode(await readJson(req)) });
  if (req.method === 'GET' && p === '/api/sessions') return json(res, 200, { ok: true, root: SESSIONS_ROOT, sessions: sListSessions() });
  if (req.method === 'POST' && p === '/api/intake/scan') { const b = await readJson(req); return json(res, 200, { ok: true, ...(await sScan(b)) }); }
  if (req.method === 'POST' && p === '/api/intake/tidy') { const b = await readJson(req).catch(() => ({})); return json(res, 200, { ok: true, ...(await sTidy(b)) }); }
  if (req.method === 'POST' && p === '/api/intake/promote') { const b = await readJson(req).catch(() => ({})); return json(res, 200, { ok: true, ...(await sPromote(b)) }); }
  if (req.method === 'POST' && p === '/api/intake/promote-q5') { const b = await readJson(req).catch(() => ({})); return json(res, 200, { ok: true, ...(await sPromoteQ5(b)) }); }
  if (req.method === 'GET' && p === '/api/auto') return json(res, 200, { ok: true, auto: db.auto, pending: autoPendingCount() });
  if (req.method === 'POST' && p === '/api/auto') {
    const b = await readJson(req).catch(() => ({}));
    if (typeof b.intake === 'boolean') db.auto.intake = b.intake;
    if (typeof b.tidy === 'boolean') db.auto.tidy = b.tidy;
    if (b.intakeEveryHours > 0) db.auto.intakeEveryHours = Number(b.intakeEveryHours);
    if (b.tidyEveryHours > 0) db.auto.tidyEveryHours = Number(b.tidyEveryHours);
    if (b.resetIntakeHistory === true) db.auto.doneSids = [];
    saveDb();
    return json(res, 200, { ok: true, auto: db.auto });
  }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    return json(res, err.status || 500, { ok: false, error: String(err.message || err) });
  }
}

// （数据文件由 确保库() 懒初始化，模块顶层不再读盘、也不再 process.exit）

// 自动汲取 / 自动整理：每 60 秒看一眼该不该跑（开关在页面/面板标题旁）
function autoPendingSessions(limit = 3) {
  const done = new Set((db.auto && db.auto.doneSids) || []);
  return sListSessions().filter(s => !done.has(s.sid)).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}
function autoPendingCount() {
  const done = new Set((db.auto && db.auto.doneSids) || []);
  return sListSessions().filter(s => !done.has(s.sid)).length;
}

let autoBusy = false;
export function 起自动任务() {
  const 表 = setInterval(async () => {
  if (autoBusy) return;
  const a = db.auto || {};
  const now = Date.now();
  const dueIntake = a.intake && now - Number(a.lastIntakeAt || 0) >= Number(a.intakeEveryHours || 2) * 3600e3;
  const dueTidy = a.tidy && now - Number(a.lastTidyAt || 0) >= Number(a.tidyEveryHours || 24) * 3600e3;
  if (!dueIntake && !dueTidy) return;
  autoBusy = true;
  try {
    if (dueIntake) {
      const ids = autoPendingSessions(3).map(s => s.sid);
      a.lastIntakeAt = now; saveDb();
      if (!ids.length) console.log('[auto] 汲取：没有新会话，跳过');
      else {
        try {
          const r = await sScan({ ids, apply: true, maxTurns: 6 });
          a.doneSids = [...new Set([...(a.doneSids || []), ...ids])]; saveDb();
          console.log('[auto] 汲取', ids.length, '个会话，', r.scannedTurns, '轮，写', r.written, '条');
        } catch (e) { console.error('[auto] 汲取失败', e.message); }
      }
    }
    if (dueTidy) {
      a.lastTidyAt = Date.now(); saveDb();
      try { const r = await sTidy({ apply: true }); console.log('[auto] 整理', r.total, '→', r.moved); }
      catch (e) { console.error('[auto] 整理失败', e.message); }
    }
  } finally { autoBusy = false; }
  }, 60 * 1000);
  return () => clearInterval(表);
}

// ---------------- 两种跑法 ----------------
// 1) 独立：node app.mjs —— 听 8080，和以前一样
// 2) 插件：由 index.js 挂到 DSH 的 webServer 下（前缀 /dsh-memory-list）
export { 处理请求 as 处理, DATA_FILE, BACKUP_DIR, 数据根, SESSIONS_ROOT, 确保库 };

const 是被直接运行 = (() => {
  try {
    const 入口 = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return !!入口 && 入口.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch { return false; }
})();

if (是被直接运行) {
  const 新建 = 确保数据文件();
  loadDb();
  起自动任务();
  const server = http.createServer(处理请求);
  server.listen(PORT, '127.0.0.1', () => {
    console.log('记忆识海已启动  http://127.0.0.1:' + PORT);
    console.log('数据：' + DATA_FILE + '（' + (fs.statSync(DATA_FILE).size / 1024 / 1024).toFixed(2) + ' MB）' + (新建 ? ' · 已按骨架初始化' : ''));
  });
}
