import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Юнит-тесты структурных правил компонентов (задача 5.12).
 *
 * Источник истины — `frontend/src/styles/global.css` (финализирован задачами
 * 5.1–5.9). Тест читает файл как текст и проверяет НАЛИЧИЕ структурных правил,
 * не зависящих от конкретных значений токенов:
 *  - кнопки `.btn` имеют правила `:hover`/`:active`/`:disabled` и `min-height: 44px`;
 *  - отключённое поле `.field__input:disabled` отличается ОДНОВРЕМЕННО фоном И цветом;
 *  - запись `.task-record__desc` ограничена двумя строками;
 *  - таблица `.data-table` имеет разделители строк и фон при `tr:hover`;
 *  - модальное окно `.modal` использует тень `--shadow-popover`;
 *  - активная вкладка `.tab.is-active` и активная ссылка sidebar
 *    усиленно выделены (цвет + граница).
 *
 * Requirements: 6.1, 6.3, 6.4, 7.3, 8.1, 8.4, 8.5, 10.3, 10.4, 11.1, 11.6, 12.1, 13.1, 13.2
 */

const cssPath = join(dirname(fileURLToPath(import.meta.url)), "global.css");
// Удаляем комментарии, чтобы упоминания селекторов в пояснениях не мешали поиску.
const css = readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Извлекает тело правила по точному селектору (текст между `{` и парной `}`).
 * Селектор сопоставляется как часть списка селекторов перед блоком (с границами,
 * чтобы `.btn` не совпадал с `.btn--primary`, а `.modal` — с `.modal-overlay`),
 * что корректно находит и группы вида `.data-table th, .data-table td { … }`.
 * Падает с понятным сообщением, если правило не найдено.
 */
function ruleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Граница после селектора: не буква/цифра/`_`/`-`, чтобы исключить продолжения
  // имени класса (`.btn` ≠ `.btn--sm`, `.modal` ≠ `.modal-overlay`).
  const selectorRe = new RegExp(`${escaped}(?![\\w-])`);
  const blockRe = /(?:^|[};])\s*([^{}]*?)\{/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(source)) !== null) {
    if (selectorRe.test(match[1]!)) {
      const open = source.indexOf("{", match.index);
      let depth = 0;
      for (let i = open; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            return source.slice(open + 1, i);
          }
        }
      }
    }
  }
  throw new Error(`В global.css не найдено правило для селектора: ${selector}`);
}

/** Возвращает значение свойства `prop` из тела правила или `null`. */
function declValue(body: string, prop: string): string | null {
  const re = new RegExp(`(?:^|[;{])\\s*${prop}\\s*:\\s*([^;]+);`, "m");
  const match = body.match(re);
  return match ? match[1]!.trim() : null;
}

describe("Структурные правила компонентов в global.css", () => {
  describe("Кнопки (Req 6.1, 6.3, 6.4)", () => {
    it("базовая кнопка задаёт min-height: 44px", () => {
      const body = ruleBody(css, ".btn");
      expect(declValue(body, "min-height")).toBe("44px");
    });

    it("есть правило наведения :hover (Req 6.1)", () => {
      expect(/\.btn:hover/.test(css)).toBe(true);
    });

    it("есть правило нажатия :active (Req 6.3)", () => {
      expect(/\.btn:active/.test(css)).toBe(true);
    });

    it("есть правило отключения :disabled с cursor:not-allowed (Req 6.4)", () => {
      const body = ruleBody(css, ".btn:disabled");
      expect(declValue(body, "cursor")).toBe("not-allowed");
    });
  });

  describe("Поля форм (Req 7.3)", () => {
    it("отключённое поле отличается ОДНОВРЕМЕННО фоном И цветом", () => {
      const body = ruleBody(css, ".field__input:disabled");
      expect(declValue(body, "background")).not.toBeNull();
      expect(declValue(body, "color")).not.toBeNull();
    });
  });

  describe("Реестр задач (Req 8.1, 8.4, 8.5)", () => {
    it("описание записи ограничено двумя строками", () => {
      const body = ruleBody(css, ".task-record__desc");
      expect(declValue(body, "-webkit-line-clamp")).toBe("2");
      expect(declValue(body, "line-clamp")).toBe("2");
    });

    it("запись оформлена рамкой 1px (Req 8.1)", () => {
      const body = ruleBody(css, ".task-record");
      expect(declValue(body, "border")).toMatch(/1px/);
    });

    it("наведение на интерактивную запись меняет границу без декоративной тени", () => {
      const body = ruleBody(css, ".task-record:hover");
      const changesBorder = declValue(body, "border-color") !== null;
      expect(changesBorder).toBe(true);
      expect(declValue(body, "box-shadow")).toBeNull();
    });
  });

  describe("Адаптивные контейнеры", () => {
    it("основной контент и секции могут сжиматься без горизонтального overflow", () => {
      expect(declValue(ruleBody(css, ".app-main"), "min-width")).toBe("0");
      expect(declValue(ruleBody(css, ".page-section"), "min-width")).toBe("0");
      expect(declValue(ruleBody(css, ".stack"), "min-width")).toBe("0");
    });

    it("панели и карточки ограничены шириной своего контейнера", () => {
      const body = ruleBody(css, ".panel");
      expect(declValue(body, "min-width")).toBe("0");
      expect(declValue(body, "max-width")).toBe("100%");
    });

    it("мобильные элементы действий используют актуальные селекторы вместо удалённых task-record actions", () => {
      const mobileBlock = css.slice(css.indexOf("@media (max-width: 768px)"));
      expect(mobileBlock).toContain(".page-head__actions .btn");
      expect(mobileBlock).toContain(".status-strip__buttons .btn");
      expect(mobileBlock).not.toContain(".task-record__actions button");
    });

    it("кнопка редактирования в hero выровнена по высоте со статусными контролами", () => {
      expect(
        /(?:^|})\s*\.task-hero__edit\s*\{[^}]*min-height\s*:\s*40px;/s.test(
          css,
        ),
      ).toBe(true);
      expect(
        /(?:^|})\s*\.task-hero__edit\s*\{[^}]*align-self\s*:\s*start;/s.test(
          css,
        ),
      ).toBe(true);
    });
  });

  describe("Таблицы данных (Req 10.3, 10.4)", () => {
    it("строки разделены нижней границей (Req 10.3)", () => {
      const body = ruleBody(css, ".data-table td");
      expect(declValue(body, "border-bottom")).toMatch(/1px/);
    });

    it("табличные значения не дробят слова по буквам на мобильной ширине", () => {
      const body = ruleBody(css, ".data-table td");
      expect(declValue(body, "overflow-wrap")).toBe("normal");
      expect(declValue(body, "word-break")).toBe("normal");
      expect(declValue(body, "white-space")).toBe("nowrap");
    });

    it("журнал изменений прокручивается по горизонтали и переносит длинные значения", () => {
      expect(declValue(ruleBody(css, ".audit-panel"), "overflow-x")).toBe(
        "auto",
      );
      const valueCells = ruleBody(
        css,
        ".audit-panel .data-table td:nth-child(4)",
      );
      expect(declValue(valueCells, "white-space")).toBe("normal");
      expect(declValue(valueCells, "overflow-wrap")).toBe("anywhere");
      expect(css).toContain("@media (max-width: 1100px)");
      expect(
        declValue(
          ruleBody(css, ".audit-panel .data-table td::before"),
          "content",
        ),
      ).toBe("attr(data-label)");
    });

    it("наведение на строку даёт фон выделения (Req 10.4)", () => {
      const body = ruleBody(css, ".data-table tbody tr:hover");
      expect(declValue(body, "background")).not.toBeNull();
    });
  });

  describe("Модальные окна (Req 11.1, 11.6)", () => {
    it("окно использует тень всплывающего слоя --shadow-popover (Req 11.6)", () => {
      expect(
        /\.modal\s*(?:,\s*[^{}]+)?\{[^{}]*box-shadow\s*:\s*var\(--shadow-popover\)/s.test(
          css,
        ),
      ).toBe(true);
    });

    it("есть затемняющая подложка .modal-overlay (Req 11.1)", () => {
      const body = ruleBody(css, ".modal-overlay");
      expect(declValue(body, "background")).not.toBeNull();
      expect(declValue(body, "position")).toBe("fixed");
    });
  });

  describe("Вкладки (Req 12.1)", () => {
    it("активная вкладка выделена ОДНОВРЕМЕННО цветом и границей", () => {
      const body = ruleBody(css, ".tab.is-active");
      expect(declValue(body, "color")).not.toBeNull();
      const hasBorder =
        declValue(body, "border-color") !== null ||
        declValue(body, "border-top-color") !== null;
      expect(hasBorder).toBe(true);
    });
  });

  describe("Навигация (Req 13.1, 13.2)", () => {
    it("шапка липкая (sticky) (Req 13.1)", () => {
      const body = ruleBody(css, ".app-header");
      expect(declValue(body, "position")).toBe("sticky");
    });

    it("активная ссылка sidebar выделена цветом, фоном и границей (Req 13.2)", () => {
      const body = ruleBody(css, ".app-sidebar__nav a.is-active");
      expect(declValue(body, "color")).not.toBeNull();
      expect(declValue(body, "background")).not.toBeNull();
      expect(declValue(body, "border-color")).not.toBeNull();
    });
  });
});
