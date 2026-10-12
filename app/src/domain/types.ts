/**
 * types.ts —— 数据模型 v4（桶文件）
 *
 * 实现拆在同目录的十个文件里，这里只 re-export。**公开类型与值与拆分前逐字相同**，
 * 所有 import 路径（`'./types'` / `'../domain/types'`）一行都不用改。
 *
 * 每个实体带 _ts / _dev —— 逐字段 LWW 的比较键，本地维护，不进同步。
 * 重复实例带 seriesId，id 由 `seriesId#发生日期` 派生，不再用随机数。
 * 删除是墓碑字段（deleted / purged / deletedAt），不是数组里抹掉一条。
 *
 * **每个实体带 calId。** 它不是可同步的字段，而是主键的一部分 —— 一条任务属于
 * 哪个集，改归属等于换一条实体（见 store.moveToCal）。所以 calId 和 _ts / _dev
 * 一样只存在本地、不进 op 的 fields。
 *
 * 「垃圾箱」在旧版是独立的 trash 数组，里面存的是整条任务的深拷贝快照。
 * 那样没法同步：另一端删掉任务后，快照只存在于删除方的浏览器里。v4 改成
 * 墓碑 —— 垃圾箱就是 `deleted && !purged` 的那些实体本身。清空垃圾箱 =
 * 把 purged 置真（仍走同一条 LWW 通道），不是物理删除。
 *
 * 权限判断只有 canWrite / canManage 两个入口（见 Cal.ts），别在别处写
 * `role === 'owner'`。
 */

export * from './types/types.ts';