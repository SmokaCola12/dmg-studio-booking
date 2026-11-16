// Reads the reference number, amount and date out of the TEXT of a GCash receipt (what OCR gives us).
// Pure: no browser or DOM use, so it also runs under `node --test`.
// These are hints for the customer and the staff. Nothing here proves a payment; it is better to return
// nothing than a wrong reference.

const REF_LENGTH = 13; // GCash reference numbers are 13 digits

// Letters OCR commonly gives where a digit was printed. Only applied inside a digit run next to the "Ref No." label.
// Keep this file free of regex lookbehind (Safari before 16.4 fails to parse the whole script).
const LOOKALIKE = { O: '0', o: '0', Q: '0', D: '0', I: '1', l: '1', '|': '1', i: '1', S: '5', s: '5', B: '8', Z: '2', z: '2' };

const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';

/** Same-looking characters from other alphabets and odd spaces, turned into plain ones. */
function clean(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[  -​ 　]/g, ' ')
    .replace(/[оο]/g, 'o') // Cyrillic and Greek o
    .replace(/[ОΟ]/g, 'O')
    .replace(/[е]/g, 'e')
    .replace(/[‐-―]/g, '-');
}

/**
 * One chunk of a reference: digits, with look-alike letters among at least one real digit.
 * Returns { digits, letters } or null when the chunk is anything else.
 */
function chunk(token) {
  if (!token || !/\d/.test(token)) return null;
  let letters = 0;
  let digits = '';
  for (const ch of token) {
    if (ch >= '0' && ch <= '9') digits += ch;
    else if (LOOKALIKE[ch]) {
      digits += LOOKALIKE[ch];
      letters += 1;
    } else return null;
  }
  return { digits, letters };
}

const unpunct = (token) => token.replace(/[.,;:]+$/, '');

/** Would this token carry on a number? Then the digits before it are not a whole reference. */
const digitLike = (token) => Boolean(token) && (/^[+\d]/.test(token) || chunk(unpunct(token)) !== null);

/**
 * A reference at the start of these tokens: one 13-digit chunk, or the 4-3-6 grouping GCash prints
 * ("5046 627 354816"). At most two look-alike letters in all. Returns { ref, used } or null.
 * Other groupings are refused: joining loose digit chunks is how a date or a phone number ends up in a reference.
 */
function refAt(tokens) {
  const shapes = [[REF_LENGTH], [4, 3, 6]];
  for (const shape of shapes) {
    if (tokens.length < shape.length) continue;
    let ref = '';
    let letters = 0;
    let ok = true;
    for (let i = 0; i < shape.length && ok; i += 1) {
      const c = chunk(i === shape.length - 1 ? unpunct(tokens[i]) : tokens[i]);
      if (!c || c.digits.length !== shape[i]) ok = false;
      else {
        ref += c.digits;
        letters += c.letters;
      }
    }
    if (ok && letters <= 2) return { ref, used: shape.length };
  }
  return null;
}

const LINE_PEEK = 80;
const lineAt = (text, from) => text.slice(from, from + LINE_PEEK).split('\n')[0];
const words = (line) => line.split(/[ \t]+/).filter(Boolean);

/**
 * The reference next to a "Ref No." label.
 * found: a label is in the text at all. ref: its 13 digits, '' when not sure (also when two labels disagree).
 */
function labelledRef(text) {
  // Spaces and tabs only: the label must not swallow a line break and read the next line as its value.
  const label = /\bR[e3]f(?:erence)?[ \t]*\.?[ \t]*(?:Num(?:ber)?|N[o0u]|#)?(?![a-z])[ \t]*\.?[ \t]*[:\-]?[ \t]*/gi;
  const refs = new Set();
  let found = false;
  let m;
  while ((m = label.exec(text))) {
    found = true;
    const end = m.index + m[0].length;
    const same = words(lineAt(text, end));
    if (same.length) {
      // On the label's line: the reference, then nothing that looks like more digits.
      const r = refAt(same);
      if (r && !digitLike(same[r.used])) refs.add(r.ref);
    } else if (text[end] === '\n') {
      // Label alone on its line: the next line counts only when the reference is all there is on it.
      const next = words(lineAt(text, end + 1));
      const r = refAt(next);
      if (r && r.used === next.length) refs.add(r.ref);
    }
  }
  return { found, ref: refs.size === 1 ? [...refs][0] : '' };
}

/** No label anywhere: a lone run of exactly 13 digits, only when there is just one such run in the text. */
function looseRef(text) {
  const found = new Set();
  // No lookbehind here: Safari before 16.4 cannot parse one. The character before the run is group 1.
  const run = /(^|[^\d+.,])(\d{13})(?![\d.,]\d|\d)/g;
  let m;
  while ((m = run.exec(text))) found.add(m[2]);
  return found.size === 1 ? [...found][0] : '';
}

function money(raw) {
  const fixed = raw.replace(/[Oo]/g, '0').replace(/[, ]/g, '');
  if (!/^\d{1,7}\.\d{2}$/.test(fixed)) return null;
  const n = Number(fixed);
  return n > 0 && n < 1_000_000 ? n : null;
}

function amountOf(text) {
  const num = '(\\d[\\d,Oo]{0,9}\\.[\\dOo]{2})(?!\\d)';
  const tries = [
    new RegExp(`Total\\s+Amount\\s+Sent[^\\d\\n]{0,10}${num}`, 'i'),
    new RegExp(`Total\\s+Amount[^\\d\\n]{0,10}${num}`, 'i'),
    new RegExp(`(?:^|\\n)[ \\t]*Amount(?!\\s+Due)[^\\d\\n]{0,10}${num}`, 'i'),
    new RegExp(`received\\s+(?:PHP|P|₱)\\s*${num}`, 'i'),
  ];
  for (const re of tries) {
    const m = re.exec(text);
    const n = m ? money(m[1]) : null;
    if (n !== null) return n;
  }
  return null;
}

function dateOf(text) {
  const m = new RegExp(`\\b(?:${MONTHS})[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{4}(?:,?\\s+\\d{1,2}:\\d{2}\\s*(?:AM|PM)?)?`, 'i').exec(text);
  return m ? m[0].replace(/\s+/g, ' ').trim() : '';
}

/**
 * @param {string} text what OCR read from the screenshot
 * @returns {{ ref: string, amount: number|null, dateText: string }} ref is digits only, '' when not sure
 */
export function parseGcashReceipt(text) {
  const t = clean(text);
  const labelled = labelledRef(t);
  // The loose guess is only for text with no "Ref" label at all. A label with another value next to it means: not sure.
  return { ref: labelled.found ? labelled.ref : looseRef(t), amount: amountOf(t), dateText: dateOf(t) };
}

/** 210 -> "210.00", for the X-Receipt-Amount header. '' when there is no amount. */
export const amountText = (amount) => (typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? amount.toFixed(2) : '');
