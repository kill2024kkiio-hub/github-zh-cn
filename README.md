# GitHub 汉化 · 中文化翻译扩展 v1.1

把 GitHub 网页界面翻译成简体中文的浏览器扩展（Manifest V3，Chrome / Edge / Brave 通用）。

## v1.0 为什么「翻译不全」，v1.1 改了什么

上一版的问题是硬伤，不是词库少几行：

| 问题 | 后果 | v1.1 的做法 |
| --- | --- | --- |
| `TreeWalker` 用 `FILTER_REJECT` 剪掉整个 `<select>` | 所有下拉选项（排序、筛选、语言）全英文 | 放行 `select/option`，翻译选项文本，同时**固定住 option 的 value**，不污染请求参数 |
| 完全不看 Shadow DOM | `relative-time`、`tool-tip`、`clipboard-copy` 这些 GitHub 自定义组件里的文本（相对时间、悬停提示）全是英文 | 遍历时收集 `shadowRoot` 并递归翻译；自定义元素升级后延迟 300ms 复查；另有 2.5s 兜底扫描 |
| 元素过滤用 `FILTER_SKIP` | 元素本身不返回，根本发现不了 shadowRoot（隐蔽 bug） | 元素改为 `FILTER_ACCEPT` |
| 只做整段精确匹配 | 词典没收录的**句子**永远英文（GitHub 大量文案是句子） | 六级匹配：精确 → 去尾标点 → 模板规则 → 分隔符分段 → 冒号/问句递归拆解 → 短语片段兜底 |
| `<svg><title>` 被整个剪掉 | 图标 tooltip（如「复制到剪贴板」）英文 | 放行 `svg > title/desc` |
| `all_frames: false` | iframe 内不翻 | 改为 `true` |
| 词库 543 条 | 覆盖窄 | **1124 条整段词条 + 234 条短语 + 88 条动态规则** |
| 没有兜底 | 未收录即放弃 | 可选「机翻兜底」：未收录的界面短文案送翻译服务补全（默认开，本地缓存） |

### 覆盖率实测（`npm run test:coverage`）

315 条按 GitHub 各页面真实文案整理的抽样：

```
A 整段精确匹配（v1.0）：284/315  90.2%
B 多级匹配（v1.1 离线）：315/315  100.0%
```

注意口径：这 315 条是「界面固定文案 + 动态模板 + 组件内文本」的样本，离线词典能全中；**README/Issue 正文这类自然语言不在此列**，靠翻译服务，词典再大也翻不了。

## v1.2 性能：为什么之前「加载慢」

上一版有三个真问题，不是玄学：

| 问题 | 后果 | 现在 |
| --- | --- | --- |
| 每次文本变动（相对时间每秒跳、hovercard）都把**父容器整棵子树重新遍历** | 越用越卡，长页面尤其明显 | `characterData` 只处理那一个文本节点 |
| 属性扫描 = `querySelectorAll('*')` × 7 次 `getAttribute` + `closest` | 全页上万次调用，首屏明显卡顿 | 按属性名用原生选择器筛（只碰真有值的元素），叶子节点直接 `hasAttribute` |
| 整页一次同步遍历 | 主线程长任务，滚动/输入掉帧 | 按子树切块，单块预算 8ms，超了排下一帧 |
| 正文队列：批 30、固定等 260ms、每批后再等 400ms、串行 | 长 README 一段段慢慢冒出来 | 批 64、攒够 12 条立刻发、并发 2、批间无固定等待、首屏预取 16 块、预加载 1200px |
| 分片用「暂停/恢复 TreeWalker」 | 实测漏节点（2500 里漏 11 个），且超时会饿死属性/正文调度 | 改成按子树排队，不暂停 walker；属性与正文调度在每个 root 首次处理时执行 |

### 压测数据（`npm run test:perf`，2500 个 UI 文本 + 300 段正文，jsdom）

```
首屏单次遍历：5.6 ms（预算 8ms，切 2503 块）   ← 拆块前单次 125.9 ms
全页处理总耗时：1630 ms（含 17 批 × 15ms 模拟网络往返）
UI 文本：2500/2500 已翻译
正文段落：300/300 已翻译
平均批量：28.5 条/批（没有一条一请求）
```

jsdom 没有布局、比真 Chrome 慢；真机上单块通常 1-3ms，滚动时基本无感。

## 安装

1. `chrome://extensions/`（Edge 为 `edge://extensions/`）→ 打开**开发者模式**
2. **加载已解压的扩展程序** → 选择本目录 `github-zh-cn/`
3. 打开任意 GitHub 页面

改代码后回扩展页点「重新加载」，再刷新 GitHub 标签页。

> 也可以 `git clone` 后直接加载仓库目录；`node_modules/` 只用于跑测试，运行扩展不需要它。

## 权限与隐私

| 权限 | 用途 |
| --- | --- |
| `storage` / `unlimitedStorage` | 保存开关、服务配置、自定义词条、翻译缓存 |
| `https://github.com/*`、`https://gist.github.com/*` | 只在 GitHub 页面注入翻译脚本 |
| 翻译服务域名 | 正文翻译 / 机翻兜底时调用 |
| `https://*/*` | 允许填写自建 OpenAI 兼容接口（含本地服务） |

- 界面汉化**完全离线**，零网络请求
- 正文翻译与机翻兜底可关闭；开启后只发送**该段纯文本**给你选择的服务，不发送 cookie / token / 页面结构
- 缓存只存在浏览器本地，设置页可一键清空
- 项目无服务器、无统计上报、无远程脚本

细节见 [SECURITY.md](SECURITY.md)。

## 使用

- 工具栏面板：总开关、翻译范围（仅界面 / 界面 + 正文）、**机翻兜底**开关、统计、重新翻译、还原英文
- 快捷键 **Alt + Shift + T** 切换开关
- 设置页可开右下角「中 / EN」悬浮按钮

### 两种翻译通道

| 通道 | 覆盖 | 依赖 |
| --- | --- | --- |
| 内置词典（1124 词条 + 234 短语 + 88 规则） | 菜单、按钮、状态、表头、设置页、空态、错误句、相对时间、下拉选项、tooltip | 无，完全离线 |
| 机翻（可关） | 词典没收录的界面短文案 | 翻译服务（默认免密钥 Google）；结果本地缓存 |
| 正文翻译（可关） | README、Issue/PR/Discussion 正文、评论 | 同上，按可视区域懒加载 |

## 翻译服务

默认走免密钥的 `translate.googleapis.com`，开箱可用。设置页可换成：

| 服务 | 需要配置 |
| --- | --- |
| Google | 无 |
| DeepL | API Key、是否专业版（免费版以 `:fx` 结尾） |
| Microsoft Translator | 订阅 Key、区域 |
| OpenAI 兼容 | 接口地址、Key、模型（OpenAI / DeepSeek / 本地 vLLM 都行） |

设置页有「测试连接」，直接验证 Key 是否可用。

## 自定义词条

**设置 → 自定义词条**，每行 `English=中文`，覆盖内置词条：

```
Merge pull request=合并拉取请求
Sponsor=赞助我
Projects=项目管理
```

想扩公共词典，直接改 `src/dictionary.js`：文件是行式格式，一行一条，`#` 开头为注释；加完跑 `npm run test:dict` 会告诉你有没有重复/冲突/漏翻。

## 目录结构

```
github-zh-cn/
├── manifest.json              # MV3 清单（all_frames: true）
├── icons/                     # 图标（tools/make-icons.mjs 生成）
├── src/
│   ├── dictionary.js          # DICT 1124 + PHRASES 234 + PATTERNS 88（行式格式）
│   ├── content.js             # 翻译引擎：Shadow DOM / 六级匹配 / 队列 / 还原
│   ├── background.js          # 翻译服务 + 哈希缓存（Service Worker）
│   ├── styles.css             # 中文字体 / 悬浮按钮
│   ├── popup.*                # 工具栏面板
│   └── options.*              # 设置页
├── test/                      # 4 套测试（体检 / 覆盖率 / DOM / 后台）
└── tools/make-icons.mjs       # 图标生成
```

## 引擎细节

**匹配管线**（`translateText`）

1. 整段精确命中（含大小写、首字母大写变体）
2. 去掉尾部 `. : ! ?` 再命中，命中后补中文标点
3. 动态模板：`12 commits`、`2 days ago`、`3/4 checks passed`、`Showing 1-25 of 312`、`alice wants to merge 3 commits into main from feat/x`
4. 递归模板：`Sort: Newest` → `排序：最新`、`Learn more about X`、`Having trouble? Contact support.`
5. 分隔符分段：`Pull requests · Issues` 各段都命中才拼接
6. 短语兜底：按长度优先替换已知短语，**残留英文词超过 2 个就放弃**，避免半中半英的怪句子

**安全边界**

- 只改文本节点的字符串值和 `placeholder/title/aria-label/alt/data-tooltip/label` 属性，不做 `innerHTML` 替换，不碰 React 节点结构
- `<pre> <code> <textarea> <input> .blob-code .cm-editor .monaco-editor` 永不翻译；代码、diff、输入框内容保持原样
- `<option>` 翻译前先把原文本写进 `value` 属性，还原时移除，保证表单参数不被中文污染
- 还原时先停观察器再改文本，避免「还原 → 立刻又被翻译」的抖动

**性能**

- MutationObserver 100ms 去抖，turbo/pjax 导航钩子重新扫描
- 正文用 IntersectionObserver 只在进入视口 ±400px 时翻译
- 译者队列每批 30 条、服务端并发 3、结果按 `provider|目标语言|原文` 哈希缓存（`chrome.storage.local`）
- 服务连续失败 2 次后本页停止机翻兜底，但正文继续尝试，错误显示在面板底部

## 测试

```bash
npm install        # 只为测试装 jsdom
npm test          # 5 套：词典体检 + 覆盖率 + DOM + 后台 + 性能
npm run scan      # 提交前敏感信息自检（本地路径 / 令牌 / 私钥 / 邮箱）
```

| 测试 | 校验内容 |
| --- | --- |
| `test/dict-lint.mjs` | 词条格式、重复/冲突检测、空值/占位符、无中文告警、规则可编译 |
| `test/coverage.mjs` | 315 条真实文案的覆盖率，对比「精确匹配 vs 多级匹配」并给出漏翻清单 |
| `test/dom-test.mjs` | jsdom 跑真实 `content.js`：界面/动态规则/自定义词条、代码块保护、`select`+`option` 值保全、`svg title`、**Shadow DOM**、后挂载 shadow、正文、机翻兜底、动态节点、**还原与再翻译** |
| `test/background-test.mjs` | 假 `chrome.*` + 假 `fetch` 跑 `background.js`：`@@序号@@` 批量还原顺序、缓存命中不发请求、混合命中、测试连接、清缓存 |
| `test/perf.mjs` | 长页面压测：首屏单次遍历受时间预算约束、切块后续跑不丢节点、总完成时间、批量大小（防退回「一条一请求」） |

## 已知边界（诚实说明）

1. **自然语言翻不了就翻不了**：词典是查表，README 正文只有翻译服务能处理；机翻兜底能让界面接近全中文，但对长句效果取决于服务。
2. **GitHub 改文案就会漏**：词典按精确匹配，官方改一个词就掉一条。`coverage` 测试与面板统计能快速定位，设置页也能临时补词条。
3. **自定义元素名可能变**：Shadow DOM 处理是通用的（遍历所有 `shadowRoot`），不依赖具体组件名，但仍受限于 open shadow root；closed shadow root 无法访问。
4. **机翻兜底会把未收录文本发给你配置的服务**：其中可能包括议题标题等用户内容。介意就在面板里关掉它，只保留离线词典 + 手动开启正文翻译。
5. 我这边网络出不去 `translate.googleapis.com`，所以**真实链路**（DT=t 解析、限流、批量）是用假 fetch 验证的；首次实跑若报错，面板会显示 `HTTP xxx`，换服务或挂代理即可。

## 许可

MIT

## 二次开发与发布

```bash
npm install       # 只为测试装 jsdom（运行扩展不需要）
npm test          # 5 套测试
npm run scan      # 敏感信息自检：本地路径 / 令牌 / 私钥 / 邮箱
```

提交前自动自检（钩子已随仓库提供，克隆后启用一次即可）：

```bash
git config core.hooksPath .githooks
```

之后每次 `git commit` 都会先跑 `tools/scan-secrets.mjs`，命中本地路径、令牌、私钥或邮箱时直接阻止提交（误报可用 `--no-verify` 跳过）。

发布到自己的 GitHub（令牌只从环境变量读取，不写入任何文件）：

```bash
# 方式 A：GitHub CLI（令牌由系统凭据管理器保存）
gh auth login
gh repo create github-zh-cn --public --source . --remote origin --push

# 方式 B：PAT（Scope 勾 repo）
$env:GITHUB_TOKEN = "ghp_你的令牌"
node tools/publish.mjs
```

`tools/publish.mjs` 会先跑敏感信息自检，通过后才建仓库、配置 remote、推送；remote URL 始终是干净地址，令牌只通过临时 http header 传入。

> 首次提交使用了中性占位身份（`github-zh-cn <github-zh-cn@users.noreply.github.com>`），避免把本机个人信息写进历史。想换成自己的：
>
> ```bash
> git config user.name "你的名字"
> git config user.email "你的邮箱"
> git commit --amend --reset-author --no-edit
> ```
