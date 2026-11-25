// Phone numbers of people found by phone (this device only). Zalo never hands out a contact's number, so once a request goes
// out the only link between a person and the number typed in "Thêm bạn" is what is remembered here: every successful
// find-by-phone records `uid → number`, and the requests page, the profile dialog and the friend list show it (the friend
// search matches it too). Zalo uids are the same for every account, so one book serves all accounts of this Compola.

import { create } from 'zustand';

export interface Country {
  iso: string;
  code: string;
  name: string;
}

export const countries: Country[] = [
  { iso: 'VN', code: '+84', name: 'Việt Nam' },
  { iso: 'US', code: '+1', name: 'Hoa Kỳ' },
  { iso: 'AU', code: '+61', name: 'Úc' },
  { iso: 'CA', code: '+1', name: 'Canada' },
  { iso: 'CN', code: '+86', name: 'Trung Quốc' },
  { iso: 'DE', code: '+49', name: 'Đức' },
  { iso: 'FR', code: '+33', name: 'Pháp' },
  { iso: 'GB', code: '+44', name: 'Anh' },
  { iso: 'JP', code: '+81', name: 'Nhật Bản' },
  { iso: 'KH', code: '+855', name: 'Campuchia' },
  { iso: 'KR', code: '+82', name: 'Hàn Quốc' },
  { iso: 'LA', code: '+856', name: 'Lào' },
  { iso: 'MY', code: '+60', name: 'Malaysia' },
  { iso: 'SG', code: '+65', name: 'Singapore' },
  { iso: 'TH', code: '+66', name: 'Thái Lan' },
  { iso: 'TW', code: '+886', name: 'Đài Loan' },
];

/** "0912345678" → "0912 345 678" (Vietnamese mobile grouping); other numbers as typed. */
export const prettyPhone = (phone: string): string => {
  const digits = phone.replace(/\s+/g, '');
  if (/^0\d{9}$/.test(digits)) return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  return phone.trim();
};

export interface KnownPhone {
  /** The number as typed in "Thêm bạn". */
  phone: string;
  /** The country picked next to it. */
  iso: string;
  /** Name when the number was looked up (who it was, even if they rename later). */
  name: string;
  /** Epoch ms of the last lookup. */
  at: number;
}

/** "0912 345 678" for Việt Nam, "+65 91234567" for another country, a number starting with + as typed. */
export const phoneText = (p: Pick<KnownPhone, 'phone' | 'iso'>): string => {
  const phone = p.phone.trim();
  if (phone.startsWith('+') || p.iso === 'VN') return prettyPhone(phone);
  const code = countries.find((c) => c.iso === p.iso)?.code;
  return code ? `${code} ${phone.replace(/^0+/, '')}` : phone;
};

/** Digits only, without the leading 0 / country code, so "0912 345 678", "+84912345678" and "912345678" all match. */
const phoneDigits = (text: string) => {
  const d = text.replace(/\D/g, '');
  return /^84\d{9}$/.test(d) ? d.slice(2) : d.replace(/^0+/, '');
};

const storageKey = 'compola.contactPhones';
const maxEntries = 5000;

const load = (): Record<string, KnownPhone> => {
  const book: Record<string, KnownPhone> = {};
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    if (raw && typeof raw === 'object') {
      for (const [id, v] of Object.entries(raw as Record<string, Partial<KnownPhone>>)) {
        if (id && v && typeof v.phone === 'string' && v.phone.trim()) {
          book[id] = { phone: v.phone, iso: typeof v.iso === 'string' ? v.iso : 'VN', name: typeof v.name === 'string' ? v.name : '', at: Number(v.at) || 0 };
        }
      }
    }
    // Numbers already in the add-friend dialog's recent searches (kept before this book existed).
    const recent = JSON.parse(localStorage.getItem('compola.addFriend.recent') ?? '[]');
    if (Array.isArray(recent)) {
      for (const r of recent) {
        if (r && typeof r.id === 'string' && typeof r.phone === 'string' && r.phone.trim() && !book[r.id]) {
          book[r.id] = { phone: r.phone, iso: typeof r.iso === 'string' ? r.iso : 'VN', name: typeof r.name === 'string' ? r.name : '', at: 0 };
        }
      }
    }
  } catch {
    /* unreadable storage: start empty */
  }
  return book;
};

const save = (book: Record<string, KnownPhone>) => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(book));
  } catch {
    /* storage unavailable: kept for this session only */
  }
};

export const useContactPhones = create<{ book: Record<string, KnownPhone> }>()(() => ({ book: load() }));

/** Remembers that `phone` (as typed, with its country) belongs to the Zalo user `id`. */
export const rememberPhone = (id: string, phone: string, iso: string, name: string) => {
  const trimmed = phone.trim();
  if (!id || !trimmed) return;
  const book = { ...useContactPhones.getState().book };
  // A number belongs to one account: an older owner of the same number loses it.
  const digits = phoneDigits(trimmed);
  for (const [other, p] of Object.entries(book)) if (other !== id && phoneDigits(p.phone) === digits) delete book[other];
  book[id] = { phone: trimmed, iso, name, at: Date.now() };
  const ids = Object.keys(book);
  if (ids.length > maxEntries) {
    ids.sort((a, b) => book[a].at - book[b].at);
    for (const old of ids.slice(0, ids.length - maxEntries)) delete book[old];
  }
  useContactPhones.setState({ book });
  save(book);
};

export const forgetPhone = (id: string) => {
  const book = { ...useContactPhones.getState().book };
  if (!book[id]) return;
  delete book[id];
  useContactPhones.setState({ book });
  save(book);
};

/** The remembered number of `id`, formatted for display; null when unknown. */
export const usePhoneOf = (id: string | null | undefined): string | null =>
  useContactPhones((s) => {
    const p = id ? s.book[id] : undefined;
    return p ? phoneText(p) : null;
  });

/** Whether a search text (at least 3 digits) matches the remembered number of `id`. */
export const phoneMatches = (book: Record<string, KnownPhone>, id: string, query: string): boolean => {
  const q = phoneDigits(query);
  if (q.length < 3 || /[^\d\s+().-]/.test(query.trim())) return false;
  const p = book[id];
  return !!p && phoneDigits(p.phone).includes(q);
};
