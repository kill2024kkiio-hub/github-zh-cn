#!/usr/bin/env node
/**
 * 一键发布到 GitHub：node tools/publish.mjs [repo-name]
 * ---------------------------------------------------------------
 * 需要环境变量里的 PAT（不要写进文件、不要提交）：
 *   PowerShell:  $env:GITHUB_TOKEN = "ghp_xxx"; node tools/publish.mjs
 *   bash:        GITHUB_TOKEN=ghp_xxx node tools/publish.mjs
 *
 * 做的事：
 *   1. GET  /user              取登录名
 *   2. POST /user/repos        创建公开仓库（已存在则跳过）
 *   3. git remote add origin   （已存在则改 URL，始终不带令牌）
 *   4. git push               令牌只通过临时 http header 传入，不落盘
 *
 * 安全约束：
 *   - 令牌只从环境变量读取，脚本不写任何配置文件
 *   - 远程 URL 永远是 https://github.com/<login>/<repo>.git（不含 x-access-token）
 *   - 推送前会跑一次 tools/scan-secrets.mjs，发现可疑内容直接中止
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const repoName = process.argv[2] || pkg.name;
const description = pkg.description || 'GitHub 界面中文化浏览器扩展';

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: opts.stdio || ['ignore', 'pipe', 'pipe'], ...opts });
}

function bail(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

if (!token) {
  bail([
    '未找到令牌（GITHUB_TOKEN / GH_TOKEN 都为空）。',
    '',
    '两种做法，任选其一：',
    '',
    'A. 用 GitHub CLI（推荐，令牌由系统凭据管理器保存）：',
    '   winget install --id GitHub.cli -e',
    '   gh auth login          # 选 HTTPS → 浏览器登录',
    `   gh repo create ${repoName} --public --source . --remote origin --push \\`,
    `     --description "${description}"`,
    '',
    'B. 用 PAT（Scope 勾 repo，或 fine-grained 勾 Administration: Read and write）：',
    '   $env:GITHUB_TOKEN = "ghp_你的令牌"',
    `   node tools/publish.mjs ${repoName}`,
    '',
    '令牌只走环境变量，不会写入任何文件。',
  ].join('\n'));
}

// ── 0. 推送前先自检，别把本地信息带上去 ──────────────────
console.log('▶ 敏感信息自检…');
try {
  const out = sh(process.execPath, ['tools/scan-secrets.mjs'], { stdio: ['ignore', 'pipe', 'inherit'] });
  process.stdout.write(out);
} catch {
  bail('自检未通过，已中止推送。请先清理上面列出的内容。');
}

async function api(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'github-zh-cn-publisher',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

console.log('▶ 读取账号信息…');
const me = await api('https://api.github.com/user');
if (me.status === 401) bail('令牌无效或已过期（401）。');
if (me.status !== 200) bail(`读取账号失败：HTTP ${me.status} ${JSON.stringify(me.body).slice(0, 200)}`);
const login = me.body.login;
console.log(`  已登录：${login}`);

console.log(`▶ 创建仓库 ${login}/${repoName}…`);
const created = await api('https://api.github.com/user/repos', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: repoName,
    description,
    private: false,
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    auto_init: false,
  }),
});
if (created.status === 201) {
  console.log(`  已创建：${created.body.html_url}`);
} else if (created.status === 422) {
  console.log('  仓库已存在，继续推送。');
} else {
  bail(`创建仓库失败：HTTP ${created.status} ${JSON.stringify(created.body).slice(0, 300)}`);
}

const cleanUrl = `https://github.com/${login}/${repoName}.git`;
console.log('▶ 配置 remote…');
let hasRemote = false;
try {
  hasRemote = sh('git', ['remote', 'get-url', 'origin']).trim().length > 0;
} catch { hasRemote = false; }
if (hasRemote) sh('git', ['remote', 'set-url', 'origin', cleanUrl]);
else sh('git', ['remote', 'add', 'origin', cleanUrl]);
console.log(`  origin → ${cleanUrl}`);

console.log('▶ 推送 main…');
const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
try {
  sh('git', [
    '-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`,
    '-c', 'credential.helper=',
    'push', '--set-upstream', 'origin', 'main',
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
} catch {
  bail('推送失败。常见原因：令牌缺少 repo 权限、仓库名已被占用、或网络代理拦截。');
}

// 确认远程 URL 不含令牌
const finalUrl = sh('git', ['remote', 'get-url', 'origin']).trim();
if (finalUrl.includes('@') || finalUrl.includes('x-access-token')) {
  sh('git', ['remote', 'set-url', 'origin', cleanUrl]);
  console.log('  已修正 remote URL（去除凭据）');
}

console.log(`\n完成：${cleanUrl}`);
console.log('下一步：到仓库 Settings → Actions 确认 CI 通过；如需分支保护可开启 main 的 PR 校验。');
