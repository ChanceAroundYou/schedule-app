/**
 * api/media.ts —— 详细内容里的图片：压缩、上传、读回地址
 *
 * **压缩放在客户端，这是整个方案里唯一不能省的一步。** 手机截图原图 2~4MB，
 * 一张 4MB 的图进 SQLite 那条同步流会把 outbox 撑爆（而且 `note` 是字段级
 * LWW，整串 HTML 每次改动都要重传一遍）。压完 200~400KB，成本降到十分之一。
 *
 * 三道取舍：
 *   1. 长边压到 2560 —— 备注里显示的最大高度也就 260px，点开放大时 2560 在
 *      手机屏上已经够锐；
 *   2. 输出 WebP（q=0.82）—— 同画质比 JPEG 小 25~35%；浏览器/WebView 都支持，
 *      万一 `toBlob` 不认会退回 PNG；
 *   3. **压完比原图还大就用原图** —— 本来就小的图（比如 100KB 的 JPEG）
 *      重编码经常反而变大，这条兜住。
 *
 * 动图（GIF）直接原样上：canvas 一过就只剩第一帧，那等于把动图弄坏了。
 */
import { API_BASE } from './request.ts';
import { getToken } from './token.ts';
import { ApiError } from './error.ts';

/** 长边上限。再大也只是白白多占存储，看不出区别 */
const MAX_EDGE = 2560;
/** WebP 质量。0.82 是肉眼基本无损、体积掉一半的那一档 */
const QUALITY = 0.82;

function loadViaImg(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('这张图读不出来')); };
    img.src = url;
  });
}

/** 压到能放进备注为止。总是返回一个可上传的 Blob */
export async function compressImage(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('只能插入图片');
  if (file.type === 'image/gif') return file;

  let src: ImageBitmap | HTMLImageElement;
  try {
    src = await createImageBitmap(file);
  } catch (_) {
    src = await loadViaImg(file);
  }

  const w0 = src.width;
  const h0 = src.height;
  if (!w0 || !h0) return file;

  const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  /* 先铺白底：PNG 的透明区域直接转 WebP 在很多实现里会变成黑块。
     代价是带透明的切图会得到白底 —— 备注里的图基本是截图，这个取舍划算。 */
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src as CanvasImageSource, 0, 0, w, h);
  if ('close' in src && typeof src.close === 'function') src.close();

  const out = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/webp', QUALITY);
  });
  if (!out) return file;
  return out.size < file.size ? out : file;
}

/**
 * 上传，返回**相对路径**（`/api/media/<hash>.webp`）。
 *
 * 库里只存相对路径 —— 换域名或 App 换接口基址时，已存的图不会写死成旧地址。
 * 补全前缀是渲染时的事（见 ui/editor/mediaUrl.ts）。
 */
export async function uploadImage(file: File): Promise<string> {
  const blob = await compressImage(file);
  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': blob.type || file.type || 'application/octet-stream' };
  if (token) headers.Authorization = 'Bearer ' + token;

  let res: Response;
  try {
    res = await fetch(API_BASE + '/api/media', { method: 'POST', headers, body: blob });
  } catch (_) {
    throw new ApiError(0, '连不上服务器，图片需要联网上传');
  }
  const text = await res.text();
  let data: { url?: string; error?: string } | null = null;
  if (text) {
    try { data = JSON.parse(text) as { url?: string; error?: string }; } catch (_) { /* 下面统一报错 */ }
  }
  if (!res.ok || !data || !data.url) {
    if (res.status === 401) throw new ApiError(401, '登录状态已失效，请重新登录');
    throw new ApiError(res.status, (data && data.error) || '图片上传失败');
  }
  return data.url;
}
