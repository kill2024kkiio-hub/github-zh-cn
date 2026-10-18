/**
 * 后台服务测试：node test/background-test.mjs
 * 用假的 chrome.* 与假 fetch 跑 background.js，验证：
 *   1. ghzh:translate 消息能正确分发到 Google 服务
 *   2. 带 @@n@@ 标记的批量结果能按顺序还原
 *   3. 相同文本第二次请求直接命中本地缓存（不再发网络请求）
 *   4. ghzh:test / ghzh:clearCache 正常响应
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src/background.js'), 'utf8');

let fetchCount = 0;
const calls = [];

/** 模拟 translate.googleapis.com 的返回：把 @@n@@ 标记保留，正文加上「译：」前缀 */
function fakeFetch(url, options = {}) {
  fetchCount++;
  const u = new URL(url);
  const q = u.searchParams.get('q') || '';
  calls.push({ url: u.origin + u.pathname, q });
  const translated = q
    .split('\n')
    .map((line) => line.replace(/^@@(\d+)@@\s*/, (_m, i) => `@@${i}@@ 译：`))
    .join('\n');
  const payload = [[[translated, 'en', null, null, 10]], null, 'en'];
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(payload)),
  });
}

// ── chrome 桩 ───────────────────────────────────────────
const localStore = new Map();
let messageListener = null;
let installListener = null;

const chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { messageListener = fn; } },
    onInstalled: { addListener: (fn) => { installListener = fn; } },
  },
  storage: {
    sync: {
      get: (key) => Promise.resolve({ settings: undefined }),
      set: () => Promise.resolve(),
    },
    local: {
      get: (keys) => {
        if (keys === null || keys === undefined) {
          return Promise.resolve(Object.fromEntries(localStore));
        }
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (localStore.has(k)) out[k] = localStore.get(k);
        return Promise.resolve(out);
      },
      set: (obj) => { for (const [k, v] of Object.entries(obj)) localStore.set(k, v); return Promise.resolve(); },
      remove: (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) localStore.delete(k); return Promise.resolve(); },
    },
  },
};

const sandbox = {
  chrome,
  fetch: fakeFetch,
  console,
  setTimeout,
  clearTimeout,
  AbortController,
  URL,
  self: {},
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

let failed = 0;
const log = [];
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failed++;
  log.push(`${pass ? '✅' : '❌'} ${name}\n    实际: ${JSON.stringify(actual)}${pass ? '' : `\n    期望: ${JSON.stringify(expected)}`}`);
}

function send(msg) {
  return new Promise((resolve) => {
    const handled = messageListener(msg, {}, resolve);
    if (handled !== true && handled !== false) resolve(`返回值异常: ${handled}`);
  });
}

check('服务已初始化', typeof sandbox.self.__GHZH_BACKGROUND_READY__, 'boolean');

const r1 = await send({ type: 'ghzh:translate', texts: ['Hello world', 'Second sentence'] });
check('翻译返回 ok', r1.ok, true);
check('批量结果顺序正确', r1.results, ['译：Hello world', '译：Second sentence']);
check('一次网络请求', fetchCount, 1);
check('请求带标记', calls[0].q, '@@0@@ Hello world\n@@1@@ Second sentence');

const r2 = await send({ type: 'ghzh:translate', texts: ['Hello world', 'Second sentence'] });
check('第二次命中缓存', r2.results, ['译：Hello world', '译：Second sentence']);
check('缓存命中不发请求', fetchCount, 1);
check('缓存写入本地存储', localStore.size, 2);

const r3 = await send({ type: 'ghzh:translate', texts: ['Hello world', 'Brand new text'] });
check('混合命中：老文本取缓存、新文本发请求', r3.results, ['译：Hello world', '译：Brand new text']);
check('只翻译缺失部分', fetchCount, 2);
check('第二次请求只含新文本', calls[1].q, '@@0@@ Brand new text');

const r4 = await send({ type: 'ghzh:test' });
check('测试连接返回样例', r4.sample, '译：Hello, world! This is a translation test.');

const beforeClear = localStore.size;
const r5 = await send({ type: 'ghzh:clearCache' });
check('清空缓存条数', r5.removed, beforeClear);
check('缓存已清空', localStore.size, 0);

const r6 = await send({ type: 'ghzh:translate', texts: [] });
check('空数组直接返回', r6, { ok: true, results: [] });

console.log('后台服务测试 · GitHub 汉化');
console.log(`  网络请求次数：${fetchCount}`);
console.log('');
for (const line of log) console.log(line);
console.log('');
console.log(failed === 0 ? '全部通过' : `${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
