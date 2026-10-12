/**
 * store.ts —— 本地状态 + 写入通道（桶文件）
 *
 * 实现拆在同目录的十五个文件里，这里只 re-export。**公开 API 与拆分前逐字相同**，
 * 所有 import 路径（`'./data/store'` / `'../data/store'`）一行都不用改。
 *
 * 模型是「本地先写、后台补推」（server-authoritative + client outbox）：
 *   1. 用户操作 → 立刻改内存里的 state，界面马上反映，不等网络
 *   2. 同时压一条 op 进 outbox，落 localStorage
 *   3. engine 在后台把 outbox 推给服务器，成功才把它清掉
 *
 * 每条 op 只带**本次改动的那几个字段**，不是整条实体。这样两台设备分别改
 * 同一条任务的不同字段时能各自保住（逐字段 LWW），而不是后到的整条覆盖。
 *
 * state 是**可变单例**（在 `core.ts`），各模块从这里 import —— 依赖图是一棵树：
 * `core → persist → commit → {tasks, habits, projects, sort, moveToCal, …}`，没有环。
 *
 * **写权限在写入通道那层把关**，不是靠界面藏按钮：`commitMany()`（本地写）与
 * `sync.applyOps()`（远端落地）各挡一次。只读成员被挡下时 `denied` +1 并弹一次
 * 提示 —— **别让写操作静默失败**（记录只有 `deny()` 一个入口）。
 *
 * **挪集是例外**：它走自己的写入路径（目标集新建一条 + 源集留墓碑，因为
 * calId 是主键的一部分而不是可同步字段），所以自己也要挡一次权限。
 */

export * from './store/store.ts';