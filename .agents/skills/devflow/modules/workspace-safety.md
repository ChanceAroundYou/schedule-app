# 工作区保护（并行开发的硬规则）

**何时读**：**每次要动 git 或发布之前**，无一例外。

> 并发互斥见 `modules/lock.md`——进流程先抢锁，别靠"看见了就停"的人肉规则。

完整版在工程里：`docs/工作区保护.md`。这一份是执行卡。

## 为什么必须小心

同一份工作副本（`C:\Users\小哭包\coding\schedule-wt`）**可能同时有另一个 AI 会话在改**。
你 `git status` 里看到的未提交改动，很可能是别人正在做的工作 —— 覆盖掉等于凭空删掉别人刚做的事。

## 分支策略（唯一权威）

- 本地只留在 **`dev`**；不自动合并 `main`、不碰 ubuntu 那份工作区、不动其他分支。
- 这条规则在 devflow / schedule-sync 里都只**引用**此处，不重复定义；要改分支策略只改这里。

## 动 git 之前，先跑这五条

```bash
git status --porcelain      # 改动（M = 已跟踪改动，?? = 未跟踪新文件）
git stash list              # 有没有别人/自己存的半成品
git ls-files -u             # 冲突残留（非空 = 正在冲突中）
git log --oneline -3
git branch --show-current
```

**前三条任一有输出 → 先保全，不许直接 pull / rebase / merge / 发布。**

## 保全决策树

| 情况 | 做法 |
|---|---|
| 改动就是本任务产生的 | 直接带着进提交（首选） |
| 判断不了归属 / 明显是别的会话在做 | `git stash push -u -m "<说明>"`（推荐）或 WIP 分支 |
| 正在冲突中 | **停下报告**，不自动选边 |

```bash
git stash push -u -m "2026-10-17 另一会话的打卡改动，本任务不动"   # 记下 stash@{n}
# 或
git switch -c wip/<任务>-<日期> && git add -A && git commit -m "WIP: ..." && git switch -
```

⚠️ stash **必须带 `-u`**，否则未跟踪的新文件会被留在工作区照样可能被误删。
⚠️ 存档后把 stash 编号 / 分支名写进当天 `.workbuddy/memory/YYYY-MM-DD.md`。

## 禁止清单（违反即事故）

```
git checkout -- / git restore / git checkout .
git reset --hard            git clean -fd / -fdx
git push --force            git branch -D
git stash drop / clear      改写别人已推的提交
```

## 提交

- `git add <具体文件>`，**不用 `git add -A`**（会把别人的改动卷进来）
- 提交信息末尾**必须带来源行**：

```
fix(calendar): 一句话

为什么改。

来源：Windows 本机 · 会话A · 任务：<任务名>
```

- 一个逻辑改动一个提交；升版本号单独一个 `chore:`

## 冲突处理（绝不自动选边）

1. `git pull --rebase` 失败 → 看 `both modified` 的文件
2. 能判断归属且明显是我方正确 → 解决后 `git add`，继续 rebase
3. 判断不了 → `git rebase --abort`，向用户报告「我这边的改动是 A，云端是 B，保留哪边？」

## 发布前三层安全网

| 层 | 检查 |
|---|---|
| 提交前 | status 有内容才提交；`ls-files -u` 为空；add 清单里没有别的任务的文件 |
| 推送前 | 先 pull --rebase；确认 `git log @{u}..` 就是要推的那些 |
| 部署前 | 工作区干净 + 已推到 dev + **备份点已留** + 脚本体检通过 |

备份点：`git stash push -u -m` 或 `git branch backup/<日期>-<简述>`。**只增不删**。

## 出事怎么救

| 情况 | 救法 |
|---|---|
| 误提交 | `git revert <提交>`（保留历史），**不用 reset** |
| 线上发坏 | `publish-web.sh --rollback` / APK 重装上一版 |
| 误删未跟踪文件 | 立刻停手，报告用户，别再写盘 |

**不要用 `--allow-dirty` / `--allow-unpushed` 绕过发布体检** —— 那会让线上版本对不上任何提交。
