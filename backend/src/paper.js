// Compares the text read from a certificate photo (OCR) with the institution's signed record.
// The "scan the whole certificate" rule: the paper next to the QR must show the same name, roll number,
// marks and year as the signed record. Anything that contradicts it means a genuine QR was copied onto a
// fake certificate.
//
// Only the certificate page is trusted. Our verification page prints the genuine details too, so a faker
// could photograph that instead; if the text looks like the verification page we refuse to compare.

const CANON = {
  // Letters that OCR/print usually swaps with digits are canonicalised to the digit,
  // so O/0, Q/0 and I/1/l/L compare as equal instead of fighting each other.
  O: '0',
  Q: '0',
  '0': '0',
  I: '1',
  l: '1',
  L: '1',
  '1': '1',
};

// Maps a string to a canonical "visual" form so O/0, I/1 look identical before fuzzy matching.
function signature(s) {
  return String(s).toUpperCase().split('').map((ch) => CANON[ch] ?? ch).join('');
}

export function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  return dp[a.length][b.length];
}

// Lower/upper tokens of the OCR text, each in its visual form.
function tokens(text) {
  return String(text ?? '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ({ raw: t, sig: signature(t) }));
}

// Every word of the registered name must appear somewhere in the OCR text with ≤2 edits per word.
export function compareName(text, fullName) {
  const words = String(fullName ?? '').trim().split(/\s+/).filter(Boolean).map(signature);
  if (!words.length) return null;
  const hay = tokens(text);
  if (!hay.length) return null;
  const found = [];
  let allMatched = true;
  for (const w of words) {
    let best = null;
    let bestDist = Infinity;
    for (const t of hay) {
      const d = editDistance(w, t.sig);
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
    if (bestDist <= 2 && best) found.push(best.raw);
    else allMatched = false;
  }
  return { found: found.join(' '), match: allMatched };
}

const flatten = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const visual = (s) => signature(flatten(s));

// Normalised roll number: spaces, hyphens and case removed (and O/0, I/1 visual confusion), so
// "21 CSE-777", "21CSE777" and "21CSEO77" are the same.
export function compareRoll(text, rollNo) {
  const target = visual(rollNo);
  if (!target) return null;
  return { found: target, match: visual(text).includes(target) };
}

export function compareYear(text, year) {
  const target = String(year ?? '').trim();
  if (!target) return null;
  return { found: target, match: visual(text).includes(visual(target)) };
}

// ---- marks: "marks exact" plus conflict detection -------------------------
// A certificate may carry a percentage ("77%"), a CGPA ("8.5 CGPA", "CGPA 9.0") or a word ("First Class").
// Every numeric value we can read off the paper is compared with the signed record; anything that
// contradicts it is a conflict (a genuine QR pasted onto a fake grade sheet).
const MARK_PATTERNS = [
  { unit: '%', re: /(\d{1,3})\s?%/g, pick: (m) => Number(m[1]) },
  { unit: 'cgpa', re: /\b(?:CGPA|GPA|CPI)\b\s*[:：\-]?\s*(\d(?:\.\d+)?)/gi, pick: (m) => Number(m[1]) },
  { unit: 'cgpa', re: /\b(\d(?:\.\d+)?)\s*(?:CGPA|GPA|CPI)\b/gi, pick: (m) => Number(m[1]) },
];

function markCandidates(text) {
  const out = [];
  for (const { unit, re, pick } of MARK_PATTERNS) {
    for (const m of String(text).matchAll(re)) {
      out.push({ unit, value: pick(m), text: m[0].trim().replace(/\s*[:：\-]\s*/g, ' ') });
    }
  }
  return out;
}

// How a registry "marks" value is recorded: "77%", "8.5 CGPA"/"CGPA 9.0", a bare number ("90"), or a
// word ("First Class with Distinction"). Bare numbers are read as percentages, since that is how most
// certificates record marks and it makes "90" match the printed "90%" exactly.
function registryMarksValue(s) {
  const text = String(s ?? '').trim();
  if (!text) return null;
  const pct = text.match(/^\s*(\d{1,3}(?:\.\d+)?)\s*%\s*$/);
  if (pct) return { unit: '%', value: Number(pct[1]) };
  const cg = text.match(/\b(?:CGPA|GPA|CPI)\b\s*[:：\-]?\s*(\d(?:\.\d+)?)/i) || text.match(/\b(\d(?:\.\d+)?)\s*(?:CGPA|GPA|CPI)\b/i);
  if (cg) return { unit: 'cgpa', value: Number(cg[1]) };
  const bare = text.match(/^\d{1,3}(?:\.\d+)?$/);
  if (bare) return { unit: '%', value: Number(bare[0]) };
  return null;
}

export function compareMarks(text, registeredMarks) {
  const registered = String(registeredMarks ?? '').trim();
  if (!registered) return null;
  const registry = registryMarksValue(registered);
  const paperValues = markCandidates(text);

  // Non-numeric result ("First Class"): nothing numeric to compare, so the paper must contain the
  // registered wording verbatim. Show whatever numeric value the paper does carry as the paper's value.
  if (!registry) {
    const match = flatten(text).includes(flatten(registered));
    const shown = paperValues.map((p) => p.text);
    return { found: match ? registered : (shown.length ? shown.join(', ') : null), match, conflicts: [] };
  }

  let match = false;
  const conflicts = [];
  for (const p of paperValues) {
    if (p.unit === registry.unit && p.value === registry.value) match = true;
    else conflicts.push({ field: 'marks', label: 'Marks / result', paper: p.text, registry: registered });
  }
  const seen = new Set();
  const unique = conflicts.filter((c) => (seen.has(c.paper) ? false : seen.add(c.paper)));
  const shown = paperValues.map((p) => p.text);
  const found = shown.length ? shown.join(', ') : match ? registered : null;
  return { found, match, conflicts: unique };
}

const VERIFICATION_PAGE_MARKERS = ['certificate verification page'];

const FIELD_OF = { name: ['studentName', 'Student name'], roll: ['rollNo', 'Roll / register no.'], marks: ['marks', 'Marks / result'], year: ['graduationYear', 'Year of graduation'] };

// Full comparison of the OCR text against the signed record (studentName, rollNo, marks, graduationYear).
export function comparePaper(text, payload = {}) {
  const t = String(text ?? '');
  const verificationPage = VERIFICATION_PAGE_MARKERS.some((m) => t.toLowerCase().includes(m));
  const readable = t.replace(/\s+/g, ' ').trim().length >= 12;

  const compare = {
    name: compareName(t, payload.studentName),
    roll: compareRoll(t, payload.rollNo),
    marks: compareMarks(t, payload.marks),
    year: compareYear(t, payload.graduationYear),
  };
  const fields = Object.entries(FIELD_OF)
    .map(([field, [key, label]]) => {
      const row = compare[field];
      if (!row) return null;
      return { field, label, paper: row.found ?? null, registry: payload[key] == null ? null : String(payload[key]), match: row.match, conflicts: row.conflicts ?? [] };
    })
    .filter(Boolean);

  // Marks report their own conflicts (a 90% on the paper when the registry says 77%). Any other field that
  // does not match the signed record is equally damning: the details on the paper are not the genuine ones.
  const conflicts = [];
  for (const f of fields) {
    if (f.conflicts.length) conflicts.push(...f.conflicts);
    else if (!f.match) {
      conflicts.push({ field: f.field, label: f.label, paper: f.paper ?? 'not found on the certificate', registry: f.registry });
    }
  }

  return { readable, verificationPage, fields, conflicts };
}