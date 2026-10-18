/**
 * GitHub 汉化 · 内容脚本（v1.1）
 * ===============================================================
 * 与 v1.0 的关键差别（也就是「翻译不全」的根源）：
 *   1. Shadow DOM：GitHub 大量用 <relative-time> <tool-tip> <clipboard-copy>
 *      这类自定义元素，文本在 shadow root 里，普通遍历完全碰不到
 *   2. 多级匹配：精确 → 去标点 → 模板 → 分隔符分段 → 短语片段兜底
 *   3. <select>/<option> 从「整棵跳过」改为「翻译选项文本」
 *   4. <svg><title> 的 tooltip 文本也翻
 *   5. 可选机器兜底：词典没收录的界面短文案，送翻译服务补全（默认开）
 *   6. 60 帧友好：遍历带时间预算，长页面不卡主线程
 */
(function () {
  'use strict';

  if (window.__GHZH_LOADED__) return;
  window.__GHZH_LOADED__ = true;

  const DICT = window.__GHZH_DICT__ || {};
  const PHRASES = window.__GHZH_PHRASES__ || {};
  const PATTERNS = window.__GHZH_PATTERNS__ || [];

  console.log(`[GitHub 汉化] 引擎启动 v${window.__GHZH_META__?.version || '?'} · 词条 ${Object.keys(DICT).length} · 短语 ${Object.keys(PHRASES).length} · 规则 ${PATTERNS.length}`);

  // ── 设置 ────────────────────────────────────────────────
  const DEFAULTS = {
    enabled: true,
    translateContent: true,
    machineFallback: true,      // 词典没收录的 UI 文案也机翻
    provider: 'google',
    targetLang: 'zh-CN',
    glossary: '',
    floatingButton: false,
    showOriginalOnHover: false,
  };
  let settings = { ...DEFAULTS };
  let dict = {};
  let phraseReplace = null;

  // ── 跳过规则 ────────────────────────────────────────────
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TT',
    'CANVAS', 'IFRAME', 'OBJECT', 'MATH',
  ]);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const SKIP_SELECTOR = [
    'pre', 'code', 'kbd', 'samp', 'textarea', 'input',
    '[contenteditable=""]', '[contenteditable="true"]',
    '.blob-code', '.blob-code-inner', '.js-file-line', '.react-code-text', '.react-code-lines',
    '.highlight', '.CodeMirror', '.cm-editor', '.cm-content', '.monaco-editor',
    '.js-code-nav-container', '.js-blob-code-container',
    '.ghzh-ui', '.ghzh-float',
    '[data-ghzh-skip]',
  ].join(',');
  // ── 性能参数 ────────────────────────────────────────────
  const BATCH_SIZE = 64;            // 每批送翻译的文本节点数
  const FLUSH_DELAY = 120;          // 队列攒不够时的去抖
  const IMMEDIATE_THRESHOLD = 12;   // 攒够这么多就立刻发，不等去抖
  const MAX_INFLIGHT = 2;           // 同时在途的批次（配合后台 3 并发）
  const TIME_BUDGET_MS = 8;         // 单次遍历的时间预算，超了就分片续跑
  const ROOT_MARGIN = '1200px 0px'; // 正文预加载范围
  const PREFETCH_BLOCKS = 16;       // 首屏立即预翻译的正文块数

  const PROSE_SELECTOR = '.markdown-body, .comment-body, .js-comment-body, .md-body';
  const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dt, dd, figcaption, summary, caption';
  const ATTR_NAMES = ['placeholder', 'title', 'aria-label', 'alt', 'data-tooltip', 'aria-description', 'label'];
  const ATTR_SELECTOR = ATTR_NAMES.map((n) => `[${n}]`).join(',');

  // ── 运行状态 ────────────────────────────────────────────
  const state = { ui: 0, prose: 0, machine: 0, seen: 0, skipped: 0, lastError: '', runs: 0 };
  const timings = { lastPassMs: 0, maxPassMs: 0, passes: 0, firstPassMs: 0 };

  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  function markTiming(startedAt) {
    const ms = Math.round((now() - startedAt) * 10) / 10;
    timings.lastPassMs = ms;
    if (ms > timings.maxPassMs) timings.maxPassMs = ms;
    if (!timings.firstPassMs) timings.firstPassMs = ms;
    timings.passes++;
  }

  const textOriginals = new Map();          // Text → 原文
  const attrOriginals = new WeakMap();      // Element → { 属性名: 原文 }
  let observedBlocks = new WeakSet();       // 已观察的正文块
  let observedShadows = new WeakSet();      // 已观察的 shadow root
  const inflight = new Map();               // Text → 原文（翻译中）
  const attemptedGen = new WeakMap();       // Text → 尝试时的代数，revert 后代数 +1
  let generation = 0;                       // 每次还原 +1，让"已尝试"标记失效
  let mutationObserver = null;
  let intersectionObserver = null;
  let machineFailures = 0;

  // ── 词典查询管线 ────────────────────────────────────────
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const hasChinese = (text) => /[\u4e00-\u9fff]/.test(text);

  function escapeRe(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function buildPhraseReplacer(table) {
    const keys = Object.keys(table).filter((k) => k.trim().length > 2);
    if (!keys.length) return null;
    // 长的优先，避免 "pull request" 被 "request" 抢走
    keys.sort((a, b) => b.length - a.length);
    const map = new Map();
    for (const key of keys) map.set(key.toLowerCase(), table[key]);
    const alternation = keys.map(escapeRe).join('|');
    const re = new RegExp(`(?<![\\w/.:#@-])(${alternation})(?![\\w/.:#@-])`, 'gi');
    return (text) => text.replace(re, (whole) => map.get(whole.toLowerCase()) ?? whole);
  }

  function buildDictionary() {
    dict = { ...DICT };
    if (settings.glossary) {
      for (const line of String(settings.glossary).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx < 1) continue;
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (key && val) dict[key] = val;
      }
    }
    phraseReplace = buildPhraseReplacer(PHRASES);
  }

  function exact(text) {
    if (hasOwn(dict, text)) return dict[text];
    // 只在真的含大写时构造小写变体，省掉每个节点的 toLowerCase 分配
    if (UPPER_RE.test(text)) {
      const lower = text.toLowerCase();
      if (lower !== text && hasOwn(dict, lower)) return dict[lower];
    }
    // 只有小写开头才可能命中「首字母大写」词条
    const code = text.charCodeAt(0);
    if (code >= 97 && code <= 122) {
      const cap = text.charAt(0).toUpperCase() + text.slice(1);
      if (hasOwn(dict, cap)) return dict[cap];
    }
    return null;
  }

  const UPPER_RE = /[A-Z]/;
  const HAS_LETTER_RE = /[A-Za-z]/;
  const TAIL_PUNCT_RE = /[.:!?,;]$/;
  const SEGMENT_RE = /[·|•–—]/;

  function stripEdgePunctuation(text) {
    if (!TAIL_PUNCT_RE.test(text)) return null;
    const m = text.match(/^([\s\S]*?)([.:!?,;]+)$/);
    return m ? { body: m[1].trim(), tail: m[2] } : null;
  }

  const digitPatterns = [];
  const generalPatterns = [];
  for (const rule of PATTERNS) {
    const src = String(rule[0].source);
    if (/^\^\(?\\d|^\^\[\^?\\d/.test(src)) digitPatterns.push(rule);
    else generalPatterns.push(rule);
  }

  function runPatterns(text) {
    const buckets = [];
    if (/^\d/.test(text)) buckets.push(digitPatterns, generalPatterns);
    else buckets.push(generalPatterns);
    for (const bucket of buckets) {
      for (let i = 0; i < bucket.length; i++) {
        const [re, fn] = bucket[i];
        const m = text.match(re);
        if (!m) continue;
        try {
          const out = fn(m);
          if (out && out !== text) return out;
        } catch (_) { /* 单条规则坏掉不影响整体 */ }
      }
    }
    return null;
  }

  /** "Pull requests · Issues" 这类拼接文案：各段都命中才合并 */
  function translateSegments(text) {
    if (text.length > 120 || !SEGMENT_RE.test(text)) return null;
    const parts = text.split(/(\s+[·|•–—]\s+)/);
    if (parts.length < 3) return null;
    let translated = 0;
    const out = parts.map((part) => {
      if (/^\s+[·|•–—]\s+$/.test(part)) return part;
      const hit = exact(part.trim()) || runPatterns(part.trim());
      if (hit) { translated++; return hit; }
      return part;
    });
    if (!translated) return null;
    // 至少一半片段命中才采用，避免半中半英的怪句子
    const total = parts.filter((p) => !/^\s+[·|•–—]\s+$/.test(p)).length;
    return translated * 2 >= total ? out.join('') : null;
  }

  const englishWords = (str) => (str.match(/[A-Za-z][A-Za-z'’-]{1,}/g) || []).length;

  /** 片段兜底：只翻已知短语，残词太多就放弃（免得半英半中） */
  function translatePhrases(text) {
    if (!phraseReplace) return null;
    if (text.length > 64) return null;
    const out = phraseReplace(text);
    if (out === text || !hasChinese(out)) return null;
    const leftovers = englishWords(out);
    const allowed = text.length <= 24 ? 2 : 2;
    return leftovers <= allowed ? out : null;
  }

  /** "Sort: Newest" / "Learn more about X" 这类可拆解的模板（深度 1 递归） */
  const RECURSIVE_TEMPLATES = [
    [/^([A-Za-z][A-Za-z ]{1,28}?):\s*(.+)$/, (rest) => {
      const left = translateText(rest[1].trim(), 1);
      const right = translateText(rest[2].trim(), 1);
      if (!left && !right) return null;
      return `${left || rest[1].trim()}：${right || rest[2].trim()}`;
    }],
    [/^Learn more about (.+)$/, (m) => `进一步了解 ${translateText(m[1], 1) || m[1]}`],
    [/^(.+?)\?\s*(.+)$/, (m) => {
      const left = translateText(m[1].trim(), 1);
      const right = translateText(m[2].trim(), 1);
      if (!left && !right) return null;
      return `${left || m[1].trim()}？${right || m[2].trim()}`;
    }],
  ];

  /** 统一入口：返回译文或 null */
  function translateText(text, depth = 0) {
    if (!text) return null;
    // 纯数字/标点/emoji 直接放弃，省掉后续全部匹配成本（GitHub 这类节点很多）
    if (!HAS_LETTER_RE.test(text)) return null;

    let hit = exact(text);
    if (hit) return hit;

    const stripped = stripEdgePunctuation(text);
    if (stripped) {
      hit = exact(stripped.body) || runPatterns(stripped.body);
      if (hit) {
        const tail = stripped.tail === '.' ? '。' : stripped.tail === ':' ? '：' : '';
        return hit + tail;
      }
    }

    hit = runPatterns(text);
    if (hit) return hit;

    if (depth === 0) {
      for (const [re, fn] of RECURSIVE_TEMPLATES) {
        const m = text.match(re);
        if (!m) continue;
        const out = fn(m);
        if (out && out !== text && hasChinese(out)) return out;
      }
    }

    hit = translateSegments(text);
    if (hit) return hit;

    return translatePhrases(text);
  }

  // 暴露给测试 / 调试：页面控制台可 __GHZH_TRANSLATE__('Pull requests')
  window.__GHZH_TRANSLATE__ = (text) => translateText(String(text || ''));
  window.__GHZH_STATS__ = () => ({
    dict: Object.keys(dict).length,
    phrases: Object.keys(PHRASES).length,
    patterns: PATTERNS.length,
    ui: state.ui,
    prose: state.prose,
    machine: state.machine,
    seen: state.seen,
    skipped: state.skipped,
    lastError: state.lastError,
    timings: { ...timings },
    pending: pendingNodes.size,
  });

  /** 判定这段文本是否值得送去机翻（避免把代码/路径/ID 发出去） */
  function machineCandidate(text) {
    if (!settings.machineFallback) return false;
    if (text.length < 3 || text.length > 200) return false;
    if (!/[A-Za-z]{2}/.test(text)) return false;
    if (/[_/\\{}$<>]/.test(text)) return false;            // 路径、模板、代码
    if (/^[\w.-]+@[\w.-]+$/.test(text)) return false;
    if (/^[A-Z0-9_-]{4,}$/.test(text)) return false;        // 全大写缩写
    if (!/\s/.test(text) && text.length < 5) return false;  // 太短的单词
    return true;
  }

  // ── 文本节点处理 ────────────────────────────────────────
  function setTranslatedAttr(el, name, original) {
    const rec = attrOriginals.get(el) || {};
    if (!(name in rec)) rec[name] = original;
    attrOriginals.set(el, rec);
  }

  function applyText(node, translated, counter) {
    const raw = node.nodeValue;
    if (!raw) return false;
    const lead = raw.slice(0, raw.length - raw.trimStart().length);
    const trail = raw.slice(raw.trimEnd().length);
    if (!textOriginals.has(node)) textOriginals.set(node, raw);
    const parent = node.parentElement;
    // <option> 没有 value 属性时，value 取自文本；先固定住原值，避免把表单参数改成中文
    if (parent && parent.tagName === 'OPTION' && !parent.hasAttribute('value')) {
      parent.setAttribute('value', raw.trim());
      parent.dataset.ghzhOpt = '1';
    }
    node.nodeValue = lead + translated + trail;
    if (parent) {
      if (!parent.dataset.ghzh) parent.dataset.ghzh = '1';
      if (settings.showOriginalOnHover && !parent.getAttribute('title') && !attrOriginals.get(parent)?.title) {
        setTranslatedAttr(parent, 'title', raw.trim());
      }
    }
    if (counter) state[counter]++;
    return true;
  }

  function handleTextNode(node) {
    const raw = node.nodeValue;
    if (!raw) return false;
    const text = raw.trim();
    if (!text || text.length > 400) return false;
    state.seen++;
    if (hasChinese(text)) return false;
    if (attemptedGen.get(node) === generation || inflight.has(node) || textOriginals.has(node)) { state.skipped++; return false; }

    const translated = translateText(text);
    if (translated) return applyText(node, translated, 'ui');

    if (machineCandidate(text)) {
      pendingNodes.add(node);
      scheduleTranslateFlush();
    }
    return false;
  }

  // ── 属性处理 ────────────────────────────────────────────
  // 旧做法：querySelectorAll('*') 再对每个元素读 7 个属性（全页上万次 getAttribute）。
  // 新做法：按属性名分别用原生选择器筛选，浏览器内部按索引命中，只处理真有值的元素。
  let proseCache = new WeakMap();

  function isProseEl(el) {
    let v = proseCache.get(el);
    if (v === undefined) {
      v = !!(el.closest && el.closest(PROSE_SELECTOR));
      proseCache.set(el, v);
    }
    return v;
  }

  function translateOneAttr(el, name) {
    const value = el.getAttribute(name);
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 400 || hasChinese(trimmed)) return;
    if (isProseEl(el)) return;
    const hit = translateText(trimmed);
    if (!hit) return;
    setTranslatedAttr(el, name, value);
    el.setAttribute(name, hit);
    if (!el.dataset.ghzh) el.dataset.ghzh = '1';
    state.ui++;
  }

  function translateAttributes(root) {
    if (root.nodeType !== 1 && root.nodeType !== 11) return;

    // 叶子节点：直接查 7 个属性名，比 7 次 querySelectorAll 便宜得多
    if (root.nodeType === 1 && root.childElementCount === 0) {
      for (const name of ATTR_NAMES) {
        if (root.hasAttribute && root.hasAttribute(name)) translateOneAttr(root, name);
      }
      if (root.tagName === 'INPUT') translateInputValue(root);
      return;
    }

    for (const name of ATTR_NAMES) {
      if (root.nodeType === 1 && root.hasAttribute && root.hasAttribute(name)) translateOneAttr(root, name);
      const els = root.querySelectorAll(`[${name}]`);
      for (let i = 0; i < els.length; i++) translateOneAttr(els[i], name);
    }

    // <input type=submit|button|reset> 的 value 是按钮文字
    const buttons = root.querySelectorAll('input[type="submit"], input[type="button"], input[type="reset"]');
    for (let i = 0; i < buttons.length; i++) translateInputValue(buttons[i]);
  }

  function translateInputValue(el) {
    const trimmed = (el.value || '').trim();
    if (!trimmed || hasChinese(trimmed) || isProseEl(el)) return;
    const hit = translateText(trimmed);
    if (!hit) return;
    setTranslatedAttr(el, 'value', el.value);
    el.value = hit;
    if (!el.dataset.ghzh) el.dataset.ghzh = '1';
    state.ui++;
  }

  // ── DOM 遍历（含 Shadow DOM）─────────────────────────────
  const nodeFilter = {
    acceptNode(node) {
      if (node.nodeType === 1) {
        if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
        if (node.namespaceURI === SVG_NS) {
          const tag = node.tagName.toLowerCase();
          // svg 容器与 title/desc/foreignObject 放行，图形元素剪掉
          if (tag === 'svg' || tag === 'title' || tag === 'desc' || tag === 'foreignobject') return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_REJECT;
        }
        if (node.matches && node.matches(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (node.matches && node.matches(PROSE_SELECTOR)) return NodeFilter.FILTER_REJECT;
        // 元素本身要返回，才能发现 shadowRoot（FILTER_SKIP 会跳过元素自身）
        return NodeFilter.FILTER_ACCEPT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  };

  function observeShadow(shadowRoot) {
    if (!shadowRoot || observedShadows.has(shadowRoot)) return;
    observedShadows.add(shadowRoot);
    if (mutationObserver) mutationObserver.observe(shadowRoot, { subtree: true, childList: true, characterData: true });
    translateRoot(shadowRoot);
  }

  // ── 调度：按子树切块，避免长任务卡主线程 ────────────────
  // 不再暂停/恢复 TreeWalker（会漏节点），而是把大容器拆成子元素逐个处理：
  // 每个任务在 8ms 预算内尽量多做，做不完就排到下一个宏任务。
  const workQueue = [];
  let working = false;
  let attrsDone = new WeakSet();
  let proseDone = new WeakSet();

  function translateRoot(root) {
    if (!settings.enabled || !root) return;
    if (root.nodeType === 1 && root.matches && root.matches(SKIP_SELECTOR)) return;
    workQueue.push(root);
    if (!working) {
      working = true;
      setTimeout(runWork, 0);
    }
  }

  function runWork() {
    const deadline = now() + TIME_BUDGET_MS;
    while (workQueue.length) {
      if (now() > deadline) { setTimeout(runWork, 0); return; }   // working 保持 true
      const root = workQueue.shift();
      if (!root || !root.isConnected) continue;
      try {
        processRoot(root);
      } catch (err) {
        console.warn('[GitHub 汉化] 局部处理失败，跳过该子树：', err);
      }
    }
    working = false;
  }

  function processRoot(root) {
    // 每个 root 的属性 / 正文调度只做一次
    if (!attrsDone.has(root)) {
      attrsDone.add(root);
      translateAttributes(root);
    }
    if (settings.translateContent && !proseDone.has(root)) {
      proseDone.add(root);
      scheduleProse(root);
    }
    // 大容器继续拆：保证单次任务体量可控（按元素数判断，而不是直接子元素数）
    if (root.nodeType === 1 && root.childElementCount > 2) {
      const count = root.querySelectorAll('*').length;
      if (count > 400) {
        for (let i = 0; i < root.children.length; i++) workQueue.push(root.children[i]);
        return;
      }
    }
    translateSubtree(root);
  }

  function translateSubtree(root) {
    const startedAt = now();
    const hosts = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, nodeFilter, false);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 1) {
        if (node.shadowRoot) hosts.push(node.shadowRoot);
        // 自定义元素（<relative-time> / <tool-tip> 之类）可能稍后才升级出 shadow root
        else if (node.tagName.includes('-')) recheckQueue.push(node);
        continue;
      }
      handleTextNode(node);
    }
    for (const sr of hosts) observeShadow(sr);
    if (recheckQueue.length) scheduleShadowRecheck();
    markTiming(startedAt);
  }

  // ── 延迟复查：自定义元素升级后才出现的 shadow root ──────
  const recheckQueue = [];
  let recheckTimer = null;

  function scheduleShadowRecheck() {
    if (recheckTimer) return;
    recheckTimer = setTimeout(() => {
      recheckTimer = null;
      const hosts = recheckQueue.splice(0, recheckQueue.length);
      for (const el of hosts) {
        if (el.shadowRoot) observeShadow(el.shadowRoot);
      }
    }, 300);
  }

  /** 兜底扫描：启动后 1.2 秒扫一次（抓自定义元素首次升级），之后每 4 秒一次 */
  let shadowSweepTimer = null;

  function sweepShadowRoots() {
    if (!settings.enabled) return;
    if (document.visibilityState === 'hidden') return;
    const run = () => {
      let count = 0;
      for (const el of document.querySelectorAll('*')) {
        if (++count > 20000) break;
        if (el.shadowRoot && !observedShadows.has(el.shadowRoot)) observeShadow(el.shadowRoot);
      }
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1500 });
    else run();
  }

  function startShadowSweep() {
    if (shadowSweepTimer) return;
    const tick = (delay) => {
      shadowSweepTimer = setTimeout(() => {
        sweepShadowRoots();
        tick(4000);
      }, delay);
    };
    tick(1200);
  }

  function stopShadowSweep() {
    if (shadowSweepTimer) { clearTimeout(shadowSweepTimer); shadowSweepTimer = null; }
  }

  // ── 标题 ────────────────────────────────────────────────
  function translateTitle() {
    const t = document.title;
    if (!t || hasChinese(t)) return;
    const m = t.match(/^(.+?)(\s*[·|\-–]\s*GitHub.*)$/);
    const head = (m ? m[1] : t).trim();
    const hit = translateText(head);
    if (!hit) return;
    document.title = m ? hit + m[2] : hit;
    state.ui++;
  }

  // ── 机器兜底 + 正文：统一翻译队列 ───────────────────────
  const pendingNodes = new Set();
  let flushTimer = null;
  let inflightBatches = 0;

  function scheduleTranslateFlush() {
    clearTimeout(flushTimer);
    // 攒够一定量就立刻发（长页面/长 README 的关键：不等去抖）
    const delay = pendingNodes.size >= IMMEDIATE_THRESHOLD ? 0 : FLUSH_DELAY;
    flushTimer = setTimeout(flushTranslations, delay);
  }

  /** 一批完成后立刻泵下一批（可开满并发），不再固定等 400ms */
  function pumpNext() {
    let pumped = 0;
    while (pendingNodes.size && inflightBatches < MAX_INFLIGHT && pumped < MAX_INFLIGHT) {
      pumped++;
      void flushTranslations();
    }
  }

  function sendMessage(payload) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
        reject(new Error('扩展上下文失效，请刷新页面'));
        return;
      }
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(resp);
        });
      } catch (e) { reject(e); }
    });
  }

  async function flushTranslations() {
    if (!settings.enabled || pendingNodes.size === 0) return;
    if (inflightBatches >= MAX_INFLIGHT) return;
    // 服务连续失败时放弃「机翻兜底」，但正文（用户明确要的）继续尝试
    if (machineFailures >= 2) {
      for (const n of [...pendingNodes]) {
        if (!n.parentElement || !n.parentElement.closest(PROSE_SELECTOR)) pendingNodes.delete(n);
      }
      if (pendingNodes.size === 0) return;
    }

    const nodes = [...pendingNodes].filter((n) => n.isConnected);
    pendingNodes.clear();
    if (!nodes.length) return;

    const batch = nodes.slice(0, BATCH_SIZE);
    for (const n of nodes.slice(BATCH_SIZE)) pendingNodes.add(n);

    const texts = batch.map((n) => (n.nodeValue || '').trim());
    const startedAt = generation;
    batch.forEach((n) => { inflight.set(n, n.nodeValue); attemptedGen.set(n, generation); });

    inflightBatches++;
    try {
      const resp = await sendMessage({ type: 'ghzh:translate', texts });
      if (startedAt !== generation) { batch.forEach((n) => inflight.delete(n)); return; }
      if (!resp || !resp.ok) throw new Error(resp?.error || '翻译服务无响应');
      const results = resp.results || [];
      batch.forEach((node, i) => {
        inflight.delete(node);
        const value = results[i];
        if (!value || !String(value).trim()) return;
        if (!node.isConnected) return;
        const raw = node.nodeValue || '';
        if (!raw.trim()) return;
        if (String(value).trim() === raw.trim()) return;
        const isProse = node.parentElement && node.parentElement.closest(PROSE_SELECTOR);
        applyText(node, String(value).trim(), isProse ? 'prose' : 'machine');
      });
      state.lastError = '';
      machineFailures = 0;
    } catch (err) {
      batch.forEach((n) => inflight.delete(n));
      state.lastError = String(err && err.message ? err.message : err);
      machineFailures++;
      if (machineFailures === 2) console.warn('[GitHub 汉化] 翻译服务连续失败，本页暂停机翻兜底：', state.lastError);
    } finally {
      inflightBatches--;
      pumpNext();
    }
  }

  // ── 正文块（README / 评论）───────────────────────────────
  function collectProseNodes(block) {
    const out = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === 1) {
          if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
          if (node.matches && node.matches(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        }
        const text = (node.nodeValue || '').trim();
        if (text.length < 2) return NodeFilter.FILTER_REJECT;
        if (hasChinese(text)) return NodeFilter.FILTER_REJECT;
        if (textOriginals.has(node) || inflight.has(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    }, false);
    let n;
    while ((n = walker.nextNode())) if (n.nodeType === 3) out.push(n);
    return out;
  }

  function scheduleProse(root) {
    if (!settings.translateContent || !intersectionObserver) return;
    const blocks = [];
    if (root.nodeType === 1 && root.matches && root.matches(BLOCK_SELECTOR) && root.closest(PROSE_SELECTOR)) blocks.push(root);
    const found = root.querySelectorAll ? root.querySelectorAll(BLOCK_SELECTOR) : [];
    for (const b of found) {
      if (!b.closest(PROSE_SELECTOR)) continue;
      blocks.push(b);
    }
    for (const b of blocks) {
      if (observedBlocks.has(b)) continue;
      observedBlocks.add(b);
      intersectionObserver.observe(b);
    }
  }

  // ── 观察器 ──────────────────────────────────────────────
  const pendingRoots = new Set();
  let flushScheduled = false;

  function scheduleDomFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    setTimeout(() => {
      flushScheduled = false;
      const roots = [...pendingRoots];
      pendingRoots.clear();
      for (const root of roots) if (root && root.isConnected) translateRoot(root);
    }, 100);
  }

  function startObservers() {
    if (!mutationObserver) {
      mutationObserver = new MutationObserver((records) => {
        let textOnly = false;
        for (const rec of records) {
          if (rec.type === 'characterData') {
            // 关键优化：只处理这一个文本节点，绝不重扫父容器
            const target = rec.target;
            const parent = target.parentElement;
            if (!parent) continue;
            if (parent.closest && parent.closest(SKIP_SELECTOR)) continue;
            if (parent.closest && parent.closest(PROSE_SELECTOR)) continue;
            if (target.nodeValue && !hasChinese(target.nodeValue)) handleTextNode(target);
            textOnly = true;
          } else if (rec.type === 'childList') {
            for (const n of rec.addedNodes) {
              if (n.nodeType === 1) pendingRoots.add(n);
              else if (n.nodeType === 3 && n.parentElement) pendingRoots.add(n.parentElement);
            }
          }
        }
        if (pendingRoots.size) scheduleDomFlush();
        else if (textOnly) scheduleTranslateFlush();
      });
    }
    // document_start 注入时 documentElement 可能还没建好，退化到观察 document
    const observeTarget = document.documentElement || document;
    mutationObserver.observe(observeTarget, { subtree: true, childList: true, characterData: true });

    if (!intersectionObserver && 'IntersectionObserver' in window) {
      intersectionObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          intersectionObserver.unobserve(entry.target);
          for (const node of collectProseNodes(entry.target)) pendingNodes.add(node);
          scheduleTranslateFlush();
          pumpNext();
        }
      }, { rootMargin: ROOT_MARGIN });
    }
    startShadowSweep();
  }

  function stopObservers() {
    if (mutationObserver) mutationObserver.disconnect();
    if (intersectionObserver) intersectionObserver.disconnect();
    stopShadowSweep();
    // 集合重置：下次重新开启时才能重新观察（WeakSet 无法清空，直接换新）
    observedShadows = new WeakSet();
    observedBlocks = new WeakSet();
    attrsDone = new WeakSet();
    proseDone = new WeakSet();
    proseCache = new WeakMap();
    workQueue.length = 0;
    working = false;
    pendingRoots.clear();
    pendingNodes.clear();
    clearTimeout(flushTimer);
    clearTimeout(recheckTimer);
    recheckTimer = null;
    recheckQueue.length = 0;
  }

  // ── 主流程 ──────────────────────────────────────────────
  function runAll() {
    if (!settings.enabled) return;
    state.runs++;
    startObservers();
    if (document.body) {
      translateRoot(document.body);
      prefetchProse();
    }
    translateTitle();
  }

  /** 首屏正文预取：不等滚动，先把前若干块送去翻译，长 README 不必逐屏等 */
  function prefetchProse() {
    if (!settings.translateContent) return;
    const run = () => {
      if (!settings.enabled || !document.body) return;
      let queued = 0;
      const containers = document.querySelectorAll(PROSE_SELECTOR);
      for (const container of containers) {
        if (queued >= PREFETCH_BLOCKS) break;
        for (const block of container.querySelectorAll(BLOCK_SELECTOR)) {
          if (queued >= PREFETCH_BLOCKS) break;
          if (observedBlocks.has(block)) continue;
          observedBlocks.add(block);
          if (intersectionObserver) intersectionObserver.unobserve(block);
          for (const node of collectProseNodes(block)) { pendingNodes.add(node); queued++; }
        }
      }
      if (queued) { scheduleTranslateFlush(); pumpNext(); }
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 600 });
    else setTimeout(run, 0);
  }

  function revertAll() {
    stopObservers();          // 先停观察，避免还原动作本身又触发一轮翻译
    generation++;
    for (const [node, original] of textOriginals) if (node.isConnected) node.nodeValue = original;
    textOriginals.clear();
    inflight.clear();
    pendingNodes.clear();

    document.querySelectorAll('[data-ghzh]').forEach((el) => {
      const rec = attrOriginals.get(el);
      if (rec) {
        for (const [name, value] of Object.entries(rec)) {
          if (name === 'value') { if (el.tagName === 'INPUT') el.value = value; }
          else el.setAttribute(name, value);
        }
      }
      if (el.dataset.ghzhOpt) {
        el.removeAttribute('value');
        delete el.dataset.ghzhOpt;
      }
      delete el.dataset.ghzh;
    });
    state.ui = 0; state.prose = 0; state.machine = 0;
  }

  // ── 导航钩子 / 快捷键 ───────────────────────────────────
  function attachNavHooks() {
    // 导航后只补翻「新出现的部分」：observer 已经处理了新增子树，
    // 这里只再扫一次页面骨架 + 标题，避免整页重扫
    const rerun = () => setTimeout(() => {
      if (!settings.enabled || !document.body) return;
      translateTitle();
      for (const sel of ['main', 'header', 'nav[aria-label]', '[role="banner"]', '[role="navigation"]']) {
        for (const el of document.querySelectorAll(sel)) pendingRoots.add(el);
      }
      if (pendingRoots.size) scheduleDomFlush();
    }, 60);
    for (const evt of ['turbo:load', 'turbo:render', 'turbo:frame-render', 'pjax:end', 'pjax:success']) {
      document.addEventListener(evt, rerun, true);
    }
    window.addEventListener('popstate', rerun);
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.shiftKey && (e.key === 'T' || e.key === 't')) {
        e.preventDefault();
        chrome.storage.sync.get('settings', ({ settings: stored }) => {
          chrome.storage.sync.set({ settings: { ...DEFAULTS, ...(stored || {}), enabled: !settings.enabled } });
        });
      }
    }, true);
  }

  // ── 悬浮按钮 ────────────────────────────────────────────
  let floatEl = null;
  function renderFloatingButton() {
    if (!settings.floatingButton) {
      if (floatEl) { floatEl.remove(); floatEl = null; }
      return;
    }
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', renderFloatingButton, { once: true });
      return;
    }
    if (floatEl) {
      floatEl.textContent = settings.enabled ? '中' : 'EN';
      floatEl.style.opacity = settings.enabled ? '1' : '0.55';
      return;
    }
    floatEl = document.createElement('button');
    floatEl.type = 'button';
    floatEl.className = 'ghzh-float';
    floatEl.textContent = settings.enabled ? '中' : 'EN';
    floatEl.title = 'GitHub 汉化：点击切换';
    floatEl.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      chrome.storage.sync.get('settings', ({ settings: stored }) => {
        chrome.storage.sync.set({ settings: { ...DEFAULTS, ...(stored || {}), enabled: !settings.enabled } });
      });
    });
    document.body.appendChild(floatEl);
  }

  // ── 设置同步 ────────────────────────────────────────────
  function applySettings(next) {
    const was = { ...settings };
    settings = { ...DEFAULTS, ...(next || {}) };
    buildDictionary();
    renderFloatingButton();

    if (!settings.enabled) {
      stopObservers();
      revertAll();
      return;
    }
    if (!was.enabled) { runAll(); return; }
    if (was.translateContent && !settings.translateContent) {
      for (const [node, original] of [...textOriginals]) {
        if (node.isConnected && node.parentElement?.closest(PROSE_SELECTOR)) {
          node.nodeValue = original;
          textOriginals.delete(node);
        }
      }
    }
    if (!was.translateContent && settings.translateContent) runAll();
    else if (was.provider !== settings.provider || was.glossary !== settings.glossary) {
      // 换服务/换词表：重跑一遍，缓存层会自动命中
      translateRoot(document.body);
    }
  }

  function registerMessageHandler() {
    if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return;
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || !msg.type) return false;
      if (msg.type === 'ghzh:status') {
        sendResponse({
          ok: true,
          enabled: settings.enabled,
          mode: settings.translateContent ? 'full' : 'ui',
          machineFallback: settings.machineFallback,
          count: state.ui,
          contentCount: state.prose,
          machineCount: state.machine,
          provider: settings.provider,
          lastError: state.lastError,
          dictEntries: Object.keys(dict).length,
          phraseCount: Object.keys(PHRASES).length,
          patternCount: PATTERNS.length,
          timings: { ...timings },
          pending: pendingNodes.size,
        });
        return true;
      }
      if (msg.type === 'ghzh:retranslate') {
        revertAll();
        runAll();
        sendResponse({ ok: true });
        return true;
      }
      if (msg.type === 'ghzh:revert') { revertAll(); sendResponse({ ok: true }); return true; }
      return false;
    });
  }

  function boot() {
    registerMessageHandler();
    const start = (loaded) => {
      settings = { ...DEFAULTS, ...(loaded || {}) };
      buildDictionary();
      renderFloatingButton();
      attachNavHooks();
      if (!settings.enabled) return;
      runAll();
    };
    if (typeof chrome === 'undefined' || !chrome.storage) { start(settings); }
    else chrome.storage.sync.get('settings', ({ settings: stored }) => start(stored));

    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync' || !changes.settings) return;
        applySettings(changes.settings.newValue);
      });
    }
  }

  // document_start 就注入：不等 DOMContentLoaded，页面骨架一出现就开始翻，
  // 减少「先看到英文再变中文」的闪烁。body 还没到时由 observer 兜住。
  try {
    boot();
  } catch (err) {
    // 极早期文档结构缺失时，退到 DOMContentLoaded 再试一次
    console.warn('[GitHub 汉化] 提前启动失败，改为 DOM 就绪后启动：', err);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { try { boot(); } catch (e) { console.error(e); } }, { once: true });
    }
  }
})();
