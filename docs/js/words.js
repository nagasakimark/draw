/**
 * Vocabulary loading, category-title filtering and guess matching.
 * No DOM access, so it runs in the browser and in Node tests.
 */

export const PICTURE_DICTIONARY_NAME = "My Picture Dictionary";
export const ALL_DECK_ID = "all";

const DECK_PATH_ALIASES = {
  "assets/vocab/NH5/alphabet.json": "",
  "assets/vocab/PD/SchoolEvents.json": "assets/vocab/PD/schoolevents.json",
  "assets/vocab/PD/ClubActivities.json": "assets/vocab/PD/clubactivities.json",
  "assets/vocab/PD/SeaAnimals.json": "assets/vocab/PD/seaanimals.json",
  "assets/vocab/PD/PastTense.json": "assets/vocab/PD/pasttense.json",
  "assets/vocab/PD/body.json/": "assets/vocab/PD/body.json"
};

const IMAGE_PATH_ALIASES = {
  "assets/images/categories/jobs/Zookeeper.jpg": "assets/images/categories/Jobs/Zookeeper.jpg"
};

/**
 * Entries that act as a category heading but are not named after the deck, so the
 * generic rules below cannot see them. Keyed by canonical deck name.
 */
const EXTRA_HEADER_WORDS = new Map([
  ["Days of the Week", ["days"]],
  ["Fruits and Vegetables", ["fruit", "vegetables"]]
]);

export function slug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function cleanAssetPath(path) {
  return String(path || "").replace(/^\/+/, "").replace(/\/+$/, "").replace(/%20/g, " ");
}

export function normalizeDeckPath(path) {
  const cleaned = cleanAssetPath(path);
  return Object.hasOwn(DECK_PATH_ALIASES, cleaned) ? DECK_PATH_ALIASES[cleaned] : cleaned;
}

export function normalizeImagePath(path) {
  const cleaned = cleanAssetPath(path);
  return IMAGE_PATH_ALIASES[cleaned] ?? cleaned;
}

export function toStaticAssetUrl(path) {
  const cleaned = normalizeImagePath(path);
  return cleaned ? `./${cleaned.replace(/ /g, "%20")}` : "";
}

/* ------------------------------------------------------------------ */
/* Text normalisation and guess matching                               */
/* ------------------------------------------------------------------ */

function singularLastWord(text) {
  const words = text.split(" ");
  let last = words[words.length - 1];
  if (last.length > 3 && last.endsWith("ies")) {
    last = `${last.slice(0, -3)}y`;
  } else if (last.length > 3 && /(oes|ses|xes|zes|ches|shes)$/.test(last)) {
    last = last.slice(0, -2);
  } else if (last.length > 2 && last.endsWith("s") && !last.endsWith("ss")) {
    last = last.slice(0, -1);
  }
  words[words.length - 1] = last;
  return words.join(" ");
}

/** Lower-case, drop punctuation and leading articles, ignore a trailing plural "s". */
export function canon(value) {
  let text = String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(a|an|the) /, "");
  text = singularLastWord(text);
  return text;
}

function canonTight(value) {
  return canon(value).replace(/ /g, "");
}

/** Optimal-string-alignment distance (insert/delete/replace/swap = 1). */
export function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) {
    d[i][0] = i;
  }
  for (let j = 0; j < cols; j += 1) {
    d[0][j] = j;
  }
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** @returns {"correct" | "close" | "wrong"} */
export function guessResult(guess, answer) {
  const g = canonTight(guess);
  const a = canonTight(answer);
  if (!g || !a) {
    return "wrong";
  }
  if (g === a) {
    return "correct";
  }
  if (a.length >= 4 && editDistance(g, a) === 1) {
    return "close";
  }
  return "wrong";
}

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

function imageFolderKey(image) {
  const parts = String(image || "").split("/");
  parts.pop();
  const folder = parts.pop() || "";
  return canon(folder.replace(/\+$/, ""));
}

function imageBaseKey(image) {
  const file = String(image || "").split("/").pop() || "";
  return canon(file.replace(/\.[a-z0-9]+$/i, ""));
}

function headerKey(word) {
  return `${canon(word.english)}|${word.rawImage}`;
}

/**
 * Marks entries that are the *category itself* (the "Subjects" picture inside the
 * Subjects deck) so they are never offered as a word to draw.
 */
function markCategoryTitles(decks) {
  const known = new Set();
  const own = decks.filter((deck) => deck.id !== ALL_DECK_ID);

  for (const deck of own) {
    const names = new Set([canon(deck.name), canon(deck.title)].filter(Boolean));
    const extras = new Set((EXTRA_HEADER_WORDS.get(deck.name) || []).map(canon));
    for (const word of deck.words) {
      const byName = names.has(canon(word.english));
      const byImage = Boolean(word.rawImage) && imageBaseKey(word.rawImage) === imageFolderKey(word.rawImage);
      if (byName || byImage || extras.has(canon(word.english))) {
        known.add(headerKey(word));
      }
    }
  }

  for (const deck of decks) {
    for (const word of deck.words) {
      const byImage = Boolean(word.rawImage) && imageBaseKey(word.rawImage) === imageFolderKey(word.rawImage);
      word.header = known.has(headerKey(word)) || byImage;
    }
  }
}

/**
 * @param {(url: string) => Promise<any>} readJson
 * @param {string} [base]
 */
export async function loadCatalog(readJson, base = "./") {
  const manifest = await readJson(`${base}assets/vocab/decks.json`);
  const book = manifest[PICTURE_DICTIONARY_NAME];
  if (!book) {
    throw new Error(`Could not find "${PICTURE_DICTIONARY_NAME}" in decks.json.`);
  }

  const skipped = [];
  const loaded = await Promise.all(
    Object.entries(book.decks).map(async ([deckName, deckMeta]) => {
      const deckPath = normalizeDeckPath(deckMeta.path);
      if (!deckPath) {
        skipped.push(deckName);
        return null;
      }
      try {
        const raw = await readJson(base + deckPath);
        const items = Array.isArray(raw) ? raw : raw.items || [];
        const id = slug(deckName);
        const words = items
          .filter((item) => item && item.english)
          .map((item) => ({
            id: "",
            english: String(item.english).trim(),
            kanji: item.japanese?.kanji || "",
            furigana: item.japanese?.furigana || "",
            image: toStaticAssetUrl(item.image),
            rawImage: normalizeImagePath(item.image),
            header: false
          }));
        return {
          id,
          name: deckName,
          title: (!Array.isArray(raw) && raw.metadata?.title) || deckName,
          image: toStaticAssetUrl(deckMeta.image),
          words
        };
      } catch (error) {
        skipped.push(deckName);
        return null;
      }
    })
  );

  const decks = loaded.filter((deck) => deck && deck.words.length > 0);
  markCategoryTitles(decks);

  for (const deck of decks) {
    deck.words.forEach((word) => {
      word.id = slug(word.english) || word.english;
    });
    deck.playable = deck.words.filter((word) => !word.header).length;
  }

  decks.sort((a, b) => {
    if (a.id === ALL_DECK_ID) {
      return -1;
    }
    if (b.id === ALL_DECK_ID) {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });

  return { decks, skipped };
}

/** Union of the chosen decks, minus category titles, de-duplicated by spelling. */
export function buildPool(catalog, deckIds) {
  const wanted = new Set(deckIds);
  const seen = new Set();
  const pool = [];
  for (const deck of catalog.decks) {
    if (!wanted.has(deck.id)) {
      continue;
    }
    for (const word of deck.words) {
      const key = canon(word.english);
      if (word.header || seen.has(key)) {
        continue;
      }
      seen.add(key);
      pool.push({
        id: word.id,
        english: word.english,
        kanji: word.kanji,
        furigana: word.furigana,
        image: word.image
      });
    }
  }
  return pool;
}
