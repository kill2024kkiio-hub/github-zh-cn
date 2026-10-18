/**
 * 覆盖率测试：node test/coverage.mjs
 * ---------------------------------------------------------------
 * 用一批「真实 GitHub 界面文案」抽样，量化两套策略的覆盖差距：
 *   A. 只做整段精确匹配（v1.0 的做法）
 *   B. 多级匹配：精确 → 去标点 → 模板 → 分隔符分段 → 短语片段
 *
 * 判定标准：结果含中文 = 已翻译；仍是纯英文 = 漏翻（会列为待补词条）。
 * 说明：机器兜底（机翻）需要网络，这里不计入，因此 B 的覆盖率是「离线可达上限」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dictSource = fs.readFileSync(path.join(root, 'src/dictionary.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(root, 'src/content.js'), 'utf8');

// ── 抽样文案（按 GitHub 各页面真实出现顺序整理）────────────
const SAMPLES = [
  // 顶栏 / 全局
  'Pull requests', 'Issues', 'Codespaces', 'Marketplace', 'Explore', 'Notifications',
  'New repository', 'Import repository', 'Your repositories', 'Your organizations',
  'Search or jump to...', 'Sign in', 'Sign up', 'Sign out', 'Settings', 'Dashboard',
  'Feature preview', 'Upgrade', 'Copied!', 'Copy to clipboard', 'Skip to content',
  // 仓库头部
  'Watch', 'Unwatch', 'Star', 'Unstar', 'Fork', 'Create fork', 'Sponsor', 'Edit Pins',
  'Go to file', 'Add file', 'Create new file', 'Upload files', 'Find file', 'Clone',
  'Download ZIP', 'Branch: main', 'Switch branches/tags', 'Branches', 'Tags',
  'No description, website, or topics provided.', 'Readme', 'License', 'Contributing',
  'Code of conduct', 'Security policy', 'About', 'Releases', 'Packages', 'Used by',
  'Contributors', 'Languages', 'Report repository', 'Public', 'Private', 'Archived',
  'Template', 'Pinned', 'Customize your pins', 'Popular repositories',
  // 文件页
  'Folders and files', 'Name', 'Last commit', 'Last commit message', 'Last commit date',
  'Message', 'Author', 'Date', 'Go to line', 'Edit this file', 'Delete this file',
  'View raw', 'This file has been truncated.', 'Show original', 'Empty file', 'binary file',
  'Filter files by name', 'Jump to file', 'Copy path', 'Copy permalink',
  // 提交 / 比较
  'Commits', 'Commit', 'Commit message', 'Commit summary', 'Commit description',
  'Browse the repository at this point in the history', 'View commit details',
  'Copy the full SHA', 'Commit changes', 'Commit directly to the main branch',
  'Create a new branch for this commit and start a pull request', 'Propose changes',
  'Drag files here to add them to your repository', 'Choose your files',
  'Comparing changes', 'base repository', 'head repository', 'Create pull request',
  "There isn't anything to compare.", 'This branch has no conflicts with the base branch',
  'Merging can be performed automatically.', 'This branch has conflicts that must be resolved',
  'Resolve conflicts', 'Files changed', 'Split', 'Unified', 'Show whitespace',
  // 议题 / PR
  'New issue', 'Submit new issue', 'Open', 'Closed', 'Open issues', 'Closed issues',
  'Close as completed', 'Close as not planned', 'Close with comment', 'Reopen',
  'Labels', 'Milestones', 'Assignees', 'Reviewers', 'Projects', 'Development',
  'No one assigned', 'No labels', 'No milestone', 'No projects', 'None yet',
  'No description provided', 'Type', 'Sort by', 'Newest', 'Oldest', 'Most commented',
  'Best match', 'Most reactions', 'Recently updated', 'Filter by label',
  'Filter by assignee', 'Filter by milestone', 'Filter by author', 'Advanced search',
  'No results matched your search.', 'Welcome to issues!',
  "Issues are used to track todos, bugs, feature requests, and more.",
  'Ready to get started?', 'Create your first issue',
  'Write', 'Preview', 'Add a description', 'Leave a comment', 'Comment',
  'Attach files by dragging & dropping, selecting or pasting them.',
  'Styling with Markdown is supported', 'Nothing to preview',
  'Remember, contributions to this repository should follow its contributing guidelines.',
  'Draft', 'Merged', 'Approved', 'Changes requested', 'Review required', 'Auto-merge enabled',
  'Approve', 'Request changes', 'Merge pull request', 'Squash and merge', 'Rebase and merge',
  'Confirm merge', 'Delete branch', 'Restore branch', 'Update branch', 'Quote reply',
  'Reference in new issue', 'Copy link', 'Edit comment', 'Delete comment',
  'Resolve conversation', 'Unresolve conversation', 'Lock conversation', 'Subscribe',
  'Mark as read', 'Mark all as read',
  // Actions
  'Actions', 'Workflows', 'All workflows', 'Workflow runs', 'Re-run all jobs',
  'Re-run failed jobs', 'Cancel workflow', 'Disable workflow', 'Enable workflow',
  'Summary', 'Artifacts', 'Jobs', 'Steps', 'Logs', 'Annotations', 'Duration',
  'Triggered via', 'Status', 'Event', 'Actor', 'Started', 'Completed at', 'Attempt',
  'Usage', 'Billable time', 'Run workflow', 'Workflow file',
  // 设置
  'Public profile', 'Account', 'Appearance', 'Accessibility', 'Notifications',
  'Billing and plans', 'Emails', 'Password and authentication', 'Sessions',
  'SSH and GPG keys', 'Organizations', 'Repositories', 'Applications',
  'Scheduled reminders', 'Security log', 'Developer settings', 'Danger zone',
  'Delete account', 'Change username', 'Export account data',
  'Two-factor authentication', 'Personal access tokens', 'Saved replies',
  'Repository name', 'Default branch name', 'Visibility', 'Save changes',
  'Delete this repository', 'Transfer ownership', 'Change default branch',
  // 通知 / 搜索 / 个人主页
  'All', 'Unread', 'Participating', 'Mentions', 'Saved', 'Inbox',
  'Filter notifications', "You're all caught up!", 'Mark as done',
  'Overview', 'Stars', 'Sponsoring', 'Followers', 'Following', 'Contributions',
  'Contribution activity', 'Achievements', 'Edit profile',
  'Repositories', 'Users', 'Topics', 'Teams', 'Wikis', 'Search results',
  // 登录/注册
  'Sign in to GitHub', 'Username or email address', 'Password', 'Forgot password?',
  'Sign in with a passkey', 'Create an account', 'Email', 'Confirm password',
  'Already have an account?', 'Terms of Service', 'Privacy Statement',
  // 动态文本
  '12 commits', '1,234 Commits', '3 branches', '2.4k stars', '5 files changed',
  '2 days ago', 'an hour ago', 'last week', '7 open', '18 closed',
  '3/4 checks passed', 'All checks have passed', 'Some checks were not successful',
  'alice wants to merge 3 commits into main from feat/x',
  'Add more commits by pushing to the dev branch on alice/repo.',
  'This branch is 2 commits ahead of main.', 'Showing 1-25 of 312',
  'Updated 3 days ago', 'Joined Jan 5, 2020',
  // Shadow DOM 里的文本（relative-time / tool-tip / clipboard-copy）
  'last month', 'yesterday', 'in 3 days', 'Copy', 'Copied to clipboard',
  'Copy code to clipboard', 'Open in new tab',
  // select / option / 提示语
  'Sort: Newest', 'Filter: Open', 'Language: TypeScript', 'Open in browser',
  // 句子级（词典整句收录的部分）
  'Something went wrong.', 'There was an error while loading.',
  "You don't have access to this page.", 'You must be signed in to do that.',
  'Please sign in to continue.', 'Page not found',
  'This repository has been archived by the owner', 'It is now read-only.',
  'Successfully merging a pull request may close this issue.',
  'Having trouble? Contact support.', 'Learn more about GitHub Sponsors',
];

// ── 加载引擎 ───────────────────────────────────────────
const virtualConsole = new VirtualConsole();
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://github.com/foo/bar', runScripts: 'dangerously', virtualConsole,
});
const { window } = dom;
window.chrome = {
  runtime: { id: 'test', lastError: undefined, onMessage: { addListener() {} }, sendMessage(_p, cb) { setTimeout(() => cb({ ok: true, results: [] }), 0); } },
  storage: { sync: { get(_k, cb) { cb({ settings: { enabled: false } }); }, set() {} }, onChanged: { addListener() {} } },
};
window.eval(dictSource);
window.eval(contentSource);
window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
await new Promise((r) => setTimeout(r, 200));

const translate = window.__GHZH_TRANSLATE__;
const DICT = window.__GHZH_DICT__;

const hasChinese = (s) => /[\u4e00-\u9fff]/.test(s);
const exactOnly = (s) => (Object.prototype.hasOwnProperty.call(DICT, s) ? DICT[s] : null);

let exactHit = 0;
let fullHit = 0;
const misses = [];

for (const sample of SAMPLES) {
  const a = exactOnly(sample);
  if (a && hasChinese(a)) exactHit++;
  const b = translate(sample);
  if (b && hasChinese(b)) fullHit++;
  else misses.push(sample);
}

const total = SAMPLES.length;
const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;

console.log('覆盖率测试 · GitHub 汉化');
console.log(`  样本量：${total} 条真实界面文案`);
console.log('');
console.log(`  A 整段精确匹配（v1.0）：${exactHit}/${total}  ${pct(exactHit)}`);
console.log(`  B 多级匹配（v1.1 离线）：${fullHit}/${total}  ${pct(fullHit)}`);
console.log(`  提升：+${((fullHit - exactHit) / total * 100).toFixed(1)} 个百分点`);
console.log('');
if (misses.length) {
  console.log(`未覆盖（${misses.length} 条，需补词条或靠机翻兜底）：`);
  for (const m of misses) console.log(`  · ${m}`);
} else {
  console.log('离线词典已覆盖全部样本。');
}

// 门槛：多级匹配至少覆盖 80%，且必须显著优于精确匹配
const ok = fullHit / total >= 0.8 && fullHit > exactHit;
console.log('');
console.log(ok ? '覆盖率达标（≥80% 且优于精确匹配）' : '覆盖率未达标');
process.exit(ok ? 0 : 1);
