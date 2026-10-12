/**
 * Cal —— 日程集
 */

/**
 * 三档角色。判断只走 `canWrite` / `canManage` 两个函数，
 * 别在界面上散落 `role === 'owner'` 这种比较 —— 加一档时会漏。
 */
export type Role = 'owner' | 'editor' | 'viewer';

export interface Cal {
  id: string;
  name: string;
  ownerId: string;
  createdAt: number;
  /** **我**在这个集里的角色 */
  role: Role;
}

export interface Member {
  id: string;
  name: string;
  role: Role;
  joinedAt: number;
}

export interface Invite {
  id: string;
  calId: string;
  calName: string;
  role: Role;
  createdAt: number;
  /** 待我处理的：谁邀请的 */
  fromName: string | null;
  /** 我发出去的：邀请的谁 */
  toName: string | null;
}

/** 能改内容（任务 / 打卡） */
export const canWrite = (r: Role | undefined | null): boolean => r === 'owner' || r === 'editor';
/** 能改集本身与成员 */
export const canManage = (r: Role | undefined | null): boolean => r === 'owner';

export const ROLE_LABEL: Record<Role, string> = {
  owner: '创建者',
  editor: '可编辑',
  viewer: '只读',
};

export const ROLES: Role[] = ['owner', 'editor', 'viewer'];

/**
 * **能授出去的**角色：只有 `editor` 与 `viewer`，没有 `owner`。
 *
 * 创建者不是「一种可以分下去的权限」，而是一个集**必须存在的那个主人**
 * （不变量 2：每个集永远至少有一个 owner）。所以下拉里不该有它 ——
 * 列出来就等于在问「把谁升成第二个主人」，那是个没有答案的问题。
 *
 * 界面上凡是「给某人挑权限」的选择器都该用这个列表，别再用 `ROLES`。
 */
export const ASSIGNABLE_ROLES: Role[] = ['editor', 'viewer'];

/** 角色一句话解释，选权限时直接写清楚会怎样 */
export const ROLE_HINT: Record<Role, string> = {
  owner: '能改内容，也能改名、加人、删日程集',
  editor: '能增删改任务和打卡，管不了成员',
  viewer: '只能看',
};
