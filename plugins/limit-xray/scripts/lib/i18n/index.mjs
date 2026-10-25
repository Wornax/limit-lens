// Report languages. A report is in the language from --lang, else LIMIT_XRAY_LANG, else Claude Code's
// `language` setting, else English. To add a language: copy en.mjs, translate every text keeping its
// placeholders (`p.name`), and register it in CATALOGS and langOf. A missing text falls back to English.
import en from './en.mjs';
import pt from './pt.mjs';
import { numberStyle } from '../format.mjs';

export const CATALOGS = { en, pt };

// "pt", "pt-BR", "Portuguese", "português" -> 'pt'; null for a language with no catalog.
export function langOf(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (/^pt(?![a-z])|portug|brazil|brasil/.test(v)) return 'pt';
  if (/^en(?![a-z])|^english/.test(v)) return 'en';
  return null;
}

export const resolveLang = ({ flag, env, setting } = {}) => langOf(flag) || langOf(env) || langOf(setting) || 'en';

// A catalog name for a key, or the fallback. Only the catalog's own keys count, so a key that comes from
// disk ("constructor", say) never reaches a property of Object.prototype.
export const lookup = (map, key, fallback = key) => (Object.hasOwn(map, key) ? map[key] : fallback);

const isObject = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const merge = (base, over) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObject(base[k]) && isObject(v) ? merge(base[k], v) : v;
  return out;
};

const cache = new Map();

// A language's texts (`t`) and its number and date formats. Dates are local time, like the report's days.
export function locale(lang = 'en') {
  if (cache.has(lang)) return cache.get(lang);
  const t = lang === 'en' ? en : merge(en, CATALOGS[lang] || {});
  const f = t.format;
  const two = (n) => String(n).padStart(2, '0');
  const isoParts = (iso) => ({ yyyy: iso.slice(0, 4), mm: iso.slice(5, 7), dd: iso.slice(8, 10), HH: iso.slice(11, 13), MM: iso.slice(14, 16) });
  const l = {
    lang,
    t,
    ...numberStyle(f),
    // A local calendar day given as YYYY-MM-DD: "Sat 10-24", "sáb 24/10".
    dayLabel: (key) => {
      const [y, m, d] = key.split('-').map(Number);
      return f.dayLabel({ weekday: f.weekdays[new Date(y, m - 1, d).getDay()], mm: key.slice(5, 7), dd: key.slice(8, 10) });
    },
    // "Oct 19", "19 de out".
    monthDay: (time) => {
      const d = new Date(time);
      return f.monthDay({ month: f.months[d.getMonth()], d: d.getDate() });
    },
    // "2026-10-25 14:03", "25/10/2026 às 14:03".
    dateTime: (time) => {
      const d = new Date(time);
      return f.dateTime({ yyyy: d.getFullYear(), mm: two(d.getMonth() + 1), dd: two(d.getDate()), HH: two(d.getHours()), MM: two(d.getMinutes()) });
    },
    // Dates and times as records keep them (ISO, in UTC), written the language's way: "2026-10-25" or
    // "25/10/2026"; "2026-10-25 15:04" or "25/10/2026 15:04" (the text adds "UTC").
    date: (iso) => f.date(isoParts(String(iso))),
    utc: (iso) => f.utc(isoParts(String(iso))),
  };
  cache.set(lang, l);
  return l;
}
