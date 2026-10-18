/**
 * DOM 集成测试：node test/dom-test.mjs
 * 用 jsdom 模拟 GitHub 页面，跑真实 content.js，验证 v1.1 的全部增强：
 *   1. 界面词条 / 动态规则 / 自定义词条
 *   2. <pre>/<code>/<textarea> 不被破坏
 *   3. Shadow DOM（relative-time / tool-tip / clipboard-copy 那类组件）
 *   4. <select><option> 文本翻译且 value 不被污染
 *   5. <svg><title> 的 tooltip 文本
 *   6. 正文（README）走翻译服务
 *   7. 词典未收录的文案走「机翻兜底」
 *   8. 动态插入节点被处理
 *   9. 还原把英文放回去、并清掉临时加上的 value
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dictSource = fs.readFileSync(path.join(root, 'src/dictionary.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(root, 'src/content.js'), 'utf8');

const HTML = `<!DOCTYPE html>
<html><head><title>Issues · GitHub</title></head>
<body>
  <header>
    <a href="/pulls">Pull requests</a>
    <a href="/issues">Issues</a>
    <span>12 commits</span>
    <span>2 days ago</span>
    <button type="button">Watch</button>
    <button type="button">Fork</button>
    <input placeholder="Search or jump to..." />
    <textarea placeholder="Add a description"></textarea>
  </header>

  <nav><a>Code</a><a>Actions</a><a>Settings</a></nav>

  <div class="markdown-body">
    <p>This is a README paragraph that should be translated in full mode.</p>
    <pre><code>Issues</code></pre>
  </div>

  <pre><code><span>Issues</span></code></pre>

  <select id="sort">
    <option>Newest</option>
    <option>Oldest</option>
  </select>

  <svg width="16" height="16"><title>Copy to clipboard</title><path d="M0 0h1v1H0z"/></svg>

  <div id="host"></div>
  <div id="late-host"></div>
  <div id="unknown">Configure the deployment pipeline for staging</div>
  <div id="late"></div>
</body></html>`;

const virtualConsole = new VirtualConsole();
const dom = new JSDOM(HTML, { url: 'https://github.com/foo/bar', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole });
const { window } = dom;

// ── chrome 桩：记录翻译请求，返回「〔译〕+原文」 ─────────
const settings = {
  enabled: true,
  translateContent: true,
  machineFallback: true,
  provider: 'google',
  glossary: 'Fork=复刻一下\n# 注释行应被忽略\nbroken-line',
};
const translateCalls = [];
let contentListener = null;

window.chrome = {
  runtime: {
    id: 'test',
    lastError: undefined,
    onMessage: { addListener(fn) { contentListener = fn; } },
    sendMessage(payload, cb) {
      if (payload.type === 'ghzh:translate') {
        translateCalls.push(payload.texts.slice());
        const results = payload.texts.map((t) => `〔译〕${t}`);
        setTimeout(() => cb({ ok: true, results }), 0);
      } else {
        setTimeout(() => cb({ ok: true }), 0);
      }
    },
  },
  storage: {
    sync: { get(_k, cb) { cb({ settings }); }, set(_v, cb) { if (cb) cb(); } },
    onChanged: { addListener() {} },
  },
};

/** 模拟 popup 给内容脚本发消息 */
function sendToContent(msg) {
  return new Promise((resolve) => {
    if (!contentListener) { resolve(null); return; }
    contentListener(msg, {}, resolve);
  });
}

// IntersectionObserver：视为立即可见；ShadowRoot 观察兼容
window.IntersectionObserver = class {
  constructor(cb) { this.cb = cb; }
  observe(el) { this.cb([{ target: el, isIntersecting: true }]); }
  unobserve() {}
  disconnect() {}
};

// 模拟自定义元素（<relative-time> / <tool-tip> 那样定义时就带 shadow root）
const earlyShadow = window.document.getElementById('host').attachShadow({ mode: 'open' });
earlyShadow.innerHTML = '<button>Copy to clipboard</button><span>3 days ago</span><p>Loading...</p>';

window.eval(dictSource);
window.eval(contentSource);
window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(600);

// ── 断言 ────────────────────────────────────────────────
const $ = (sel) => window.document.querySelector(sel);
const $$ = (sel) => [...window.document.querySelectorAll(sel)];
let failed = 0;
const log = [];

function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failed++;
  log.push(`${pass ? '✅' : '❌'} ${name}\n    实际: ${JSON.stringify(actual)}${pass ? '' : `\n    期望: ${JSON.stringify(expected)}`}`);
}

// 1. 基础界面
check('导航链接 Pull requests', $$('header a')[0].textContent, '拉取请求');
check('导航链接 Issues', $$('header a')[1].textContent, '议题');
check('动态规则 12 commits', $$('header span')[0].textContent, '12 次提交');
check('动态规则 2 days ago', $$('header span')[1].textContent, '2 天前');
check('按钮 Watch', $$('header button')[0].textContent, '关注');
check('自定义词条覆盖 Fork', $$('header button')[1].textContent, '复刻一下');
check('nav Code', $$('nav a')[0].textContent, '代码');
check('nav Actions', $$('nav a')[1].textContent, '工作流');
check('input placeholder', $('header input').getAttribute('placeholder'), '搜索或跳转到…');
check('textarea placeholder', $('header textarea').getAttribute('placeholder'), '添加描述');
check('title 翻译', window.document.title, '议题 · GitHub');

// 2. 代码不被破坏
check('代码块（markdown 内）不动', $('.markdown-body pre code').textContent, 'Issues');
check('代码块（页面级）不动', $$('body > pre code')[0].textContent, 'Issues');

// 3. select / option
check('option 1 翻译', $$('#sort option')[0].textContent, '最新');
check('option 2 翻译', $$('#sort option')[1].textContent, '最早');
check('option value 未被中文污染', $$('#sort option')[0].getAttribute('value'), 'Newest');
check('select 当前值仍可用', $('#sort').value, 'Newest');

// 4. svg title
check('svg title 翻译', $('#host') ? $('svg title').textContent : '', '复制到剪贴板');

// 5. Shadow DOM
check('shadow 内按钮翻译', earlyShadow.querySelector('button').textContent, '复制到剪贴板');
check('shadow 内相对时间翻译', earlyShadow.querySelector('span').textContent, '3 天前');
check('shadow 内短词翻译', earlyShadow.querySelector('p').textContent, '加载中…');

// 5b. 后挂载的 shadow root（靠兜底扫描发现）
const lateShadow = $('#late-host').attachShadow({ mode: 'open' });
lateShadow.innerHTML = '<span>Watch</span>';
await wait(2900);
check('后挂载 shadow 也被翻译', lateShadow.querySelector('span').textContent, '关注');

// 6. 正文
check('正文走翻译服务', $('.markdown-body p').textContent,
  '〔译〕This is a README paragraph that should be translated in full mode.');

// 7. 机翻兜底
check('未收录文案被机翻补全', $('#unknown').textContent,
  '〔译〕Configure the deployment pipeline for staging');

// 8. 动态节点
const late = window.document.createElement('div');
late.innerHTML = '<button>Star</button><span>3 branches</span>';
$('#late').appendChild(late);
await wait(400);
check('动态节点按钮 Star', late.querySelector('button').textContent, '星标');
check('动态节点 3 branches', late.querySelector('span').textContent, '3 个分支');

// 9. 还原
const status = window.__GHZH_STATS__();
check('统计字段可用', typeof status.dict === 'number' && status.dict > 1000, true);
check('界面翻译计数 > 0', status.ui > 0, true);
check('正文翻译计数 > 0', status.prose > 0, true);
check('机翻计数 > 0', status.machine > 0, true);

const revertResp = await sendToContent({ type: 'ghzh:revert' });
await wait(100);
check('revert 返回 ok', revertResp && revertResp.ok, true);
check('还原后按钮回英文', $$('header button')[0].textContent, 'Watch');
check('还原后 placeholder 回英文', $('header input').getAttribute('placeholder'), 'Search or jump to...');
check('还原后 option 回英文', $$('#sort option')[0].textContent, 'Newest');
check('还原后临时的 value 属性被移除', $$('#sort option')[0].hasAttribute('value'), false);
check('还原后正文回英文', $('.markdown-body p').textContent,
  'This is a README paragraph that should be translated in full mode.');
check('还原后 data-ghzh 标记清空', window.document.querySelectorAll('[data-ghzh]').length, 0);

// 10. 重新翻译
const againResp = await sendToContent({ type: 'ghzh:retranslate' });
await wait(400);
check('重新翻译返回 ok', againResp && againResp.ok, true);
check('重新翻译后按钮再次中文', $$('header button')[0].textContent, '关注');

// 11. 状态接口
const statusResp = await sendToContent({ type: 'ghzh:status' });
check('状态接口 ok', statusResp && statusResp.ok, true);
check('状态里带词条数', statusResp.dictEntries > 1000, true);

console.log('DOM 集成测试 · GitHub 汉化 v1.1');
console.log(`  翻译服务调用批次：${translateCalls.length}`);
console.log(`  词典 ${status.dict} 条 · 短语 ${status.phrases} 条 · 规则 ${status.patterns} 条`);
console.log(`  计数：界面 ${status.ui} · 正文 ${status.prose} · 机翻 ${status.machine}`);
console.log('');
for (const line of log) console.log(line);
console.log('');
console.log(failed === 0 ? '全部通过' : `${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
