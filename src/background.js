/**
 * GitHub 汉化 · 后台服务（Service Worker）
 * ---------------------------------------------------------------
 * 只做三件事：接消息 / 调翻译服务 / 管缓存。
 * 支持的服务：
 *   google  —— 免密钥（translate.googleapis.com，非官方公开端点）
 *   deepl   —— DeepL API（免费版 / 专业版）
 *   azure   —— Microsoft Translator
 *   openai  —— 任意 OpenAI 兼容接口（OpenAI / DeepSeek / 本地 vLLM…）
 */

const DEFAULTS = {
  enabled: true,
  translateContent: true,
  machineFallback: true,
  provider: 'google',
  targetLang: 'zh-CN',
  glossary: '',
  floatingButton: false,
  showOriginalOnHover: false,
  deeplKey: '',
  deeplPro: false,
  azureKey: '',
  azureRegion: '',
  openaiBase: 'https://api.openai.com/v1',
  openaiKey: '',
  openaiModel: 'gpt-4o-mini',
};

const CACHE_PREFIX = 't:';
const CACHE_LIMIT = 30000;
const MEM_CACHE_LIMIT = 4000;

/** @type {Map<string, string>} */
const memCache = new Map();

// ── 工具 ──────────────────────────────────────────────────
function hashText(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (Math.imul(h2 ^ c, 2246822519) + i) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

async function getSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

function cacheKey(provider, target, text) {
  return CACHE_PREFIX + hashText(`${provider}|${target}|${text}`);
}

function memPut(key, value) {
  if (memCache.size >= MEM_CACHE_LIMIT) {
    const first = memCache.keys().next().value;
    if (first !== undefined) memCache.delete(first);
  }
  memCache.set(key, value);
}

async function cacheRead(keys) {
  const out = {};
  const missing = [];
  for (const key of keys) {
    if (memCache.has(key)) out[key] = memCache.get(key);
    else missing.push(key);
  }
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const got = await chrome.storage.local.get(chunk);
    for (const [k, v] of Object.entries(got)) {
      if (typeof v === 'string') {
        out[k] = v;
        memPut(k, v);
      }
    }
  }
  return out;
}

async function cacheWrite(entries) {
  for (const [k, v] of Object.entries(entries)) memPut(k, v);
  try {
    await chrome.storage.local.set(entries);
  } catch (err) {
    // 配额满了就整体清一次再写
    console.warn('[GitHub 汉化] 缓存写入失败，清理后重试：', err);
    await pruneCache(true);
    try { await chrome.storage.local.set(entries); } catch (_) { /* 放弃缓存 */ }
  }
}

let cacheOps = 0;
async function pruneCache(force) {
  if (!force && ++cacheOps % 500 !== 0) return;
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  if (keys.length <= CACHE_LIMIT && !force) return;
  await chrome.storage.local.remove(keys);
  memCache.clear();
}

// ── 并发 / 限速 ───────────────────────────────────────────
class Queue {
  constructor(limit) { this.limit = limit; this.active = 0; this.tasks = []; }
  run(task) {
    return new Promise((resolve, reject) => {
      this.tasks.push({ task, resolve, reject });
      this.pump();
    });
  }
  pump() {
    while (this.active < this.limit && this.tasks.length) {
      const { task, resolve, reject } = this.tasks.shift();
      this.active++;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => { this.active--; this.pump(); });
    }
  }
}

const queues = {
  google: new Queue(3),
  deepl: new Queue(2),
  azure: new Queue(2),
  openai: new Queue(2),
};

async function fetchJson(url, options, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch (_) { return text; }
  } finally {
    clearTimeout(timer);
  }
}

// ── 服务实现 ──────────────────────────────────────────────
const MARKER = /@@\s*(\d+)\s*@@/;

async function googleBatch(texts, target) {
  const joined = texts.map((t, i) => `@@${i}@@ ${t}`).join('\n');
  const url = 'https://translate.googleapis.com/translate_a/single'
    + `?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(joined)}`;
  const data = await fetchJson(url, { method: 'GET', headers: { Accept: 'application/json' } });
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('翻译服务返回格式异常');
  const translated = data[0].map((seg) => (Array.isArray(seg) ? seg[0] || '' : '')).join('');
  const out = new Array(texts.length).fill(undefined);
  const parts = translated.split(MARKER);
  for (let i = 1; i < parts.length; i += 2) {
    const idx = Number(parts[i]);
    if (Number.isInteger(idx) && idx >= 0 && idx < texts.length) {
      out[idx] = (parts[i + 1] || '').trim();
    }
  }
  return out;
}

async function translateGoogle(texts, settings) {
  const target = settings.targetLang || 'zh-CN';
  const results = new Array(texts.length).fill(undefined);

  // 按字符预算分桶，避免单请求过长
  const buckets = [];
  let current = [];
  let size = 0;
  for (let i = 0; i < texts.length; i++) {
    const len = texts[i].length + 12;
    if (len > 3000) { buckets.push([i]); continue; }
    if (size + len > 2500 && current.length) { buckets.push(current); current = []; size = 0; }
    current.push(i);
    size += len;
  }
  if (current.length) buckets.push(current);

  for (const bucket of buckets) {
    if (bucket.length === 1 && texts[bucket[0]].length > 3000) {
      results[bucket[0]] = await translateGoogleLong(texts[bucket[0]], target);
      continue;
    }
    const sub = bucket.map((i) => texts[i]);
    try {
      const got = await queues.google.run(() => googleBatch(sub, target));
      bucket.forEach((originalIndex, k) => {
        if (got[k] !== undefined) results[originalIndex] = got[k];
      });
    } catch (err) {
      // 批量失败：逐个兜底
      for (const i of bucket) {
        try {
          const single = await queues.google.run(() => googleBatch([texts[i]], target));
          if (single[0] !== undefined) results[i] = single[0];
        } catch (_) { /* 留空 */ }
      }
      console.warn('[GitHub 汉化] google 批量翻译失败：', err.message);
    }
  }
  return results;
}

async function translateGoogleLong(text, target) {
  const sentences = text.split(/(?<=[.!?。！？])\s+/);
  const chunks = [];
  let buf = '';
  for (const s of sentences) {
    if ((buf + s).length > 1500) { if (buf) chunks.push(buf); buf = s; }
    else buf += (buf ? ' ' : '') + s;
  }
  if (buf) chunks.push(buf);
  const parts = [];
  for (const chunk of chunks) {
    const got = await queues.google.run(() => googleBatch([chunk], target));
    parts.push(got[0] || chunk);
  }
  return parts.join(' ');
}

async function translateDeepL(texts, settings) {
  const key = (settings.deeplKey || '').trim();
  if (!key) throw new Error('未配置 DeepL API Key');
  const base = settings.deeplPro ? 'https://api.deepl.com' : 'https://api-free.deepl.com';
  const target = (settings.targetLang || 'zh-CN').toLowerCase().startsWith('zh-tw') ? 'ZH-HANT' : 'ZH';
  const results = new Array(texts.length).fill(undefined);
  for (let i = 0; i < texts.length; i += 25) {
    const slice = texts.slice(i, i + 25);
    const data = await queues.deepl.run(() => fetchJson(`${base}/v2/translate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `DeepL-Auth-Key ${key}`,
      },
      body: JSON.stringify({ text: slice, target_lang: target, source_lang: 'EN' }),
    }));
    const list = data && data.translations;
    if (!Array.isArray(list)) throw new Error('DeepL 返回格式异常');
    list.forEach((item, k) => { results[i + k] = item.text; });
  }
  return results;
}

async function translateAzure(texts, settings) {
  const key = (settings.azureKey || '').trim();
  if (!key) throw new Error('未配置 Microsoft Translator Key');
  const target = (settings.targetLang || 'zh-CN').toLowerCase().startsWith('zh-tw') ? 'zh-Hant' : 'zh-Hans';
  const results = new Array(texts.length).fill(undefined);
  const region = (settings.azureRegion || '').trim();
  for (let i = 0; i < texts.length; i += 20) {
    const slice = texts.slice(i, i + 20);
    const headers = {
      'Content-Type': 'application/json',
      'Ocp-Apim-Subscription-Key': key,
    };
    if (region) headers['Ocp-Apim-Subscription-Region'] = region;
    const data = await queues.azure.run(() => fetchJson(
      `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=${target}`,
      { method: 'POST', headers, body: JSON.stringify(slice.map((t) => ({ Text: t }))) },
    ));
    if (!Array.isArray(data)) throw new Error('Azure 返回格式异常');
    data.forEach((item, k) => {
      const text = item?.translations?.[0]?.text;
      if (text) results[i + k] = text;
    });
  }
  return results;
}

async function translateOpenAI(texts, settings) {
  const key = (settings.openaiKey || '').trim();
  if (!key) throw new Error('未配置 OpenAI 兼容接口 Key');
  const base = (settings.openaiBase || DEFAULTS.openaiBase).replace(/\/+$/, '');
  const model = settings.openaiModel || DEFAULTS.openaiModel;
  const target = (settings.targetLang || 'zh-CN').startsWith('zh-TW') ? '繁体中文' : '简体中文';
  const results = new Array(texts.length).fill(undefined);

  for (let i = 0; i < texts.length; i += 20) {
    const slice = texts.slice(i, i + 20);
    const prompt = [
      `把下面的 JSON 字符串数组逐条翻译成${target}，保持原有顺序与条数，保留 Markdown 标记、代码、URL 和专有名词。`,
      '只输出 JSON 数组，不要任何解释或代码块标记。',
      JSON.stringify(slice),
    ].join('\n');
    const data = await queues.openai.run(() => fetchJson(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: '你是专业的技术文档译者，只输出合法 JSON。' },
          { role: 'user', content: prompt },
        ],
      }),
    }), 60000);
    const content = data?.choices?.[0]?.message?.content || '';
    let parsed = null;
    try { parsed = JSON.parse(content); } catch (_) {
      const m = content.match(/\[[\s\S]*\]/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch (_) { parsed = null; } }
    }
    if (Array.isArray(parsed) && parsed.length === slice.length) {
      parsed.forEach((item, k) => {
        if (typeof item === 'string' && item.trim()) results[i + k] = item.trim();
      });
    } else {
      // 兜底：按行切分
      const lines = content.split(/\r?\n/).map((l) => l.replace(/^\s*[-*\d.]+[.)]?\s*/, '').trim()).filter(Boolean);
      if (lines.length === slice.length) lines.forEach((l, k) => { results[i + k] = l; });
      else console.warn('[GitHub 汉化] OpenAI 返回条数不匹配，跳过本批');
    }
  }
  return results;
}

const PROVIDERS = {
  google: translateGoogle,
  deepl: translateDeepL,
  azure: translateAzure,
  openai: translateOpenAI,
};

// ── 统一入口（含缓存）─────────────────────────────────────
async function translateTexts(texts, settings) {
  const provider = PROVIDERS[settings.provider] ? settings.provider : 'google';
  const target = settings.targetLang || 'zh-CN';
  const results = new Array(texts.length).fill(undefined);

  const keys = texts.map((t) => cacheKey(provider, target, t));
  const cached = await cacheRead(keys);

  const todo = [];
  for (let i = 0; i < texts.length; i++) {
    const hit = cached[keys[i]];
    if (typeof hit === 'string') results[i] = hit;
    else todo.push(i);
  }
  if (!todo.length) return results;

  const input = todo.map((i) => texts[i]);
  let translated;
  try {
    translated = await PROVIDERS[provider](input, settings);
  } catch (err) {
    console.warn('[GitHub 汉化] 翻译服务出错：', err);
    throw err;
  }

  const toCache = {};
  todo.forEach((originalIndex, k) => {
    const value = translated[k];
    if (typeof value === 'string' && value.trim()) {
      results[originalIndex] = value.trim();
      toCache[keys[originalIndex]] = value.trim();
    }
  });
  if (Object.keys(toCache).length) await cacheWrite(toCache);
  pruneCache(false).catch(() => {});
  return results;
}

// ── 消息路由 ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'ghzh:translate') {
    const texts = Array.isArray(msg.texts) ? msg.texts.filter((t) => typeof t === 'string' && t.trim()) : [];
    if (!texts.length) { sendResponse({ ok: true, results: [] }); return true; }
    (async () => {
      try {
        const settings = await getSettings();
        const results = await translateTexts(texts, settings);
        sendResponse({ ok: true, results: results.map((r) => (typeof r === 'string' ? r : '')) });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;  // 异步响应
  }

  if (msg.type === 'ghzh:ping') {
    sendResponse({ ok: true, version: '1.0.0', uptime: true });
    return true;
  }

  if (msg.type === 'ghzh:test') {
    (async () => {
      try {
        const settings = await getSettings();
        if (!PROVIDERS[settings.provider]) {
          sendResponse({ ok: false, error: `未知翻译服务：${settings.provider}` });
          return;
        }
        const out = await translateTexts(['Hello, world! This is a translation test.'], settings);
        sendResponse({ ok: true, sample: out[0] || '' });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    })();
    return true;
  }

  if (msg.type === 'ghzh:clearCache') {
    (async () => {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
      if (keys.length) await chrome.storage.local.remove(keys);
      memCache.clear();
      sendResponse({ ok: true, removed: keys.length });
    })();
    return true;
  }

  return false;
});

// 安装时写入一次默认设置，方便 popup / options 读取
chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.sync.get('settings');
  if (!settings) {
    await chrome.storage.sync.set({ settings: DEFAULTS });
  }
});

self.__GHZH_BACKGROUND_READY__ = true;
