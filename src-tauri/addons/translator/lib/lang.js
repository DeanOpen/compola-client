// Dịch nhanh — language helpers shared by the backend (require) and the views (<script src="../lib/lang.js">).
(function (root) {
  'use strict';

  /** Target languages people can pick. `name` is what the AI is told. */
  const LANGS = [
    { code: 'en', label: 'English', name: 'English' },
    { code: 'zh', label: '中文', name: 'Simplified Chinese' },
    { code: 'ko', label: '한국어', name: 'Korean' },
    { code: 'ja', label: '日本語', name: 'Japanese' },
    { code: 'th', label: 'ไทย', name: 'Thai' },
  ];
  const byCode = {};
  for (const l of LANGS) byCode[l.code] = l;

  /** Letters only Vietnamese uses (đ, ơ, ư, ă and the dot-below / hook-above vowels). */
  const VI_STRONG = /[đăơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỷỹỵĩũ]/i;
  /** Common Vietnamese chat words typed without accents. */
  const VI_ASCII = /\b(ko|k|khong|hok|dc|duoc|nhe|nha|nhé|oi|roi|minh|cam on|bao nhieu|bn|gia|sdt|ship|chi|anh|em|a|ak|ah|shop|sz|mau|ao|quan|giao|hang|don|toi|ban|nhieu|nhu|the|vay|luon|cho|xin|chao|dat|mua)\b/g;
  const EN_ASCII = /\b(the|and|you|your|is|are|can|do|does|what|how|much|price|please|thanks|thank|hello|hi|want|need|have|order|shipping|size|color|when|where|available|i|my|me|it|this|that|for|to|of)\b/g;

  /** What script a text is mostly written in: ko, ja, zh, th, latin or null (no letters). */
  function script(text) {
    const t = String(text || '');
    if (/[가-힯ᄀ-ᇿ㄰-㆏]/.test(t)) return 'ko';
    if (/[぀-ヿㇰ-ㇿ]/.test(t)) return 'ja';
    if (/[฀-๿]/.test(t)) return 'th';
    if (/[一-鿿㐀-䶿]/.test(t)) return 'zh';
    if (/[Ѐ-ӿ]/.test(t)) return 'cyrillic';
    if (/[a-zA-ZÀ-ɏḀ-ỿ]/.test(t)) return 'latin';
    return null;
  }

  /**
   * Cheap guess, no AI: true when the text is Vietnamese (or has nothing to translate: emoji, numbers, "ok").
   * Accented Vietnamese is certain; unaccented chat is judged by common words.
   */
  function looksVietnamese(text) {
    const t = String(text || '').trim();
    const sc = script(t);
    if (!sc) return true;
    if (sc !== 'latin') return false;
    if (VI_STRONG.test(t)) return true;
    const letters = t.replace(/[^a-zA-ZÀ-ɏ]/g, '');
    if (letters.length < 3) return true;
    const lower = t.toLowerCase();
    const vi = (lower.match(VI_ASCII) || []).length;
    const en = (lower.match(EN_ASCII) || []).length;
    // Vietnamese with tone marks but without the strong letters (e.g. "có", "là", "giá") still has many accents.
    const accents = (t.match(/[àáãèéêìíòóôõùúýâ]/gi) || []).length;
    if (accents >= 2 && accents / letters.length > 0.08) return true;
    return vi > en && vi >= 2;
  }

  /** Language of a text by script alone, when that is certain; null for Latin (needs AI or a guess). */
  function codeByScript(text) {
    const sc = script(text);
    return sc === 'ko' || sc === 'ja' || sc === 'th' || sc === 'zh' ? sc : null;
  }

  const api = { LANGS, byCode, script, looksVietnamese, codeByScript };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.Lang = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
