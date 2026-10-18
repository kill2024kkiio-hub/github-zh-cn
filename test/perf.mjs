/**
 * 性能测试：node test/perf.mjs
 * ---------------------------------------------------------------
 * 用一个「长页面」压测三件事：
 *   1. 单次遍历（首屏）耗时是否被时间预算切住，不阻塞主线程
 *   2. 大量文本 + 长正文时的总完成时间（分片续跑、批量、并发）
 *   3. 请求批次数是否合理（说明有批量而不是一条一请求）
 *
 * 阈值按 jsdom 的吞吐设定（比真 Chrome 慢），主要用于回归保护：
 * 一旦有人把「整页重扫」「一条一请求」改回来，这里会立刻爆。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dictSource = fs.readFileSync(path.join(root, 'src/dictionary.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(root, 'src/content.js'), 'utf8');

// ── 构造长页面 ──────────────────────────────────────────
const UI_WORDS = [
  'Pull requests', 'Issues', 'Watch', 'Star', 'Fork', 'Commits', 'Branches', 'Tags',
  'Overview', 'Settings', 'Notifications', 'Labels', 'Milestones', 'Assignees',
  '12 commits', '2 days ago', '3 branches', '5 files changed', '7 open', '18 closed',
  'Copy to clipboard', 'Show more', 'Learn more', 'Sign in', 'Sign up',
  // 故意混入未收录文案，走机翻兜底
  'Configure the deployment pipeline for staging environment',
  'This workspace has unsaved changes that will be lost',
];
const UI_COUNT = 2500;
const PROSE_COUNT = 300;

const uiBlocks = [];
for (let i = 0; i < UI_COUNT; i++) {
  // 真实文案（不带序号，避免构造出 GitHub 不会出现的组合）
  uiBlocks.push(`<span class="ui">${UI_WORDS[i % UI_WORDS.length]}</span>`);
}
const proseBlocks = [];
for (let i = 0; i < PROSE_COUNT; i++) {
  proseBlocks.push(`<p>Paragraph ${i} explains how the deployment pipeline resolves dependencies and caches artifacts for faster builds.</p>`);
}

const HTML = `<!DOCTYPE html><html><head><title>Issues · GitHub</title></head><body>
  <header><a href="/pulls">Pull requests</a><button>Watch</button></header>
  <div class="ui-wrap">${uiBlocks.join('')}</div>
  <div class="markdown-body">${proseBlocks.join('')}</div>
</body></html>`;

const virtualConsole = new VirtualConsole();
const dom = new JSDOM(HTML, { url: 'https://github.com/foo/bar', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole });
const { window } = dom;

const translateCalls = [];
const settings = { enabled: true, translateContent: true, machineFallback: true, provider: 'google', glossary: '' };

window.chrome = {
  runtime: {
    id: 'test',
    lastError: undefined,
    onMessage: { addListener() {} },
    sendMessage(payload, cb) {
      if (payload.type === 'ghzh:translate') {
        translateCalls.push(payload.texts.length);
        const results = payload.texts.map((t) => `〔译〕${t}`);
        setTimeout(() => cb({ ok: true, results }), 15);      // 模拟网络往返
      } else setTimeout(() => cb({ ok: true }), 0);
    },
  },
  storage: { sync: { get(_k, cb) { cb({ settings }); }, set() {} }, onChanged: { addListener() {} } },
};
window.IntersectionObserver = class {
  constructor(cb) { this.cb = cb; }
  observe(el) { this.cb([{ target: el, isIntersecting: true }]); }
  unobserve() {}
  disconnect() {}
};
window.requestIdleCallback = (fn) => setTimeout(fn, 0);

const t0 = Date.now();
window.eval(dictSource);
window.eval(contentSource);
window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

const poll = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 等首轮（UI 计数开始增长）─────────────────────────────
await poll(80);
const stats0 = window.__GHZH_STATS__();
const firstPassMs = stats0.timings.firstPassMs;

// ── 等全部完成（pending 归零且计数连续 1 秒不变）─────────
let last = -1;
let stableTicks = 0;
let elapsed = 0;
while (elapsed < 20000) {
  await poll(100);
  elapsed += 100;
  const s = window.__GHZH_STATS__();
  const total = s.ui + s.prose + s.machine;
  if (total === last && s.pending === 0) stableTicks++;
  else { stableTicks = 0; last = total; }
  if (stableTicks >= 10) break;
}

const stats = window.__GHZH_STATS__();
const totalMs = Date.now() - t0;
const batchTotal = translateCalls.reduce((a, b) => a + b, 0);
const maxBatch = Math.max(...translateCalls);

// 兜底：轮询判定稳定后，再给尾部批次一点时间（网络往返 + 续跑切片）
await poll(800);
const statsFinal = window.__GHZH_STATS__();

// ── 抽样：确认没有丢翻 ──────────────────────────────────
const spans = [...window.document.querySelectorAll('.ui-wrap .ui')];
const untranslated = spans.filter((el) => !/[\u4e00-\u9fff]/.test(el.textContent));
const proseLeft = [...window.document.querySelectorAll('.markdown-body p')]
  .filter((el) => !/[\u4e00-\u9fff]/.test(el.textContent));

let failed = 0;
const check = (name, actual, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${name}：${actual}${detail ? `（${detail}）` : ''}`);
};

console.log('性能测试 · GitHub 汉化');
console.log(`  页面规模：${UI_COUNT} 个 UI 文本 + ${PROSE_COUNT} 段正文`);
console.log(`  词条：${stats.dict} · 短语：${stats.phrases} · 规则：${stats.patterns}`);
console.log('');

check('首屏单次遍历耗时', `${firstPassMs} ms`, firstPassMs > 0 && firstPassMs <= 60,
  `时间预算 ${8} ms，超时自动分片；实际切了 ${stats.timings.passes} 次`);
check('分片次数', `${stats.timings.passes} 次`, stats.timings.passes >= 2);
check('全页处理总耗时', `${totalMs} ms`, totalMs <= 12000);
check('UI 文本已翻译', `${UI_COUNT - untranslated.length}/${UI_COUNT}`, untranslated.length === 0,
  untranslated.length ? `漏翻示例：${untranslated.slice(0, 3).map((e) => e.textContent).join(' | ')}` : '');
check('正文段落已翻译', `${PROSE_COUNT - proseLeft.length}/${PROSE_COUNT}`, proseLeft.length === 0);
check('请求总条数', `${batchTotal} 条`, batchTotal > 0);
check('批次数', `${translateCalls.length} 批`, translateCalls.length * 64 >= batchTotal * 0.85,
  `单批最多 ${maxBatch} 条，上限 64`);
check('平均批量', `${(batchTotal / translateCalls.length).toFixed(1)} 条/批`, batchTotal / translateCalls.length >= 20);
check('未出现一条一请求', `${translateCalls.filter((n) => n === 1).length} 批单条`, translateCalls.filter((n) => n === 1).length <= 2);

console.log('');
console.log(`walk：seen ${statsFinal.seen} · skipped ${statsFinal.skipped} · pending ${statsFinal.pending}`);
console.log(`统计：界面 ${statsFinal.ui} · 正文 ${statsFinal.prose} · 机翻 ${statsFinal.machine}`);
console.log(failed === 0 ? '全部通过' : `${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
