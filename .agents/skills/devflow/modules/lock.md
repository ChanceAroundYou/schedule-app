# 并发锁（session-claim）

**何时读**：devflow 第 0 步，和 preflight 一起。

## 为什么

同一份工作副本（`C:\Users\小哭包\coding\schedule-wt`）**可能同时有另一个 AI 会话在跑 devflow**。
两个会话都去 pull/rebase/commit/push 同一份副本，会互相覆盖、制造假冲突。
`workspace-safety.md` 的"看见了就停"是人肉规则，靠巧合才安全——这里用结构锁把它变成硬约束。

## 抢锁流程

锁文件位置：**仓库内的 `.git/devflow.lock`**（在 `.git/` 下，永远不会被 git 跟踪，也不会进提交）。

```bash
LOCK="$(git rev-parse --absolute-git-dir)/devflow.lock"
NOW=$(date +%s)
# 若锁存在且 ≤30 分钟且不是自己写的 → 退让
if [ -f "$LOCK" ]; then
  age=$(( NOW - $(stat -c %Y "$LOCK") ))
  if [ "$age" -lt 1800 ] && ! grep -q "$$" "$LOCK"; then
    echo "另一会话正在跑工作流（$(cat "$LOCK")），本流程退让，不抢锁。"
    exit 0   # 调用方据此停下
  fi
fi
echo "session=$$ host=$(hostname) task=<任务名> at=$(date -Iseconds)" > "$LOCK"
```

## 释放

- **正常结束**：删除锁 `rm -f "$LOCK"`。
- **出错 / 被打断**：也要删（在收尾或错误处理里删），否则会变成死锁。
- 锁里写 `$$`（进程 PID），自己写的自己认得；超过 30 分钟视为 stale 自动覆盖。

## 铁律

- 没抢到锁（别人的近期会话持有）→ **停下报告**，绝不绕过锁硬跑。
- 锁只在 `.git/` 内，不碰工作区、不进 git 跟踪。
