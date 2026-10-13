# 编码规范第 7 册 · 测试

> 状态：**长期规则**（本册含验证命令，无独立 plan）
> 依据：`docs/测试.md`、`docs/重构-组件合并-实施spec.md` §8–§9、
> `app/tests/`（browser-smoke/contrast/color-scan）、`server/tests/`（api/migration/ai/smoke-share）
> 不变量：测试隔离第一（临时后端+随机端口，不碰线上库）；跑完收干净；本册只定矩阵与纪律，不写用例。

---

## 1. 现状审计（2026-10-13 实测，会随代码漂移）

| 层 | 工具 | 条数 | 隔离 |
|---|---|---|---|
| `domain/ data/ sync/` 单测 | `node --test`（零依赖） | 132 条（app） | 纯函数，无 IO |
| 后端 api/migration/ai | `node --test` + `smoke-share.mjs` | 46 + 8 + 19 条 | 临时库+随机端口 |
| 颜色/令牌 | `contrast.mjs`（72 对）+ `color-scan.mjs` | 0 不达标 | 静态扫描，零依赖 |
| UI 全量 | `browser-smoke.mjs`（无头 Chrome + CDP） | 421 条 | 临时后端+静态服务+独立 profile |
| 待新增 | `api-scan.mjs`（第 1 册 plan §2） | — | 静态扫描，零依赖 |

- 探针纪律（踩坑沉淀）：`evalJs` 一律写 `return`；`waitFor` 只吃表达式、不以换行开头、
  条件只可能因那件事成立；`waitForUi` TDZ 注意定义顺序；读 DOM 用原型 setter + input 事件；
  `persist()` 250ms 防抖，等渲染不直读 localStorage；删除断言认墓碑（`deleted===true`）不数 key；
  探针伺服 `dist/`（改源码必 `npm run build` 重建）。
- 端口自动让开（首选被占往后排，起手行写明实用的四个），但**避让只管本趟**——残留旧后端会静默劫持。
- 收尾三件（踩坑 40）：`pkill -x chrome` 归零、`ss -ltnp` 杀残留服务、`rm -rf /tmp/sched-browser-*`。

---

## 2. 规矩

### T1 三层各测各的，不串层

- 纯函数（`placePanel`、`repeatAdvance`、`findConflicts`、`projectColumn`）→ `node --test` 单测，可 TDD。
- DOM/样式/交互 → 探针回归（改前跑基线存档，改后逐条对齐；新增/消失断言要能解释）。
- 颜色/圆角/令牌 → `color-scan` / `contrast` 扩断言（先红后绿）。
- 项目没 jsdom，**不新造 hook 单测**（不加依赖）；UI 层只靠探针。

### T2 扫描器矩阵（各册判据收齐处）

| 扫描器 | 锁哪册 | 现状 |
|---|---|---|
| `contrast.mjs` ①② | 颜色对比（第 1 册令牌） | 72 对 0 不达标 |
| `contrast.mjs` ③④ | 变量名+兜底值（第 3 册 N3） | 绿 |
| `color-scan.mjs` | 写死值/原生 select/圆角（第 1 册） | 绿 |
| `api-scan.mjs`（新增） | 调用方零 Tailwind（R4）+ kit 无 className + `data-act` 有 case + domain/views 纯度（D1/D2） | 待建 |
| `browser-smoke.mjs` | 交互/无障碍/数据流全量（第 5/8 册） | 421 断言绿 |
| `server/tests` | 后端路由/迁移/AI（第 9 册） | 46+8+19 绿 |

- 新增扫描器零依赖、读 `tailwind.css` 的 `@import` 现取文件清单（加模块不用回补）；
  收紧容易放宽难——误报修代码侧，不放宽测试。

### T3 探针断言纪律（有牙才算数）

- 等"条数/落定值"不等"包含某字"（ROLE_LABEL 误触发先例）；分段等（同步先、DOM 后，超时可定位）。
- 断言写"牙"：离线段关服务前 `closeAllConnections` + HTML `no-store`（防缓存假通过）；
  拖拽两节分测手势与接线（删 `dragId` 只红第九节为验牙标准）。
- 新增输入框必配 `nameOf()` 断言；新增浮层必配四件套断言（`role/aria-modal` + 焦点圈 + 焦点进出）。

### T4 隔离与收尾

- 探针/共享测试自起临时后端（临时库+随机端口），**不碰线上 25692 与生产库**；
  不用 `vite preview`（代理写死线上后端）。
- 每轮收尾：`pkill -x chrome` 确认归零 → `ss -ltnp` 杀残留 → `rm -rf /tmp/sched-browser-*` →
  下轮起手行核对端口无劫持（注册 409 即指错地方的信号）。
- `dist/` 被跟踪：改 `app/src` 必重建（`npm run build`，39s 级），否则探针读脏。

---

## 3. 判据

1. 全套命令一遍绿（§4 清单），任一红即 blocker（CRITICAL/HIGH 按安全分级）。
2. 扫描器矩阵 6 格全绿；新增规则先红（TDD）后绿。
3. 工作区干净（`git status --short` 空）；测试残留归零（chrome 0 进程、端口无残留）。

---

## 4. 全套验证命令（每步做完 / 每册收尾）

```bash
cd app && npm run typecheck          # 类型
cd app && npm test                   # 132 条单测
node server/tests/api.test.js        # 46 条接口
node server/tests/migration.test.js  # 8 条迁移
node --test server/tests/ai.test.js  # 19 条 AI
cd app && node tests/color-scan.mjs  # 写死值/圆角/select
cd app && node tests/contrast.mjs    # 72 对比度 + 变量名 + 兜底值
cd app && node tests/api-scan.mjs    # 待建：调用方零 Tailwind + 纯度
cd app && npm run build              # tsc -b && vite build → ../dist/
cd app && node tests/browser-smoke.mjs  # 421 断言全量回归
# 收尾：pkill -x chrome；ss -ltnp 杀残留；rm -rf /tmp/sched-browser-*
```
