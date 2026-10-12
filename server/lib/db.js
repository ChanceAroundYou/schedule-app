/**
 * db.js —— SQLite 存储层（node:sqlite，零外部依赖）**桶文件**
 *
 * 实现拆在同目录的九个模块里，这里只 re-export。**公开 API 与拆分前逐字相同**，
 * 调用方（server.js / lib/*.js）的 require 路径一行都不用改。
 *
 *   schema.js      建表语句 + 迁移脚本（SCHEMA_VERSION / MIGRATIONS / ALL_TABLES）
 *   connection.js  打开 / 迁移执行 / tx / run / get / all（其他模块都从这儿拿）
 *   users.js       users
 *   calendars.js   calendars · calendar_members —— **权限的唯一真相**
 *   invites.js     invites（两段式：对方接受后才写进 calendar_members）
 *   sync-state.js  field_state（LWW 裁决）+ changes（seq 游标）
 *   revoked.js     revoked —— 登出 / 改口令后旧 token 失效
 *   ai.js          ai_settings · ai_sessions · ai_messages
 *   memory.js      ai_memory · ai_authorizations
 *
 * 十一张表：
 *   users             账户。平等多用户，没有管理员
 *   calendars         日程集 —— 数据的归属单位，相当于共享相册
 *   calendar_members  谁能看见哪个集、以什么身份（权限的**唯一**真相）
 *   invites           邀请。对方接受之后才写进 calendar_members
 *   field_state       当前值 + 每个字段各自的最后写入者 —— 同步的核心
 *   changes           追加流水，客户端按 seq 游标拉增量
 *   revoked           已登出的 jti，避免「登出后旧 token 还能用」
 *   ai_settings       每人一行的模型配置（v3 加）
 *   ai_sessions       对话会话（v3 加）
 *   ai_messages       会话里的消息 + 待确认提案（v3 加）
 *   ai_memory         跨对话记忆（v4 加）
 *   ai_authorizations  每人的授权状态（v4 加）
 *
 * 存的是**逐字段状态**，不是整份文档。原因：两台设备同时改同一条任务的不同
 * 字段（手机改标题、桌面改日期）时，只有真正冲突的那个字段需要决出胜负。
 * 整条任务存一坨的话，后写的那次会把对方那个字段一起抹掉。
 *
 * 后三张表**不参与 LWW 同步**：模型配置是「我的凭据」，对话是「我问过什么」，
 * 都不是日程集里的共享内容，按 userId 归属，跟账号走。
 *
 * **数据的归属是日程集，不是人。** 所以 field_state 与 changes 的键都是
 * cal_id —— 一个集里的所有人看到的是同一份数据，不是各存一份再互相同步。
 * 权限判断只查 calendar_members 一张表，不在别的表里冗余角色。
 *
 * 没有 oplog 表做幂等：LWW 本身幂等。同一条 op 重放时 ts 与 device_id 完全
 * 相同，ON CONFLICT 的 WHERE 不成立 → 一行都不改 → 天然不重复。
 */
'use strict';

const schema = require('./db/schema.js');
const connection = require('./db/connection.js');
const users = require('./db/users.js');
const calendars = require('./db/calendars.js');
const invites = require('./db/invites.js');
const syncState = require('./db/sync-state.js');
const revoked = require('./db/revoked.js');
const ai = require('./db/ai.js');
const memory = require('./db/memory.js');

module.exports = {
  // schema
  SCHEMA_VERSION: schema.SCHEMA_VERSION,
  MIGRATIONS: schema.MIGRATIONS,
  ALL_TABLES: schema.ALL_TABLES,
  ROLES: calendars.ROLES,
  // connection
  open: connection.open,
  tx: connection.tx,
  run: connection.run,
  get: connection.get,
  all: connection.all,
  file: connection.file,
  close: connection.close,
  // users
  countUsers: users.countUsers,
  findUserByName: users.findUserByName,
  findUserById: users.findUserById,
  insertUser: users.insertUser,
  updateUserPassword: users.updateUserPassword,
  // calendars / members
  insertCalendar: calendars.insertCalendar,
  findCalendar: calendars.findCalendar,
  renameCalendar: calendars.renameCalendar,
  softDeleteCalendar: calendars.softDeleteCalendar,
  calendarsFor: calendars.calendarsFor,
  calendarIdsFor: calendars.calendarIdsFor,
  countCalendarsFor: calendars.countCalendarsFor,
  roleOf: calendars.roleOf,
  upsertMember: calendars.upsertMember,
  removeMember: calendars.removeMember,
  membersOf: calendars.membersOf,
  countOwners: calendars.countOwners,
  // invites
  insertInvite: invites.insertInvite,
  findInvite: invites.findInvite,
  findPendingInvite: invites.findPendingInvite,
  decideInvite: invites.decideInvite,
  invitesFor: invites.invitesFor,
  invitesSentBy: invites.invitesSentBy,
  cancelPendingInvites: invites.cancelPendingInvites,
  // sync state
  putField: syncState.putField,
  maxSeq: syncState.maxSeq,
  appendChange: syncState.appendChange,
  changesSince: syncState.changesSince,
  allFields: syncState.allFields,
  // revoked
  isRevoked: revoked.isRevoked,
  revokeJti: revoked.revokeJti,
  pruneRevoked: revoked.pruneRevoked,
  revokeBefore: revoked.revokeBefore,
  pwCutoffOf: revoked.pwCutoffOf,
  // ai settings / sessions / messages
  getAiSettings: ai.getAiSettings,
  putAiSettings: ai.putAiSettings,
  insertAiSession: ai.insertAiSession,
  listAiSessions: ai.listAiSessions,
  findAiSession: ai.findAiSession,
  touchAiSession: ai.touchAiSession,
  deleteAiSession: ai.deleteAiSession,
  nextAiMessageSeq: ai.nextAiMessageSeq,
  appendAiMessage: ai.appendAiMessage,
  listAiMessages: ai.listAiMessages,
  setAiMessageProposals: ai.setAiMessageProposals,
  findAiProposal: ai.findAiProposal,
  // ai memory / authorizations
  insertMemory: memory.insertMemory,
  listMemories: memory.listMemories,
  deleteMemory: memory.deleteMemory,
  touchMemories: memory.touchMemories,
  pruneMemories: memory.pruneMemories,
  getAuthorizations: memory.getAuthorizations,
  putAuthorizations: memory.putAuthorizations,
};