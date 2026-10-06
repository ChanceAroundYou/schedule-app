/** cx —— 拼类名。tailwind-merge 负责把互相冲突的同类工具类裁到只剩最后一个 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cx(...parts: ClassValue[]): string {
  return twMerge(clsx(parts));
}
