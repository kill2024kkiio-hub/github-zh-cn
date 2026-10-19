# GitHub Actions 使用规范

> 本文件说明本项目如何在 GitHub Actions 的服务限制与官方条款范围内使用 CI，不是法律意见。
> 引用均来自下方链接的官方页面，条款原文以官网为准。

## 一、Actions 的硬性禁止项

来源：[GitHub Terms for Additional Products and Features — Actions](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features)

> Actions and any elements of the Actions product or service may not be used in violation of the Agreement,
> the GitHub Acceptable Use Policies, or the GitHub Actions service limitations set forth in the Actions documentation.
> Additionally, **regardless of whether an Action is using self-hosted runners**, Actions should not be used for:

| 禁止项 | 原文关键词 | 本项目的做法 |
| --- | --- | --- |
| 加密货币挖矿 | Cryptomining | 不涉及 |
| 破坏或未授权访问任何服务 / 设备 / 数据 / 账号 / 网络 | unauthorized access | 不涉及 |
| 把 Actions 当作独立或集成的产品/服务对外提供（商业用途） | provision of a stand-alone or integrated application or service offering the Actions product | 不对外提供 CI 能力 |
| 给服务器造成与用户收益不成比例的负担 | disproportionate burden（例：把 Actions 当 CDN 或 serverless 后端） | 不做大规模构建/下载/分发 |
| **在 GitHub 托管 runner 上做与该仓库软件项目的生产、测试、部署、发布无关的事** | unrelated to the production, testing, deployment, or publication of the software project | **CI 只跑测试与校验，属于 testing** |

## 二、服务限制

来源：[Actions limits](https://docs.github.com/en/actions/reference/limits)

| 限制项 | 阈值 |
| --- | --- |
| 单个 job 执行时长 | **6 小时**，超时被终止并失败 |
| 单次 workflow run 时长 | **35 天**，超时取消 |
| Job Matrix 规模 | **256 jobs / workflow run** |
| 环境审批等待 | 30 天 |
| 单次运行重跑次数 | 50 次 |
| 并发 job（Free / Pro / Team） | **20 / 40 / 60** |
| REST API（认证用户） | 5000 请求/小时 |

来源：[Usage limits and policy](https://docs.github.com/en/actions/reference/usage-limits-billing-and-administration)

- 公开仓库使用标准 GitHub 托管 runner **免费**；私有仓库按套餐给免费分钟数与存储，超出计费
- 除了用量限制，**必须在 GitHub Terms of Service 范围内使用 Actions**

## 三、本项目的 CI 约束

`.github/workflows/ci.yml` 的实际配置：

- 只做一件事：`npm ci` + 5 套本地测试 + 敏感信息自检 + manifest 校验 —— 全部属于 "testing"
- 不下载/分发大文件，不做 CDN、不做 serverless、不做定时任务、不发外部业务请求
- `permissions: contents: read`（最小权限，不写仓库）
- `concurrency`：同一分支只保留最新一次运行，自动取消排队中的旧运行
- `timeout-minutes: 15`：远低于 6 小时上限，避免挂死占用 runner
- 不使用 self-hosted runner；不接入第三方 Action（只用 `actions/checkout`、`actions/setup-node`）
- 不使用 `schedule` 触发，不把 CI 用于发布制品到外部服务

## 四、提交与协作约定

1. CI 只跑测试与校验，不承载其他用途
2. 提交前本地跑 `npm test` 与 `npm run scan`，通过后再推
3. 一次提交解决一件事，避免零碎反复推送
4. CI 结果在 Actions 页面查看，不使用轮询脚本反复查询
5. 新增第三方 Action 需要说明必要性，优先使用官方 Action
6. 保持 `permissions` 为最小集合，除非确有需要不扩大
7. 资源使用与项目规模匹配，不为小项目申请超额并发或超长超时

## 五、变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-19 | 建立本规范；CI 增加 `concurrency` 与 `timeout-minutes`；测试矩阵为 Node 22/24 |
