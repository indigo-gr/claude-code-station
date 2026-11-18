/**
 * ccs-config-edit.ts — the one way ccs writes repos.yml.
 *
 * `ccs repo add`, `ccs repo remove`, `ccs config set` and the append of
 * `ccs init --auto-discover` all go through editSteps(): lock, read and check
 * the current file, let the caller change the parsed document, write it in
 * place with a `.bak` of the previous text, check it again, and put the old
 * text back when that check fails. Contract: docs/design/machine-interface.md
 * chapter 3.
 *
 * The steps are a generator so the same code runs two ways: straight through
 * (runEditSync, for ccs init) and with a pause at each step where a SIGINT
 * can land (runEditAsync, for the machine commands: Node runs a signal
 * handler only between ticks, never inside synchronous code). An interrupt
 * after the write puts the old text back before the lock is dropped.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync, } from "node:fs";
import { dirname } from "node:path";
import { parseDocument, stringify } from "yaml";
import { ConfigError, getPaths, parseConfigSource, } from "./ccs-config.js";
/**
 * Why an edit stopped. `message` is for people and may name the file; the
 * machine commands print only the code (and `configError`'s word).
 */
export class EditStop extends Error {
    code;
    /** config_invalid: the check that failed. */
    configError;
    constructor(code, message, configError) {
        super(message);
        this.name = "EditStop";
        this.code = code;
        this.configError = configError;
    }
}
// ---------------------------------------------------------------------------
// Value checks shared by the writing commands
// ---------------------------------------------------------------------------
// C0, DEL, C1 and the marks that reorder displayed text: the set lives in
// ccs-sanitize (one list for the checks and the display cleaning).
export { hasControlChars } from "./ccs-sanitize.js";
/** Length in code points (a surrogate pair counts once). */
export function codePointLength(value) {
    return [...value].length;
}
/**
 * True when YAML would quote this value (1.6): `2024`, `true`, `~`, `a: b`,
 * `#x`, a leading space. Tools that read repos.yml line by line take the text
 * after `name:` / `path:` as is, so ccs writes those two only when they need
 * no quotes.
 */
export function needsQuoting(value) {
    return stringify(value, { lineWidth: 0 }) !== value + "\n";
}
/** The YAML node of `repos:` is a one-line list (`repos: [ … ]`). */
export function reposIsFlow(doc) {
    const repos = doc.get("repos", true);
    return Boolean(repos && typeof repos === "object" && repos.flow);
}
// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------
/** A lock older than this is a crashed writer's; it is taken over. */
const LOCK_STALE_MS = 10_000;
/** Take `<repos.yml>.lock` (O_EXCL); returns the release, or throws EditStop. */
function acquireLock(lockPath) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = openSync(lockPath, "wx", 0o600);
            try {
                writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
            }
            finally {
                closeSync(fd);
            }
            return () => {
                try {
                    unlinkSync(lockPath);
                }
                catch {
                    // already gone
                }
            };
        }
        catch (err) {
            if (err.code !== "EEXIST") {
                throw new EditStop("write_failed", `cannot create ${lockPath}: ${err.message}`);
            }
            try {
                const st = statSync(lockPath);
                if (Date.now() - st.mtimeMs <= LOCK_STALE_MS)
                    break;
                unlinkSync(lockPath); // stale — take over
            }
            catch {
                // vanished between the two calls — try the create again
            }
        }
    }
    throw new EditStop("config_locked", "another ccs is writing repos.yml (config_locked); try again");
}
/** Options toString() needs to keep lines the user wrote as they are. */
const TO_STRING = { lineWidth: 0, flowCollectionPadding: false };
function check(text, reposYml, warnings) {
    return parseConfigSource(text, reposYml, (w) => warnings?.push(w), false);
}
/**
 * The edit, one yield per point where an interrupt may stop it. Throws
 * EditStop. Drive it with runEditSync or runEditAsync.
 */
export function* editSteps(opts) {
    const reposYml = opts.reposYml ?? getPaths().reposYml;
    let creating = false;
    // The first directory mkdir created (taken back when nothing was written).
    let madeDir;
    if (!existsSync(reposYml)) {
        if (opts.createWith === undefined) {
            throw new EditStop("config_missing", "no repos.yml yet (config_missing); `ccs init` creates one");
        }
        creating = true;
        try {
            madeDir = mkdirSync(dirname(reposYml), { recursive: true, mode: 0o700 });
        }
        catch (err) {
            throw new EditStop("write_failed", `cannot create the config directory: ${err.message}`);
        }
    }
    const dropMadeDir = () => {
        if (!madeDir || existsSync(reposYml))
            return;
        // Innermost first; rmdir refuses a directory that is not empty.
        for (let d = dirname(reposYml); d.length >= madeDir.length; d = dirname(d)) {
            try {
                rmdirSync(d);
            }
            catch {
                break;
            }
        }
    };
    // 1. lock
    let release;
    try {
        release = acquireLock(reposYml + ".lock");
    }
    catch (err) {
        dropMadeDir();
        throw err;
    }
    let wrote = false;
    let settled = false; // the old text is back (or never left)
    let source = "";
    const putBack = () => {
        if (!wrote || settled)
            return;
        if (creating) {
            unlinkSync(reposYml);
        }
        else if (opts.restore) {
            opts.restore(reposYml, source);
        }
        else {
            writeFileSync(reposYml, source, { mode: 0o600 });
        }
        settled = true;
    };
    try {
        yield;
        // 2. read and check what is there now
        let config = null;
        const warnings = [];
        if (creating) {
            if (existsSync(reposYml)) {
                throw new EditStop("config_changed", "repos.yml appeared while ccs was about to create it (config_changed); run again");
            }
            source = opts.createWith ?? "";
        }
        else {
            try {
                source = readFileSync(reposYml, "utf-8");
            }
            catch (err) {
                throw new EditStop("config_not_readable", `cannot read repos.yml (${err.message})`);
            }
            try {
                config = check(source, reposYml, warnings);
            }
            catch (err) {
                if (err instanceof ConfigError) {
                    throw new EditStop("config_invalid", err.message, err);
                }
                throw err;
            }
        }
        yield;
        // 3–4. the caller's checks and change
        const doc = parseDocument(source, { logLevel: "error" });
        const result = opts.transform({ doc, config, source: creating ? "" : source });
        const text = doc.toString(TO_STRING);
        if (result === false || (!creating && text === source)) {
            return { changed: false, createdConfig: false, config: config, warnings };
        }
        yield;
        // 5. changed under us since step 2?
        if (creating ? existsSync(reposYml) : readCurrent(reposYml) !== source) {
            throw new EditStop("config_changed", "repos.yml changed while ccs was editing it (config_changed); run again");
        }
        // 6. backup (one generation, like ccs init)
        if (!creating) {
            try {
                writeFileSync(reposYml + ".bak", source, { mode: 0o600 });
            }
            catch (err) {
                throw new EditStop("write_failed", `cannot write repos.yml.bak (${err.message}); repos.yml unchanged`);
            }
        }
        // 7. write in place: a symlinked repos.yml stays a symlink
        try {
            wrote = true;
            writeFileSync(reposYml, text, { mode: 0o600 });
        }
        catch (err) {
            try {
                putBack();
            }
            catch {
                throw new EditStop("restore_failed", restoreHint(reposYml, creating));
            }
            throw new EditStop("write_failed", `cannot write repos.yml (${err.message}); left as it was`);
        }
        yield;
        // 8. check what was written
        const after = [];
        let written;
        try {
            if (opts.validateAfterWrite)
                opts.validateAfterWrite(text, reposYml);
            written = check(readCurrent(reposYml) ?? "", reposYml, after);
        }
        catch (err) {
            try {
                putBack();
            }
            catch {
                throw new EditStop("restore_failed", restoreHint(reposYml, creating));
            }
            throw new EditStop("validation_after_write_failed", `the written repos.yml failed ccs's checks, so the previous text was put back: ${err instanceof Error ? err.message : String(err)}`, err instanceof ConfigError ? err : undefined);
        }
        yield;
        settled = true;
        return { changed: true, createdConfig: creating, config: written, warnings: after };
    }
    catch (err) {
        // An interrupt (or anything unexpected) after the write: old text back.
        if (wrote && !settled) {
            try {
                putBack();
            }
            catch {
                throw new EditStop("restore_failed", restoreHint(reposYml, creating));
            }
        }
        throw err;
    }
    finally {
        release();
        dropMadeDir();
    }
}
function readCurrent(path) {
    try {
        return readFileSync(path, "utf-8");
    }
    catch {
        return null;
    }
}
function restoreHint(reposYml, creating) {
    return creating
        ? "the new repos.yml failed ccs's checks and could not be removed (restore_failed); delete it by hand"
        : `could not put the previous repos.yml back (restore_failed); it is in ${reposYml}.bak — copy that file over repos.yml`;
}
/** Run the steps straight through (no interrupt points). Throws EditStop. */
export function runEditSync(opts) {
    const gen = editSteps(opts);
    let step = gen.next();
    while (!step.done)
        step = gen.next();
    return step.value;
}
/**
 * Milliseconds to wait at each step (test hook: lets a test send SIGINT in
 * the middle of an edit). 0–10000; anything else is ignored.
 */
function testPauseMs() {
    const raw = process.env.CCS_TEST_EDIT_PAUSE_MS ?? "";
    if (!/^[0-9]{1,5}$/.test(raw))
        return 0;
    const n = Number(raw);
    return n <= 10_000 ? n : 0;
}
/**
 * Run the steps with a pause at each one where SIGINT can arrive. On SIGINT
 * the edit is undone (the old text back, the lock dropped) and EditStop
 * `interrupted` is thrown.
 */
export async function runEditAsync(opts) {
    let interrupted = false;
    let wake = null;
    const onSigint = () => {
        interrupted = true;
        wake?.();
    };
    process.on("SIGINT", onSigint);
    const pause = testPauseMs();
    const gen = editSteps(opts);
    try {
        let step = gen.next();
        while (!step.done) {
            await new Promise((resolve) => {
                wake = resolve;
                if (pause > 0)
                    setTimeout(resolve, pause);
                else
                    setImmediate(resolve);
            });
            wake = null;
            step = interrupted
                ? gen.throw(new EditStop("interrupted", "interrupted; repos.yml left as it was"))
                : gen.next();
        }
        return step.value;
    }
    finally {
        process.off("SIGINT", onSigint);
    }
}
