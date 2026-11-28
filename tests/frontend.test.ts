/**
 * Тесты фронта без зависимостей: node --experimental-strip-types --test.
 *
 * Покрывает чистую логику, которую легко сломать при правках: горячие
 * клавиши (пересечения, формирование комбинации) и сортировку/крошки.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { eventToCombo, prettyCombo, conflictOf, DEFAULT_KEYS } from "../src/hooks/useKeymap.ts";
import { compareEntries, buildCrumbs, baseName, iconFor } from "../src/format.ts";
import { fmtSizeWith } from "../src/format.ts";
import { applyQuickFilter, isFilterActive, DEFAULT_QUICK } from "../src/hooks/useSearch.ts";
import { dict } from "../src/i18n.ts";
import type { ActionName, Entry } from "../src/types.ts";

type Combo = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

const combo = (c: Combo) => eventToCombo(c as unknown as KeyboardEvent);

// ---------- словари ----------

test("ru и en содержат одинаковые ключи", () => {
  const ruKeys = Object.keys(dict.ru).sort();
  const enKeys = Object.keys(dict.en).sort();
  assert.deepEqual(enKeys, ruKeys);
});

test("нет пустых переводов", () => {
  for (const lang of ["ru", "en"] as const) {
    for (const [k, v] of Object.entries(dict[lang])) {
      assert.ok(String(v).length > 0, `${lang}.${k} пустой`);
    }
  }
});

// ---------- горячие клавиши ----------

test("каждое действие имеет сочетание по умолчанию", () => {
  const actions: ActionName[] = [
    "newTab", "closeTab", "nextTab", "prevTab", "focusOtherPane", "toggleDualPane",
    "newWindow", "newFolder", "goUp", "goBack", "goForward", "openEntry", "rename",
    "trash", "selectAll", "copy", "cut", "paste", "focusSearch", "help", "refresh",
    "toggleHidden",
  ];
  for (const a of actions) {
    assert.ok(DEFAULT_KEYS[a], `нет умолчания для ${a}`);
  }
});

test("у сочетаний по умолчанию нет пересечений", () => {
  const seen = new Map<string, ActionName>();
  for (const [action, binding] of Object.entries(DEFAULT_KEYS) as [ActionName, string][]) {
    const prev = seen.get(binding);
    assert.equal(prev, undefined, `пересечение ${binding}: ${prev} и ${action}`);
    seen.set(binding, action);
  }
});

test("conflictOf находит занятое действие", () => {
  const keys = { ...DEFAULT_KEYS, copy: "cmd+shift+z" };
  assert.equal(conflictOf(keys, "cut", "cmd+shift+z"), "copy");
  assert.equal(conflictOf(keys, "paste", "cmd+shift+q"), null);
});

test("eventToCombo собирает комбинацию", () => {
  assert.equal(combo({ key: "T", metaKey: true }), "cmd+t");
  assert.equal(combo({ key: "ArrowLeft", metaKey: true, altKey: true }), "cmd+alt+ArrowLeft");
  assert.equal(combo({ key: "F2" }), "F2");
  assert.equal(combo({ key: "Backspace", metaKey: true, ctrlKey: true }), "cmd+ctrl+Backspace");
});

test("одиночный модификатор — не комбинация", () => {
  assert.equal(combo({ key: "Meta", metaKey: true }), "");
  assert.equal(combo({ key: "Shift", shiftKey: true }), "");
});

test("prettyCombo рисует символы macOS", () => {
  assert.equal(prettyCombo("cmd+shift+t"), "⌘⇧T");
  assert.equal(prettyCombo("cmd+alt+ArrowLeft"), "⌘⌥←");
  assert.equal(prettyCombo("f2"), "F2");
});

// ---------- сортировка ----------

const mk = (name: string, opts: Partial<Entry> = {}): Entry => ({
  name,
  path: `/x/${name}`,
  is_dir: false,
  is_symlink: false,
  size: 0,
  modified: 0,
  extension: null,
  is_hidden: false,
  ...opts,
});

test("папки всегда идут первыми", () => {
  const list = [mk("b.txt"), mk("a", { is_dir: true }), mk("c.txt")];
  const sorted = [...list].sort(compareEntries("name", 1));
  assert.deepEqual(sorted.map((e) => e.name), ["a", "b.txt", "c.txt"]);
});

test("числовое сравнение имён: file2 раньше file10", () => {
  const list = [mk("file10.txt"), mk("file2.txt")];
  const sorted = [...list].sort(compareEntries("name", 1));
  assert.deepEqual(sorted.map((e) => e.name), ["file2.txt", "file10.txt"]);
});

test("сортировка по размеру и дате учитывает направление", () => {
  const list = [mk("small", { size: 10 }), mk("big", { size: 1000 })];
  assert.deepEqual(
    [...list].sort(compareEntries("size", -1)).map((e) => e.name),
    ["big", "small"],
  );
  assert.deepEqual(
    [...list].sort(compareEntries("size", 1)).map((e) => e.name),
    ["small", "big"],
  );

  const dated = [mk("old", { modified: 100 }), mk("new", { modified: 900 })];
  assert.deepEqual(
    [...dated].sort(compareEntries("date", -1)).map((e) => e.name),
    ["new", "old"],
  );
});

test("сортировка не мутирует исходный массив", () => {
  const list = [mk("b"), mk("a")];
  [...list].sort(compareEntries("name", 1));
  assert.deepEqual(list.map((e) => e.name), ["b", "a"]);
});

// ---------- пути ----------

test("buildCrumbs разбивает путь", () => {
  assert.deepEqual(buildCrumbs("/Users/alex/docs"), [
    { label: "/", path: "/" },
    { label: "Users", path: "/Users" },
    { label: "alex", path: "/Users/alex" },
    { label: "docs", path: "/Users/alex/docs" },
  ]);
});

test("buildCrumbs на корне", () => {
  assert.deepEqual(buildCrumbs("/"), [{ label: "/", path: "/" }]);
  assert.deepEqual(buildCrumbs(undefined), []);
});

test("baseName берёт последний сегмент", () => {
  assert.equal(baseName("/a/b/c.txt"), "c.txt");
  assert.equal(baseName("/"), "");
});

test("iconFor различает типы", () => {
  assert.equal(iconFor(mk("d", { is_dir: true })), "📁");
  assert.equal(iconFor(mk("a.png", { extension: "png" })), "🖼");
  assert.equal(iconFor(mk("a.zip", { extension: "zip" })), "📦");
  assert.equal(iconFor(mk("a.rs", { extension: "rs" })), "📄");
  assert.equal(iconFor(mk("a.bin", { extension: "bin" })), "📃");
});

// ---------- предпросмотр (этап 4) ----------

test("все новые ключи предпросмотра есть в обоих языках", () => {
  const keys = [
    "preview", "previewEmpty", "previewFolderHint", "kindImage", "kindPdf", "kindText",
    "kindBinary", "kindDirectory", "kindSymlink", "kindOther", "pages", "pagesUnknown",
    "tooLarge", "loadAnyway", "shown", "of", "noPreviewBinary", "infoKind", "infoSize",
    "infoDimensions", "infoModified", "infoCreated", "infoLocation", "px",
    "notApplicable", "togglePreview", "actionTogglePreview",
  ] as const;
  for (const k of keys) {
    assert.ok(dict.ru[k], `ru.${k} отсутствует`);
    assert.ok(dict.en[k], `en.${k} отсутствует`);
  }
});

test("хоткей предпросмотра есть и не конфликтует", () => {
  assert.equal(DEFAULT_KEYS.togglePreview, "cmd+i");
  assert.equal(conflictOf(DEFAULT_KEYS, "togglePreview", "cmd+i"), null);
  // И он не совпадает ни с одним другим действием.
  const others = (Object.entries(DEFAULT_KEYS) as [ActionName, string][])
    .filter(([a]) => a !== "togglePreview")
    .map(([, v]) => v);
  assert.ok(!others.includes("cmd+i"), "cmd+i занят другим действием");
});

test("размеры форматируются по единицам словаря", () => {
  const fmt = fmtSizeWith(dict.ru);
  assert.equal(fmt(null), "");
  assert.ok(fmt(512).includes(dict.ru.b), "байты");
  assert.ok(fmt(2048).includes(dict.ru.kb), "килобайты");
  assert.ok(fmt(5 * 1024 * 1024).includes(dict.ru.mb), "мегабайты");
});

test("крупные размеры не дают NaN", () => {
  const fmt = fmtSizeWith(dict.ru);
  for (const n of [0, 1, 1023, 1024, 1048576, 1073741824, 5 * 1099511627776]) {
    const out = fmt(n);
    assert.ok(!out.includes("NaN"), `NaN на ${n}: ${out}`);
    assert.ok(out.length > 0);
  }
});

// ---------- фильтрация (этап 5) ----------

const NOW = 1_800_000_000; // фиксированное «сейчас» для детерминизма
const DAY = 86400;

const mkE = (name: string, opts: Partial<Entry> = {}): Entry => ({
  name,
  path: `/x/${name}`,
  is_dir: false,
  is_symlink: false,
  size: 100,
  modified: NOW - 1000, // свежий
  extension: name.includes(".") ? name.split(".").pop()!.toLowerCase() : null,
  is_hidden: false,
  ...opts,
});

test("фильтр по расширению не трогает папки", () => {
  const list = [
    mkE("a.png"),
    mkE("b.jpg"),
    mkE("dir", { is_dir: true, extension: null }),
  ];
  const out = applyQuickFilter(list, { ...DEFAULT_QUICK, ext: "png" }, NOW);
  assert.deepEqual(out.map((e) => e.name), ["a.png"], "папка не имеет типа файла");
});

test("расширение с точкой и в верхнем регистре", () => {
  const list = [mkE("a.PNG"), mkE("b.jpg")];
  assert.deepEqual(
    applyQuickFilter(list, { ...DEFAULT_QUICK, ext: ".PNG" }, NOW).map((e) => e.name),
    ["a.PNG"],
  );
});

test("фильтр по минимальному размеру", () => {
  const list = [
    mkE("small.bin", { size: 100 }),
    mkE("big.bin", { size: 5000 }),
  ];
  const out = applyQuickFilter(list, { ...DEFAULT_QUICK, minSize: 1000 }, NOW);
  assert.deepEqual(out.map((e) => e.name), ["big.bin"]);
});

test("фильтр по размеру исключает папки", () => {
  // Размер каталога неизвестен — показывать его при фильтре по размеру
  // значило бы противоречить фильтру.
  const list = [mkE("dir", { is_dir: true, size: null, extension: null }), mkE("f.bin", { size: 5000 })];
  const out = applyQuickFilter(list, { ...DEFAULT_QUICK, minSize: 1000 }, NOW);
  assert.deepEqual(out.map((e) => e.name), ["f.bin"]);
});

test("фильтр по периоду: сутки", () => {
  const list = [
    mkE("fresh.txt", { modified: NOW - 3600 }),
    mkE("old.txt", { modified: NOW - 3 * DAY }),
  ];
  assert.deepEqual(
    applyQuickFilter(list, { ...DEFAULT_QUICK, period: "day" }, NOW).map((e) => e.name),
    ["fresh.txt"],
  );
});

test("фильтр по периоду: неделя включает сутки", () => {
  const list = [
    mkE("h.txt", { modified: NOW - 3600 }),
    mkE("d3.txt", { modified: NOW - 3 * DAY }),
    mkE("d10.txt", { modified: NOW - 10 * DAY }),
  ];
  assert.deepEqual(
    applyQuickFilter(list, { ...DEFAULT_QUICK, period: "week" }, NOW).map((e) => e.name),
    ["h.txt", "d3.txt"],
  );
});

test("период all не фильтрует по дате", () => {
  const list = [mkE("ancient.txt", { modified: NOW - 3650 * DAY })];
  assert.equal(applyQuickFilter(list, DEFAULT_QUICK, NOW).length, 1);
});

test("фильтр по типу: только файлы / только папки", () => {
  const list = [mkE("f.txt"), mkE("dir", { is_dir: true, extension: null })];
  assert.deepEqual(
    applyQuickFilter(list, { ...DEFAULT_QUICK, kind: "files" }, NOW).map((e) => e.name),
    ["f.txt"],
  );
  assert.deepEqual(
    applyQuickFilter(list, { ...DEFAULT_QUICK, kind: "dirs" }, NOW).map((e) => e.name),
    ["dir"],
  );
});

test("несколько фильтров одновременно", () => {
  const list = [
    mkE("keep.png", { size: 5000, modified: NOW - 3600 }),
    mkE("small.png", { size: 10, modified: NOW - 3600 }),
    mkE("old.png", { size: 5000, modified: NOW - 100 * DAY }),
    mkE("keep.jpg", { size: 5000, modified: NOW - 3600 }),
  ];
  const out = applyQuickFilter(
    list,
    { ext: "png", minSize: 1000, maxSize: null, period: "day", kind: "files" },
    NOW,
  );
  assert.deepEqual(out.map((e) => e.name), ["keep.png"]);
});

test("пустой фильтр возвращает всё", () => {
  const list = [mkE("a.txt"), mkE("b.png"), mkE("d", { is_dir: true, extension: null })];
  assert.equal(applyQuickFilter(list, DEFAULT_QUICK, NOW).length, 3);
});

test("фильтр не мутирует исходный массив", () => {
  const list = [mkE("a.png"), mkE("b.jpg")];
  const copy = [...list];
  applyQuickFilter(list, { ...DEFAULT_QUICK, ext: "png" }, NOW);
  assert.deepEqual(list, copy);
});

test("isFilterActive различает состояния", () => {
  assert.equal(isFilterActive(DEFAULT_QUICK), false);
  assert.equal(isFilterActive({ ...DEFAULT_QUICK, ext: "png" }), true);
  assert.equal(isFilterActive({ ...DEFAULT_QUICK, minSize: 100 }), true);
  assert.equal(isFilterActive({ ...DEFAULT_QUICK, period: "day" }), true);
  assert.equal(isFilterActive({ ...DEFAULT_QUICK, kind: "files" }), true);
  assert.equal(isFilterActive({ ...DEFAULT_QUICK, ext: "   " }), false, "пробелы не считаются");
});

test("запись без даты не проходит фильтр по периоду", () => {
  const list = [mkE("nodate.txt", { modified: null })];
  assert.equal(applyQuickFilter(list, { ...DEFAULT_QUICK, period: "year" }, NOW).length, 0);
});
