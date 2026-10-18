/**
 * 词典体检：node test/dict-lint.mjs
 * 检查点：
 *   1. RAW_DICT / RAW_PHRASES 能解析，条数正常
 *   2. 同一 key 两次出现且译文不同 → 冲突（必须修）
 *   3. 同一 key 重复但译文一致 → 冗余（提示）
 *   4. 译文里残留占位符（{x} / ${x}）或空值 → 无效词条
 *   5. 译文里没有中文 → 等于没翻译
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'src/dictionary.js');
const source = fs.readFileSync(file, 'utf8');

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const DICT = sandbox.window.__GHZH_DICT__;
const PHRASES = sandbox.window.__GHZH_PHRASES__;
const PATTERNS = sandbox.window.__GHZH_PATTERNS__;

/** 从源码里原样抓行，便于定位重复 */
function rawLines(name) {
  const start = source.indexOf(`const ${name} = \``);
  if (start < 0) return [];
  const bodyStart = source.indexOf('`', start) + 1;
  const bodyEnd = source.indexOf('`;', bodyStart);
  return source.slice(bodyStart, bodyEnd).split('\n');
}

function analyze(name) {
  const rows = [];
  rawLines(name).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const idx = t.indexOf('=');
    if (idx < 1) return;
    rows.push({ key: t.slice(0, idx).trim(), value: t.slice(idx + 1).trim(), line: i });
  });

  const first = new Map();
  const conflicts = [];
  const redundant = [];
  const badValue = [];
  const noChinese = [];

  for (const row of rows) {
    if (first.has(row.key)) {
      const prev = first.get(row.key);
      if (prev.value !== row.value) conflicts.push(`${row.key}：第 ${prev.line} 行「${prev.value}」 vs 第 ${row.line} 行「${row.value}」`);
      else redundant.push(`${row.key}×${(redundant.filter((r) => r.startsWith(row.key + '×')).length) + 1}`);
    } else {
      first.set(row.key, row);
    }
    if (!row.value || /\{[a-z]+\}|\$\{/.test(row.value)) badValue.push(`${row.line}: ${row.key}=${row.value}`);
    if (!/[\u4e00-\u9fff]/.test(row.value)) noChinese.push(`${row.line}: ${row.key}=${row.value}`);
  }

  return { count: rows.length, unique: first.size, conflicts, redundant, badValue, noChinese };
}

let failed = 0;
function section(title, data) {
  console.log(`\n【${title}】${data.count} 条 / 去重 ${data.unique} 条`);
  for (const [label, list] of [
    ['重复且译文冲突', data.conflicts],
    ['重复但译文一致', data.redundant],
    ['译文为空或含占位符', data.badValue],
    ['译文不含中文', data.noChinese],
  ]) {
    if (list.length) {
      const fatal = label === '译文为空或含占位符' || (label === '重复且译文冲突' && title !== 'PHRASES');
      if (fatal) failed += list.length;
      console.log(`  ${fatal ? '❌' : '⚠️ '} ${label}：${list.length}`);
      for (const item of list.slice(0, 12)) console.log(`      ${item}`);
    }
  }
}

console.log('词典体检 · GitHub 汉化');
section('DICT', analyze('RAW_DICT'));
section('PHRASES', analyze('RAW_PHRASES'));

// 规则可用性
const broken = [];
for (const [re, fn] of PATTERNS) {
  try {
    re.exec('probe');
  } catch (e) {
    broken.push(String(re));
  }
  if (typeof fn !== 'function') broken.push(`${re} 缺生成函数`);
}
console.log(`\n【PATTERNS】${PATTERNS.length} 条${broken.length ? ` · ❌ 异常 ${broken.join(', ')}` : ' · 全部可用'}`);
failed += broken.length;

console.log(`\n总计：DICT ${Object.keys(DICT).length} · PHRASES ${Object.keys(PHRASES).length} · PATTERNS ${PATTERNS.length}`);
console.log(failed === 0 ? '体检通过' : `体检未通过（${failed} 项致命问题）`);
process.exit(failed === 0 ? 0 : 1);
