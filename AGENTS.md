# 日程清单

个人用的任务与打卡应用：React 前端 + 自写 Node 后端 + SQLite，前端离线可用、登录后多设备同步。
**视图**：日 / 3日 / 周 / 月，外加列表页、项目泳道看板。

**改代码前先读 [docs/踩坑.md](docs/踩坑.md)；改 UI 前先读 [docs/界面规则.md](docs/界面规则.md)。** 本文「**踩坑 N**」= 编号 N 的那一条，**编号稳定，别改。**

| 文件 | 内容 |
|---|---|
| `AGENTS.md` | 本文：结构、不变量、工作约束 |
| [docs/业务模型.md](docs/业务模型.md) | 字段表、重复规则、逾期、冲突提示 |
| [docs/界面规则.md](docs/界面规则.md) | **改 UI 前必读**：交互语言、令牌五条、时间与卡片、无障碍、文案 |
| [docs/AI.md](docs/AI.md) | AI 助手：读写路径、提案闸门、接口、配置 |
| [docs/接口.md](docs/接口.md) | HTTP 总览 + 认证（另有 `-日程集` / `-同步` 两册） |
| [docs/界面约定.md](docs/界面约定.md) | 配色与令牌、变量名（另有 `-无障碍` / `-布局` / `-快速添加` 三册） |
| [docs/踩坑.md](docs/踩坑.md) | 54 条坑的索引 |
| [docs/测试.md](docs/测试.md) | 怎么验、每条约定锁在探针哪一节 |
| [docs/架构决策.md](docs/架构决策.md) | 为什么是现在这样 |
| [docs/组件库.md](docs/组件库.md) | 基础组件 API |
| [docs/工作区保护.md](docs/工作区保护.md) | 多端 / 多会话的 git 铁律 |
| [DEPLOY.md](DEPLOY.md) | 拓扑、发布、nginx、排障 |
| [README.md](README.md) | 网址、怎么用、日常命令 |

---

## 一、结构与状态

```text
app/src/App.tsx   启动 / 登录分流，不碰业务状态
app/src/app/      Workbench 组装 + 兄弟模块（点击委托、拖拽、浮层、快捷键）
app/src/domain/   纯逻辑，零 React / DOM / 网络
app/src/data/     localStorage + 接口封装 + 旧数据导入
app/src/sync/     同步引擎：outbox 推送 + 游标拉取
app/src/ui/       侧栏 / 顶栏 / 抽屉 / 拖拽 / 日程集 / 设置 / AI 面板
app/src/views/    纯展示，零回调，只出 data-*
app/src/styles/   语义样式模块 + tailwind.css
server/           server.js 路由 + lib/{db,auth,sync,calendars,invites,ratelimit} + lib/ai/
deploy/           发布脚本 + nginx conf / systemd 单元
```

三层状态：领域模型（`state.tasks` / `state.habits`，按 id 索引的对象）→ localStorage
`schedule-app-v4`（离线副本）→ SQLite（**权威**）。排查数据问题**先看服务器**。

**点击在 `#content` 上委托**（`app/clickDispatch.ts` 是唯一的 `onClick`，靠 `data-*` 分派）：
行由 React 渲染、拖拽与同步会换掉它们，挂行上的 handler 会丢。`views/` 因此**零回调**。
分派顺序 `[data-act]` → `[data-jump]`/`[data-nav]` → `.task-el` → `[data-zone-id]`
（第四步必须在第三步之后：`.month-cell` 带 `data-no-draft`）。

**跨集口径**由 Workbench 传哪份 state 决定：今天 / 逾期 / 待办箱 / 垃圾箱 / AI 看**全量**；
日程 / 打卡 / 已完成 / 项目看**选中集**（`scoped`）。侧栏徽标与顶栏一律全量口径。
`ui.cals`（同时看哪几个）与 `ui.cal`（新建落哪儿）是两件事，至少永远有一个集勾着。

## 二、不变量

> 推导、字段表、失败症状 → [docs/业务模型.md](docs/业务模型.md)。这里只留「不许破」。

**数据结构**

1. `tasks` / `habits` 是**按 id 索引的对象**，不是数组。
2. `calId` 是主键的一部分，不是可同步字段 → **挪集 = 目标集新建 + 源集留墓碑**。
3. **删除是墓碑**：`deleted` 让别的设备知道要删，`purged` 才到处看不见。
4. **三态独立**：未定时（`time===null`）· 未定日期（`date===null`）· 已完成仍占日程位置。
5. **待办箱 = `date === null` 的未完成任务**。
6. **任务与打卡独立**，`habits.log` 是按日期的稀疏映射。

不做长篇幅记录：备忘录 / 清单 / 笔记本已整体删除，迁移是**丢掉不是归档**，别再加回来。

**权限**：没有管理员，所有人平等，开放注册，共享单位是集不是任务。
`owner` 可改任务与集，`editor` 只可改任务，`viewer` 只读。
判断只有 `canWrite(role)` / `canManage(role)`（`domain/types.ts`）与服务端 `db.roleOf()` /
`calendars.canWrite()`；**别在别处写 `role === 'owner'`**。
三条：① 每人至少一个集；② 每集至少一个 owner；③ 权限在写入通道把关
（`store.commitMany()` 与 `sync.applyOps()`），不是靠界面藏按钮。邀请两段式。

**同步**：`changes.seq` 全局单调，客户端只有一个 `cursor`，服务端按 `cal_id IN (我的集)` 过滤。
新加入一个集的历史变更全在游标后面 → 客户端见不认识的 `calId` 就再要一次全量快照。
`POST /api/sync` 一次推 + 拉，服务端先落盘再取数。集 / 成员 / 邀请走普通 REST，不走 LWW。
**LWW 逐字段**；同字段两边都改过时抽屉里多一条只读提示，提示不改数据。

**AI**：AI 助手没有自己的读写接口，确认后的改动和手机、电脑的改动走**同一个** `sync.applyOps()`
（op 里 `deviceId` 写死 `'ai'`），所以权限判断、逐字段 LWW、客户端拉取全部自动沿用。
写路径三段：**工具 → 提案 → 确认** —— 写工具只造提案不落库，`POST /api/ai/confirm` 是唯一落库处
且只信 id 不信参数。细节见 [docs/AI.md](docs/AI.md)。

**重复 / 逾期**：
- 防死循环判据是「必须往前走」：`while (next && next < today && next > cursor)`，别换回魔法数字。
- 实例 id 派生：`` `${根}#${发生日}` `` —— 两台设备离线推进会派生出同一个 id，同步时合并。
- 逾期唯一口径：`!done && date && date < today`；`counts().today` 不含逾期。

## 三、界面硬规则

> **全文 → [docs/界面规则.md](docs/界面规则.md)。** 改任何 UI 之前先读那一份，
> 这里不再复述（两份写同一件事必然漂移）。

一句话版：令牌不给兜底值 · 时间行与把手只由时长决定 · 装不下只许压 · 跨集口径由传哪份 state 决定 ·
只读成员点了要说明原因 · 浮层四件事 · 动效全站关。

## 四、最容易翻车的九条

| 坑 | 一句话 |
|---|---|
| SW 打架 | 拆旧 SW 用 localStorage 标记锁成一次性，删缓存只认 `/^schedule-v\d+$/`（[踩坑 1](docs/踩坑.md)） |
| 拖拽排序 | 「让位洞」不用插入线；位置取 dragstart 量的 `rawLayout`（[踩坑 6](docs/踩坑-前端-交互.md)） |
| 拖拽传感器 | 鼠标 `distance: 8`、触摸 `delay: 300 + tolerance: 8`；拖出容器用分身，别切 `overflow: visible`（[51/54](docs/踩坑-前端-组件.md)） |
| 探针表达式 | `waitFor` 只吃表达式、`evalJs` 要自己 `return …;`（[踩坑 29](docs/踩坑-环境.md)） |
| 行尾 | 一律 LF，`.gitattributes` 的 `eol=lf` 不能省（[踩坑 36](docs/踩坑-环境.md)） |
| 收尾 | 跑完 `pkill -x chrome`，`ss -ltnp` 找残留服务 `kill`（[踩坑 40](docs/踩坑-环境.md)） |
| 共享盘 | 偶发丢文件；大文件先写本机再 `cp`；别用 `perl -i` / `sed -i`（[踩坑 21](docs/踩坑-环境.md)） |
| 不猜日期 | 快速添加不解析文本，日期/时间只有「面板选的 > tab 默认值」（[踩坑 25](docs/踩坑-环境.md)） |
| CSS 层叠 | 同特异度后写赢；Tailwind 4 全在 `@layer` 里，无层作者样式永远赢（[踩坑 17](docs/踩坑-前端-交互.md)） |

## 五、工作约束

**代码**
1. **后端可以用 npm 库**，但每加一个都要先说清「标准库做不到什么」；引入就锁精确版本。
   **pi 的 import 只许在 `server/lib/ai/`**（现 16 个顶层文件 + `tools/` 子目录），别扩散到同步 / 鉴权等核心路径。
2. 不引入版本号并存（`v1`/`v2` 文件、数据 key）；结构变了就归档旧 key + 写迁移。
3. `domain/` 保持纯净（无 React / DOM / 网络），它要能在 Capacitor 与 Node 里跑。
4. 权限判断只在 `canWrite` / `canManage` / `db.roleOf()` 三个入口。
5. 前端新依赖要先问。
6. 别在文档、脚本、提交里写密码。

**验证**
7. 写完新组件顺手跑 `contrast.mjs` + `color-scan.mjs`（令牌唯一自动守卫）；端到端交互没有自动化覆盖，改完手工走一遍。
8. 探针/构建/测试命令见 [docs/测试.md](docs/测试.md)；发布与排障见 [DEPLOY.md](DEPLOY.md)。

**Git 与发布**
9. 动 git 前先看 `status` / `stash list` / `ls-files -u`；有别人的改动先存档，**绝不覆盖**。
   禁用 `checkout --` / `reset --hard` / `clean -fd` / `push -f` / `stash drop`；提交信息带「来源：」一行。详见 [docs/工作区保护.md](docs/工作区保护.md)。
10. 双端各推各的：Windows 在 `dev`，ubuntu 工程目录在 `main`。冲突时报告差异，不要替用户选边；尤其别动 ubuntu 那份工作区。
11. 发布走 `deploy/publish-*.sh`，默认 dry-run；**不要替用户加 `--approve`**，也不要 `--allow-dirty` / `--allow-unpushed`。
    生产目录只由发布脚本写入，规则见 [DEPLOY.md](DEPLOY.md)。