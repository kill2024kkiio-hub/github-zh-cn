/**
 * 提交前敏感信息自检：node tools/scan-secrets.mjs
 * ---------------------------------------------------------------
 * 只扫「会被 git 提交的文本文件」（跳过 node_modules / .git / 二进制），检查：
 *   1. 本地绝对路径（Windows 盘符、Unix 家目录、用户名）
 *   2. 疑似令牌与私钥（GitHub PAT、OpenAI/DeepSeek key、AWS、SSH/PEM 私钥）
 *   3. 邮箱地址（避免把个人身份写进仓库）
 *   4. 不该入库的敏感文件名（.env / *.pem / *.key / secrets.json …）
 *   5. 敏感文件是否已被 git 跟踪
 *
 * 发现任何一条即退出码 1，CI 与本地 pre-commit 都可用它兜底。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'tmp', '.tmp', '.vscode', '.idea']);
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.json', '.md', '.html', '.css', '.yml', '.yaml',
  '.txt', '.svg', '.sh', '.ps1', '.gitignore', '.gitattributes', '',
]);
const MAX_BYTES = 512 * 1024;

const SENSITIVE_NAMES = [
  /^\.env(\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^secrets\.json$/i,
  /^settings\.local\.json$/i,
  /^id_(rsa|ed25519|ecdsa)$/i,
];

const RULES = [
  {
    id: '本地绝对路径',
    re: /\b[A-Za-z]:\\(?:Users|Documents|Desktop|AppData)\\[^\s"'`)]+|\/(?:home|Users)\/[A-Za-z0-9._-]+\//g,
    why: '会把本机目录结构暴露到公开仓库',
  },
  {
    id: '疑似 GitHub 令牌',
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    why: 'PAT 泄露等于交出账号',
  },
  {
    id: '疑似模型服务 Key',
    re: /\bsk-[A-Za-z0-9_-]{16,}\b|\bsk-proj-[A-Za-z0-9_-]{16,}\b/g,
    why: '第三方 API Key 泄露会被盗刷',
  },
  {
    id: '疑似 AWS Key',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    why: '云凭据泄露',
  },
  {
    id: '私钥块',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    why: '私钥绝不能进仓库',
  },
  {
    id: '硬编码密码/令牌赋值',
    re: /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["'][^"'\s]{8,}["']/gi,
    why: '看起来是真实凭据而不是占位符',
  },
  {
    id: '邮箱地址',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    why: '避免把个人联系方式写进公开仓库',
  },
];

/** 白名单：文档里必须出现的示例值与占位符 */
const ALLOW = [
  /@users\.noreply\.github\.com$/i,        // GitHub 官方 noreply 身份
  /你的|xxx+|placeholder|example|demo|test/i, // 文档占位符
  /@example\.(com|org)$/i,
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

const findings = [];
function report(file, line, rule, hit) {
  findings.push({ file: path.relative(root, file), line, rule, hit });
}

// ── 1. 敏感文件名 ───────────────────────────────────────
const files = walk(root);
for (const file of files) {
  const base = path.basename(file);
  if (SENSITIVE_NAMES.some((re) => re.test(base))) report(file, 0, '敏感文件名', base);
}

// ── 2. 内容扫描 ─────────────────────────────────────────
for (const file of files) {
  const ext = path.extname(file).toLowerCase();
  if (!TEXT_EXT.has(ext)) continue;
  const stat = fs.statSync(file);
  if (stat.size > MAX_BYTES) continue;
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch { continue; }
  if (content.includes('\u0000')) continue;   // 跳过二进制

  const lines = content.split(/\r?\n/);
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.length > 2000) continue;
      rule.re.lastIndex = 0;
      const m = rule.re.exec(line);
      if (!m) continue;
      const hit = m[0];
      if (ALLOW.some((re) => re.test(hit))) continue;
      // 词典/测试里出现的普通英文短语不算硬编码凭据
      if (rule.id === '硬编码密码/令牌赋值' && /["'](?:xxx|your|placeholder|example|test)/i.test(line)) continue;
      report(file, i + 1, rule.id, hit);
    }
  }
}

// ── 3. git 是否已跟踪敏感文件 ───────────────────────────
let tracked = [];
try {
  tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
} catch {
  tracked = [];
}
for (const file of tracked) {
  const base = path.basename(file);
  if (SENSITIVE_NAMES.some((re) => re.test(base))) report(path.join(root, file), 0, '已被 git 跟踪', file);
  if (file.startsWith('node_modules/')) report(path.join(root, file), 0, 'node_modules 被跟踪', file);
}

// ── 输出 ────────────────────────────────────────────────
console.log('敏感信息自检 · GitHub 汉化');
console.log(`  扫描文件：${files.length} 个（跳过 node_modules/.git/二进制）`);
console.log(`  git 跟踪：${tracked.length} 个文件`);

if (!findings.length) {
  console.log('\n未发现本地路径、令牌、私钥或个人信息。可以安全提交。');
  process.exit(0);
}

console.log(`\n发现 ${findings.length} 处可疑内容：`);
for (const f of findings.slice(0, 50)) {
  const where = f.line ? `${f.file}:${f.line}` : f.file;
  console.log(`  ❌ [${f.rule}] ${where}  →  ${f.hit}`);
}
if (findings.length > 50) console.log(`  … 其余 ${findings.length - 50} 条省略`);
console.log('\n请先清理或确认后再提交。');
process.exit(1);
