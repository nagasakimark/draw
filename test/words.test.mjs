import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, buildPool, canon, guessResult, editDistance, ALL_DECK_ID } from "../docs/js/words.js";

const docs = path.join(path.dirname(fileURLToPath(import.meta.url)), "../docs");
const readJson = async (url) => JSON.parse(await readFile(path.join(docs, url.replace(/^\.\//, "")), "utf8"));
const catalog = await loadCatalog(readJson);
const deck = (id) => catalog.decks.find((d) => d.id === id);
const poolWords = (ids) => buildPool(catalog, ids).map((w) => w.english.toLowerCase());

test("catalog loads the decks", () => {
  assert.ok(catalog.decks.length >= 45);
  assert.ok(deck(ALL_DECK_ID).words.length > 1000);
  assert.equal(catalog.decks[0].id, ALL_DECK_ID, "'all' is listed first");
});

test("a category's own title is never offered as a word", () => {
  const cases = {
    subjects: "subjects",
    animals: "animals",
    jobs: "jobs",
    food: "food",
    school: "school",
    town: "town",
    colors: "colors",
    numbers: "numbers",
    months: "months",
    "days-of-the-week": "days",
    dates: "date",
    "fruits-and-vegetables": "fruit",
    "sea-animals": "sea animals",
    "club-activities": "club activities",
    "school-events": "school events"
  };
  for (const [id, title] of Object.entries(cases)) {
    assert.ok(deck(id), `deck ${id} exists`);
    assert.ok(deck(id).words.some((w) => w.english.toLowerCase() === title), `${id} really has a "${title}" entry`);
    assert.ok(!poolWords([id]).includes(title), `${id} pool must not contain "${title}"`);
  }
  assert.ok(!poolWords(["fruits-and-vegetables"]).includes("vegetables"));
});

test("real words in the same decks are kept", () => {
  assert.ok(poolWords(["subjects"]).includes("arts and crafts"));
  assert.ok(poolWords(["animals"]).includes("elephant"));
  assert.ok(poolWords(["days-of-the-week"]).includes("monday"));
  assert.ok(poolWords(["months"]).includes("april"));
  assert.ok(poolWords(["fruits-and-vegetables"]).includes("apple"));
});

test("a title only counts as a title inside its own category", () => {
  // "drink" is a verb in Present Tense even though "Drinks" is a category of its own.
  const drink = deck("present-tense").words.find((w) => w.english.toLowerCase() === "drink");
  assert.ok(drink, "Present Tense has a drink entry");
  assert.equal(drink.header, false);
  assert.ok(poolWords(["present-tense"]).includes("drink"));
  assert.ok(!poolWords(["drinks"]).includes("drinks"));
});

test("the 'all' deck drops every category title too", () => {
  const all = poolWords([ALL_DECK_ID]);
  for (const bad of ["animals", "subjects", "jobs", "world", "clothes", "food", "days", "fruit", "vegetables"]) {
    assert.ok(!all.includes(bad), `all pool must not contain "${bad}"`);
  }
  assert.ok(all.includes("elephant"));
});

test("pool is de-duplicated across decks", () => {
  const pool = buildPool(catalog, ["animals", "sea-animals", ALL_DECK_ID]);
  const keys = pool.map((w) => canon(w.english));
  assert.equal(new Set(keys).size, keys.length);
});

test("no deck is left with an unusable pool", () => {
  for (const d of catalog.decks) {
    assert.ok(buildPool(catalog, [d.id]).length >= 2, `${d.id} has at least 2 playable words`);
  }
});

test("guess matching", () => {
  assert.equal(guessResult("Cat", "cat"), "correct");
  assert.equal(guessResult("  the cat ", "cat"), "correct");
  assert.equal(guessResult("a cat", "cat"), "correct");
  assert.equal(guessResult("cats", "cat"), "correct");
  assert.equal(guessResult("cat", "cats"), "correct");
  assert.equal(guessResult("icecream", "ice cream"), "correct");
  assert.equal(guessResult("Ice-Cream!", "ice cream"), "correct");
  assert.equal(guessResult("potatoes", "potato"), "correct");
  assert.equal(guessResult("glasses", "glass"), "correct");
  assert.equal(guessResult("elefhant", "elephant"), "close");
  assert.equal(guessResult("elefant", "elephant"), "wrong", "two edits away is not close");
  assert.equal(guessResult("elephnat", "elephant"), "close");
  assert.equal(guessResult("dog", "cat"), "wrong");
  assert.equal(guessResult("", "cat"), "wrong");
  assert.equal(guessResult("bat", "cat"), "wrong", "3-letter words do not get 'close'");
});

test("edit distance", () => {
  assert.equal(editDistance("kitten", "sitting"), 3);
  assert.equal(editDistance("ab", "ba"), 1);
});
