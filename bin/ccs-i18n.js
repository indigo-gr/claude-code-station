/**
 * ccs-i18n.ts — the language of ccs's own text, and its string tables.
 *
 * Tables: bin/ccs-lang-<lang>.txt next to this file, one `key=text` per line
 * (`#` starts a comment line); `key+=text` adds one more line to the key above
 * (for long texts such as --help). Keys are [a-z][a-z0-9_]*. In the text,
 * `{name}` is a named insertion and `\n` a line break. The English table is the source
 * of the keys; a key missing from another table falls back to English. bin/ccs
 * reads the same files (bash 3.2), so the format stays this plain.
 *
 * Language: bin/ccs decides it once (--lang=, CCS_LANG, defaults.language,
 * the locale, English — docs/design/i18n.md 2) and passes it down in
 * CCS_LANG_RESOLVED; the modules never decide it again. A module started on
 * its own (tests, the fzf bindings) without that variable falls back to
 * CCS_LANG, then the locale, then English.
 *
 * Inserted values are not cleaned here: callers pass values already made safe
 * for the terminal (as before). The tables themselves are trusted.
 */
import { readFileSync } from "node:fs";
export const LANGS = ["ja", "en"];
/** What `defaults.language` may hold (`auto` = not set). */
export const LANGUAGE_SETTINGS = ["auto", "ja", "en"];
export function isLang(v) {
    return typeof v === "string" && LANGS.includes(v);
}
export function isLanguageSetting(v) {
    return typeof v === "string" && LANGUAGE_SETTINGS.includes(v);
}
/** Step 4: the first non-empty of LC_ALL, LC_MESSAGES, LANG; `ja…` is Japanese. */
export function langFromLocale(env) {
    for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
        const v = env[name];
        if (v)
            return /^ja([_.@-]|$)/.test(v) ? "ja" : "en";
    }
    return null;
}
/**
 * docs/design/i18n.md 2. `skipped` names the steps whose value was set but
 * unknown (CCS_LANG, defaults.language): the caller warns about them.
 */
export function resolveLang(i) {
    const skipped = [];
    if (isLang(i.flag))
        return { lang: i.flag, skipped };
    if (i.env) {
        if (isLang(i.env))
            return { lang: i.env, skipped };
        skipped.push("env");
    }
    if (i.config !== undefined && i.config !== null && i.config !== "" && i.config !== "auto") {
        if (isLang(i.config))
            return { lang: i.config, skipped };
        skipped.push("config");
    }
    return { lang: langFromLocale(i.locale) ?? "en", skipped };
}
/** The language for this process (see the file comment). */
export function currentLang(env = process.env) {
    const passed = env.CCS_LANG_RESOLVED;
    if (isLang(passed))
        return passed;
    if (isLang(env.CCS_LANG))
        return env.CCS_LANG;
    return langFromLocale(env) ?? "en";
}
const KEY_LINE = /^([a-z][a-z0-9_]*)(\+?)=(.*)$/;
export function parseTable(text) {
    const table = new Map();
    for (const raw of text.split("\n")) {
        const line = raw.replace(/\r$/, "");
        const m = KEY_LINE.exec(line);
        if (!m)
            continue;
        const [, key, more, value] = m;
        const before = table.get(key);
        table.set(key, more && before !== undefined ? `${before}\\n${value}` : value);
    }
    return table;
}
const cache = new Map();
export function tableFile(lang) {
    return new URL(`./ccs-lang-${lang}.txt`, import.meta.url);
}
export function loadTable(lang) {
    let table = cache.get(lang);
    if (!table) {
        try {
            table = parseTable(readFileSync(tableFile(lang), "utf-8"));
        }
        catch {
            table = new Map();
        }
        cache.set(lang, table);
    }
    return table;
}
/** `{name}` → vars[name]; `\n` → a line break. An unknown name stays as written. */
export function fill(text, vars = {}) {
    // Line breaks of the table first, so an inserted value is never reread.
    return text
        .replace(/\\n/g, "\n")
        .replace(/\{([a-z][a-z0-9_]*)\}/g, (whole, name) => Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole);
}
/** Said instead of a key no table has (a broken install): never the key itself. */
export const MISSING_TABLE_TEXT = "[ccs] ccs is not installed completely (a string table is missing); install it again";
/**
 * The text for `key` in this process's language. A table that is missing or
 * lacks the key reads in English (no warning); with no English either, the
 * install is broken and MISSING_TABLE_TEXT is said (the same line as bash).
 */
export function t(key, vars, lang = currentLang()) {
    const text = loadTable(lang).get(key) ?? loadTable("en").get(key);
    return text === undefined ? MISSING_TABLE_TEXT : fill(text, vars);
}
