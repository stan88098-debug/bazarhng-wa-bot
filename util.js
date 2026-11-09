// Pure helpers (no external dependencies)
export const naira = (n) => `₦${Number(n).toLocaleString('en-NG')}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clip = (s, n) => {
  const v = String(s ?? '');
  return v.length > n ? v.slice(0, n - 1) + '…' : v;
};

export function extractJson(raw) {
  try { return JSON.parse(raw); } catch {}
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// "45k" -> 45000, "2.5k" -> 2500, "1.2m" -> 1200000, "₦45,000" -> 45000
export function parseMoney(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).toLowerCase().replace(/[₦,\s]/g, '').replace(/^(ngn|naira|n)(?=\d)/, '').replace(/(naira|ngn)$/, '');
  const m = s.match(/^(\d+(?:\.\d+)?)(k|m|thousand|million)?$/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (m[2] === 'k' || m[2] === 'thousand') n *= 1e3;
  else if (m[2] === 'm' || m[2] === 'million') n *= 1e6;
  return n;
}

export function parseCount(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

// Vendor-friendly rounding for bulk price changes (nearest N10 above N500, else N1)
export function roundPrice(n) {
  const step = n >= 500 ? 10 : 1;
  return Math.max(1, Math.round(n / step) * step);
}

// ---------- fuzzy product matching ----------
export const norm = (s) =>
  String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function bigramDice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
    return m;
  };
  const A = grams(a), B = grams(b);
  let inter = 0;
  for (const [g, c] of A) inter += Math.min(c, B.get(g) || 0);
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

export function similarity(query, name) {
  const q = norm(query), n = norm(name);
  if (!q || !n) return 0;
  const qc = q.replace(/ /g, ''), nc = n.replace(/ /g, '');
  if (qc === nc) return 1;
  if (nc.includes(qc)) return 0.85 + 0.15 * (qc.length / nc.length);
  const nt = n.split(' ');
  const scores = q.split(' ').map((t) =>
    Math.max(...nt.map((x) => {
      if (x === t) return 1;
      if (t.length >= 3 && x.length >= 3 && (x.startsWith(t) || t.startsWith(x))) return 0.9;
      return bigramDice(t, x);
    }))
  );
  const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
  return Math.max(bigramDice(qc, nc), avg * 0.9);
}

// -> {type:'one'|'unsure'|'many'|'none', product?, candidates?}
export function resolveProduct(products, ref) {
  const r = String(ref ?? '').trim();
  if (!r) return { type: 'none' };
  // a bare 1-2 digit reply is a list pick, not a product name; let the AI map it
  if (/^\d{1,2}$/.test(r)) return { type: 'none' };
  const exactId = products.find((p) => String(p.id) === r || p.handle === r);
  if (exactId) return { type: 'one', product: exactId, score: 1 };
  const scored = products
    .map((p) => ({ p, s: similarity(r, p.name) }))
    .filter((x) => x.s >= 0.6)
    .sort((a, b) => b.s - a.s);
  if (!scored.length) return { type: 'none' };
  const best = scored[0];
  const close = scored.filter((x) => x.s >= best.s - 0.08);
  const exactCount = close.filter((x) => x.s === 1).length;
  if (close.length === 1 || (best.s === 1 && exactCount === 1)) {
    return best.s < 0.75 ? { type: 'unsure', product: best.p, score: best.s } : { type: 'one', product: best.p, score: best.s };
  }
  return { type: 'many', candidates: close.slice(0, 5).map((x) => x.p) };
}

// Light heuristic, only used for fixed fallback messages (the AI itself detects language properly)
export function detectLang(text) {
  const raw = String(text || '').toLowerCase();
  const s = ' ' + raw.replace(/[^\p{L}\p{M}\s]/gu, ' ').replace(/\s+/g, ' ') + ' ';
  const score = { pcm: 0, yo: 0, ig: 0, ha: 0 };
  const hit = (lang, words) => words.forEach((w) => { if (s.includes(` ${w} `)) score[lang] += 1; });
  hit('pcm', ['abeg', 'wetin', 'dey', 'wahala', 'una', 'sef', 'oga', 'wey', 'pikin', 'sabi', 'no be', 'make i', 'how far', 'e don', 'na']);
  hit('yo', ['jọwọ', 'jowo', 'mo fẹ', 'mo fe', 'owó', 'ọjà', 'bawo', 'ẹ jọ̀wọ́', 'ṣe', 'kí ni', 'melo ni', 'mi o', 'ẹ ṣé']);
  hit('ig', ['biko', 'nke', 'ahia', 'ahịa', 'ego', 'kedu', 'nna', 'ndo', 'daalụ', 'daalu', 'ọnụ ahịa', 'onu ahia', 'achọrọ m', 'acho m']);
  hit('ha', ['don allah', 'nawa', 'kudi', 'kuɗi', 'ina', 'yaya', 'sannu', 'wannan', 'kuma', 'nake', 'ina son']);
  if (/[ịụ]/.test(raw)) score.ig += 2;
  if (/[ẹṣ]/.test(raw)) score.yo += 2;
  if (/[ɗƙɓƴ]/.test(raw)) score.ha += 2;
  if (/ọ/.test(raw)) { score.yo += 0.5; score.ig += 0.5; }
  const [lang, best] = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best >= 1 ? lang : 'en';
}

// Lagos has no daylight saving: always UTC+1. Returns { date: 'YYYY-MM-DD', hour: 0-23, weekday: 0-6 (Sun=0) }
export function lagosNow(d = new Date()) {
  const l = new Date(d.getTime() + 3600 * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  return { date: `${l.getUTCFullYear()}-${p2(l.getUTCMonth() + 1)}-${p2(l.getUTCDate())}`, hour: l.getUTCHours(), weekday: l.getUTCDay() };
}
