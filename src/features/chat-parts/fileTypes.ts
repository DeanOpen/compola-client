// File types of attachments (wave 3 #7, Teams-style file chip): a colour-coded type icon and a short label per family.

import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
  type LucideIcon,
} from 'lucide-react';

export type FileFamily = 'pdf' | 'doc' | 'xls' | 'ppt' | 'zip' | 'txt' | 'code' | 'image' | 'video' | 'audio' | 'other';

export interface FileTypeInfo {
  family: FileFamily;
  /** Upper-case extension shown after the size ("PDF", "DOCX"), or "TỆP" when there is none. */
  label: string;
  icon: LucideIcon;
  color: string;
}

const families: [FileFamily, string[]][] = [
  ['pdf', ['pdf']],
  ['doc', ['doc', 'docx', 'odt', 'rtf', 'pages']],
  ['xls', ['xls', 'xlsx', 'xlsm', 'csv', 'ods', 'numbers']],
  ['ppt', ['ppt', 'pptx', 'odp', 'key']],
  ['zip', ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'dmg']],
  ['txt', ['txt', 'md', 'log']],
  ['code', ['json', 'xml', 'html', 'css', 'js', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'swift', 'sql', 'sh', 'yml', 'yaml']],
  ['image', ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'avif', 'svg']],
  ['video', ['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv']],
  ['audio', ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'amr', 'opus']],
];

const style: Record<FileFamily, { icon: LucideIcon; color: string }> = {
  pdf: { icon: FileText, color: '#e5484d' },
  doc: { icon: FileText, color: '#2b7cd3' },
  xls: { icon: FileSpreadsheet, color: '#1d9e5b' },
  ppt: { icon: Presentation, color: '#e2673a' },
  zip: { icon: FileArchive, color: '#8e6cd8' },
  txt: { icon: FileText, color: '#7589a3' },
  code: { icon: FileCode, color: '#0f8fa8' },
  image: { icon: FileImage, color: '#0fa4c4' },
  video: { icon: FileVideo, color: '#d6407e' },
  audio: { icon: FileAudio, color: '#d88a0b' },
  other: { icon: File, color: '#7589a3' },
};

/** Extension of a file name or path, lower-case, without the dot ("" when none). */
export const extensionOf = (name: string): string => {
  const base = name.split(/[/\\]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : '';
};

export const fileTypeOf = (name: string, ext?: string | null): FileTypeInfo => {
  const e = (ext || extensionOf(name)).replace(/^\./, '').toLowerCase();
  const family = families.find(([, exts]) => exts.includes(e))?.[0] ?? 'other';
  return { family, label: e ? e.toUpperCase() : 'TỆP', ...style[family] };
};

/** "1,2 MB" (Vietnamese decimal comma, like the official client). */
export const formatBytes = (bytes: number | null | undefined): string => {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toLocaleString('vi-VN', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
};

/** Splits a name for a middle ellipsis: the head shrinks with "…", the tail (last chars + extension) always shows. */
export const splitForMiddleEllipsis = (name: string, tailChars = 8): [string, string] => {
  const ext = extensionOf(name);
  const stem = ext ? name.slice(0, -(ext.length + 1)) : name;
  if (stem.length <= tailChars + 4) return [name, ''];
  return [stem.slice(0, stem.length - tailChars), stem.slice(stem.length - tailChars) + (ext ? '.' + ext : '')];
};
