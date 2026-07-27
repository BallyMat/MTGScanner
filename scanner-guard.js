/* Garde-fous de reconnaissance : ne jamais proposer une carte sur un OCR douteux. */
function normalizeCardText(value) {
  return (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const saved = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + cost);
      previous = saved;
    }
  }
  return row[n];
}

function titleSimilarity(a, b) {
  const left = normalizeCardText(a);
  const right = normalizeCardText(b);
  if (!left || !right) return 0;
  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

const originalRecognizeFrame = recognizeFrame;
recognizeFrame = async function guardedRecognizeFrame(canvas) {
  const result = await originalRecognizeFrame(canvas);
  result.titleCandidates = (result.titleCandidates || [])
    .map(title => title.replace(/\b[A-Z0-9]{5,}\b/g, '').replace(/\s+/g, ' ').trim())
    .filter(title => {
      const normalized = normalizeCardText(title);
      const letters = (normalized.match(/[a-z]/g) || []).length;
      const digits = (normalized.match(/[0-9]/g) || []).length;
      return normalized.length >= 3 && normalized.length <= 40 && letters >= 3 && digits <= 2;
    });
  return result;
};

findCandidates = async function guardedFindCandidates(signals) {
  for (const rawTitle of (signals.titleCandidates || []).slice(0, 4)) {
    const title = rawTitle.trim();
    const response = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(title)}`);
    if (!response.ok) continue;
    const base = await response.json();
    const similarity = titleSimilarity(title, base.name);

    // Un résultat fuzzy ne suffit pas : le nom retourné doit réellement ressembler au texte lu.
    const minimum = title.length <= 6 ? 0.72 : 0.62;
    if (similarity < minimum) continue;

    const cards = [];
    let next = base.prints_search_uri;
    while (next) {
      const page = await fetch(next);
      if (!page.ok) break;
      const data = await page.json();
      cards.push(...(data.data || []));
      next = data.has_more ? data.next_page : null;
    }
    if (cards.length) return { base, candidates: cards, titleSimilarity: similarity };
  }
  return null;
};

// Masque tout ancien résultat lorsqu'une nouvelle analyse commence.
const originalSetScannerState = setScannerState;
setScannerState = function guardedScannerState(state, text) {
  originalSetScannerState(state, text);
  if (state === 'processing') {
    els.resultsCard?.classList.add('hidden');
    if (els.lastDetection) {
      els.lastDetection.classList.add('hidden');
      els.lastDetection.innerHTML = '';
    }
  }
};