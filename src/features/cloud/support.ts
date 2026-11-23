// Shared helpers of the zCloud screens (Swift CloudSupport.swift): formatting, names, icons, and the window-level UI
// state of the zCloud destination (Swift `ShellModel.cloudRoute`, the preview sheet).

import {
  File,
  FileArchive,
  FileImage,
  FileQuestion,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Image,
  Music,
  Play,
  Presentation,
  AudioLines,
  type LucideIcon,
} from 'lucide-react';
import { create } from 'zustand';
import { onAccountReset } from '../../engine/store';
import type { CloudItem, CloudItemKind } from '../../engine/cloud';

// MARK: - Formatting (Swift CloudFormat)

const decimal = (value: number, digits: number) =>
  new Intl.NumberFormat('vi-VN', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value);

/** Binary units shown the way Zalo does ("100 GB" for 100 GiB); adaptive precision like `ByteCountFormatter`. */
export const formatSize = (bytes: number): string => {
  const v = Math.max(0, bytes);
  if (v < 1024) return v === 0 ? '0 KB' : `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = v / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${decimal(n, i === 0 ? 0 : i === 1 ? 1 : 2)} ${units[i]}`;
};

const pad = (n: number) => String(n).padStart(2, '0');

export const formatDate = (ms: number | null): string => {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
};

export const formatDateTime = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())} ${formatDate(ms)}`;
};

export const formatDuration = (seconds: number): string => {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
};

// MARK: - Items

/** Name to show: the sent file name, else a generic label for the kind. */
export const itemName = (item: CloudItem): string => {
  if (item.title) return item.title;
  switch (item.kind) {
    case 'photo':
      return 'Ảnh';
    case 'video':
      return 'Video';
    case 'voice':
      return 'Tin nhắn thoại';
    case 'file':
      return 'File';
    case 'other':
      return 'Nội dung';
  }
};

export const conversationLabel = (item: CloudItem) => item.conversationName || 'Trò chuyện';

export const kindIcon = (k: CloudItemKind): LucideIcon => {
  switch (k) {
    case 'photo':
      return Image;
    case 'video':
      return Play;
    case 'file':
      return File;
    case 'voice':
      return AudioLines;
    case 'other':
      return FileQuestion;
  }
};

/** Icon for a file by its extension. */
export const fileIcon = (item: CloudItem): LucideIcon => {
  switch (item.ext.toLowerCase()) {
    case 'pdf':
    case 'doc':
    case 'docx':
    case 'rtf':
    case 'pages':
    case 'txt':
    case 'md':
      return FileText;
    case 'xls':
    case 'xlsx':
    case 'csv':
    case 'numbers':
      return FileSpreadsheet;
    case 'ppt':
    case 'pptx':
    case 'key':
      return Presentation;
    case 'zip':
    case 'rar':
    case '7z':
    case 'gz':
    case 'tar':
      return FileArchive;
    case 'mp3':
    case 'm4a':
    case 'wav':
    case 'aac':
    case 'flac':
      return Music;
    case 'mp4':
    case 'mov':
    case 'mkv':
    case 'avi':
      return FileVideo;
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'gif':
    case 'heic':
    case 'webp':
      return FileImage;
    default:
      return File;
  }
};

export const itemIcon = (item: CloudItem): LucideIcon => (item.kind === 'file' ? fileIcon(item) : kindIcon(item.kind));

const stamp = (ms: number | null) => {
  const d = new Date(ms ?? Date.now());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
};

/** Name (with extension) to use outside zCloud (Swift `CloudFiles.outputName`). */
export const outputName = (item: CloudItem, fileExt = ''): string => {
  const join = (stem: string, ext: string) => (ext ? `${stem}.${ext}` : stem);
  switch (item.kind) {
    case 'file': {
      const titleExt = item.title.includes('.') ? item.title.split('.').pop()! : '';
      const ext = item.ext || titleExt || fileExt;
      const stem = titleExt && titleExt.toLowerCase() === ext.toLowerCase() ? item.title.slice(0, -(titleExt.length + 1)) : item.title;
      return join(stem || 'File zCloud', ext);
    }
    case 'photo':
      return join(`Ảnh zCloud ${stamp(item.date)}`, fileExt || 'jpg');
    case 'video':
      return join(`Video zCloud ${stamp(item.date)}`, fileExt || 'mp4');
    case 'voice':
      return join(`Tin nhắn thoại ${stamp(item.date)}`, fileExt || 'm4a');
    case 'other':
      return join(`zCloud ${stamp(item.date)}`, fileExt);
  }
};

// MARK: - Sorting (Swift CloudSort)

export type CloudSort = 'newest' | 'oldest' | 'largest' | 'smallest';

export const cloudSorts: { id: CloudSort; title: string }[] = [
  { id: 'newest', title: 'Thời gian gửi (mới → cũ)' },
  { id: 'oldest', title: 'Thời gian gửi (cũ → mới)' },
  { id: 'largest', title: 'Dung lượng giảm dần' },
  { id: 'smallest', title: 'Dung lượng tăng dần' },
];

export const sortBySize = (s: CloudSort) => s === 'largest' || s === 'smallest';
export const sortAscending = (s: CloudSort) => s === 'oldest' || s === 'smallest';

// MARK: - Window state

/** The zCloud screens, picked in the content column (Swift `CloudRoute`). */
export type CloudRoute = 'media' | 'conversations' | 'myCloud' | 'plan' | 'settings';

/** Which cloud data a browse screen shows (official screens MEDIA / CONV→MEDIA / MY_CLOUD). */
export type CloudScope = { kind: 'all' } | { kind: 'conversation'; id: string; name: string } | { kind: 'myCloud'; id: string };

export const scopeConversationId = (s: CloudScope): string | null => (s.kind === 'all' ? null : s.id);

interface CloudUiState {
  route: CloudRoute;
  /** "Theo trò chuyện" → one conversation's items (the Swift NavigationStack path). */
  openConversation: { id: string; name: string } | null;
  preview: CloudItem | null;
}

export const useCloudUi = create<CloudUiState>()(() => ({ route: 'media', openConversation: null, preview: null }));

export const cloudUi = {
  setRoute: (route: CloudRoute) => useCloudUi.setState({ route, openConversation: null }),
  openConversation: (c: { id: string; name: string } | null) => useCloudUi.setState({ openConversation: c }),
  preview: (item: CloudItem | null) => useCloudUi.setState({ preview: item }),
};

onAccountReset(() => useCloudUi.setState({ route: 'media', openConversation: null, preview: null }));
