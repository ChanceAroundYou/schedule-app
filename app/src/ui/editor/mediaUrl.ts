/**
 * mediaUrl.ts —— 详细内容里那些图片地址的「存」与「显示」
 *
 * **库里存的是相对路径**（`/api/media/<hash>.webp`），这样换域名、App 换接口
 * 基址、内网直连换 IP，已经写进备注的图都不会变成死链。
 *
 * 但浏览器读 `<img src="/api/media/…">` 会从**站点根**去找 —— 网页版部署在
 * `/schedule/` 下，根上没有这个路径，图当场 404。于是进出编辑器各做一次替换：
 *
 *   进（resolve）：`/api/media/` → `${API_BASE}/api/media/`
 *   出（strip）  ：反过来
 *
 * 为什么不在 Tiptap 里改写 Image 扩展的 renderHTML：那条路会让 `getHTML()`
 * 也输出带前缀的地址（序列化走的就是 renderHTML），于是每次保存都把当前域名
 * 焊进数据里 —— 正是这里要避免的事。进去改、出来还原，数据永远是干净的。
 */
import { API_BASE } from '../../data/api/request.ts';

const REL = '/api/media/';

/** API_BASE 可能是 `.`（网页版，同源相对）也可能是完整域名，统一去掉尾斜杠 */
const BASE = API_BASE === '.' ? '.' : API_BASE.replace(/\/+$/, '');

/** 存库格式 → 能显示的格式 */
export function resolveMedia(html: string): string {
  if (!html) return '';
  return html.split('src="' + REL).join('src="' + BASE + REL);
}

/** 能显示的格式 → 存库格式。和 resolveMedia 严格互逆 */
export function stripMedia(html: string): string {
  if (!html) return '';
  return html.split('src="' + BASE + REL).join('src="' + REL);
}

/** 单张图的地址（编辑器外面偶尔要直接用） */
export function mediaHref(path: string): string {
  return path.startsWith(REL) ? BASE + path : path;
}
