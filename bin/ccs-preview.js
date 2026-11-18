#!/usr/bin/env node
/**
 * ccs-preview.ts — fzf preview pane dispatcher for ccs v0.2.0
 *
 * Invoked by fzf as: node bin/ccs-preview.ts <KIND:KEY> <CWD>
 *   KIND=new     → render repo preview (DB-backed state summary)
 *   KIND=group   → render group-header preview (path + nested entries)
 *   KIND=resume  → delegate to renderSessionPreview (conversation history)
 *
 * Each kind is drawn as a friendly "card" (plain words in the run's
 * language, no git/handoff jargon in the headings).
 *
 * All errors print to stdout (fzf reads stdout for preview) and exit 0.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { getPaths } from "./ccs-config.js";
import { getMeta, openDb, reposV3Columns } from "./ccs-db.js";
import { groupsFromMeta } from "./ccs-groups.js";
import { renderSessionPreview } from "./ccs-preview-session.js";
import { formatFriendlyTime, truncate, repoDisplayName, findParentRepo, tildePath, } from "./ccs-utils.js";
import { pathForDisplay, } from "./ccs-sanitize.js";
import { t } from "./ccs-i18n.js";
// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------
const C = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    headerName: "\x1b[1;36m", // bold cyan
};
function dim(s) {
    return `${C.dim}${s}${C.reset}`;
}
/** A group's lead entry (`lead: true`) first, the rest in their given order — as in the list. */
function leadFirst(rows) {
    return [...rows.filter((r) => r.lead === 1), ...rows.filter((r) => r.lead !== 1)];
}
// ---------------------------------------------------------------------------
// Integrations rendering
// ---------------------------------------------------------------------------
const KNOWN_INTEGRATIONS = [
    { key: "plane_project_id", label: "Plane" },
    { key: "attio_workspace", label: "Attio" },
    { key: "notion_db", label: "Notion" },
    { key: "linear_team", label: "Linear" },
    {
        key: "slack_channel",
        label: "Slack",
        format: (v) => (v.startsWith("#") ? v : `#${v}`),
    },
    { key: "github_repo", label: "GitHub" },
    { key: "figma_file", label: "Figma" },
];
// ---------------------------------------------------------------------------
// Group-header preview (repos.yml `launch: false`)
// ---------------------------------------------------------------------------
/**
 * A logical group's header (`group:@<id>`, from defaults.groups_dir): its
 * label and the entries listed under it. Never throws. False
 * when the cache holds no such group (a repos.yml header may be named `@…`).
 */
function renderLogicalGroup(id) {
    const paths = getPaths();
    let handle = null;
    try {
        handle = openDb(paths.stateDb, { readonly: true, skipMigrate: true });
        const db = handle.db;
        const group = groupsFromMeta(getMeta(db, "logical_groups")).find((g) => g.id === id);
        if (!group)
            return false;
        const listed = db
            .prepare(`SELECT name, path, description, icon, ${reposV3Columns(db)}
           FROM repos WHERE disabled = 0`)
            .all();
        const entries = group.members
            .map((n) => listed.find((r) => r.name === n))
            .filter((r) => r !== undefined);
        const title = truncate(group.label, 60);
        cardTitle(t("card_group_title", { icon: "🗂", name: title }));
        console.log(t("card_group_is_heading"));
        console.log("");
        if (entries.length === 0) {
            console.log(t("card_group_no_listed"));
            return true;
        }
        cardField("🗂 ", t("card_group_members", { n: entries.length }), entries.map((r) => {
            const desc = r.description ? `  ${dim(truncate(r.description, 40))}` : "";
            return `${truncate(r.icon || "", 8) || "📁"} ${repoDisplayName(r)}${desc}`;
        }));
        return true;
    }
    catch {
        return false;
    }
    finally {
        try {
            handle?.close();
        }
        catch {
            // ignore
        }
    }
}
// ---------------------------------------------------------------------------
// ui: simple — cards
// ---------------------------------------------------------------------------
//
// One voice for every card: what Enter will do first, then the few facts a
// person needs to pick (folder, when it was last used, unsaved changes, notes
// left behind), then the Enter line again. No git/cache vocabulary in the
// headings; anything that went wrong is one sentence that says what to do.
function cardTitle(s) {
    console.log("");
    console.log(`  ${C.bold}${s}${C.reset}`);
    console.log("");
}
function cardField(icon, name, values) {
    console.log(`  ${icon} ${C.bold}${name}${C.reset}`);
    for (const v of values)
        console.log(`     ${v}`);
}
function cardFooter(s) {
    console.log("");
    console.log(`  ${C.headerName}${s}${C.reset}`);
}
function cardNotice(lines) {
    console.log("");
    for (const l of lines)
        console.log(`  ${l}`);
}
/** Integration display names, from the table above. */
function integrationNames(customJson) {
    let custom;
    try {
        custom = JSON.parse(customJson || "{}");
    }
    catch {
        return [];
    }
    return KNOWN_INTEGRATIONS.filter(({ key }) => {
        const v = custom[key];
        return v !== null && v !== undefined && v !== "";
    }).map(({ label: l }) => l);
}
const noCacheLines = () => t("card_no_cache").split("\n");
function withDb(fn) {
    const paths = getPaths();
    if (!existsSync(paths.stateDb)) {
        cardNotice(noCacheLines());
        return;
    }
    let handle = null;
    try {
        handle = openDb(paths.stateDb, { readonly: true, skipMigrate: true });
        fn(handle.db);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        cardNotice([
            t("card_failed"),
            dim(truncate(msg, 120)),
        ]);
    }
    finally {
        try {
            handle?.close();
        }
        catch {
            // ignore
        }
    }
}
function renderSimpleRepoCard(name, cwd) {
    withDb((db) => {
        const repo = db
            .prepare(`SELECT name, path, description, icon, tags_json, custom_json,
                ${reposV3Columns(db)}
         FROM repos WHERE name = ?`)
            .get(name);
        if (!repo) {
            cardNotice([
                ...t("card_not_in_cache", { name: truncate(name, 40) }).split("\n"),
            ]);
            return;
        }
        const stats = db
            .prepare(`SELECT is_git, branch, uncommitted_files, uncommitted_insertions,
                uncommitted_deletions, handoff_count, pending_count,
                session_last_at
         FROM repo_stats WHERE name = ?`)
            .get(name);
        const home = homedir();
        const folder = cwd || repo.path;
        const folderExists = folder ? existsSync(folder) : false;
        cardTitle(t("card_repo_title", { name: repoDisplayName(repo) }));
        if (repo.lead === 1) {
            console.log(t("card_repo_lead"));
            console.log("");
        }
        if (repo.description) {
            console.log(`  ${truncate(repo.description, 200)}`);
            console.log("");
        }
        cardField("📂", t("card_folder"), [pathForDisplay(tildePath(truncate(folder, 200), home))]);
        if (!folderExists) {
            console.log(t("card_folder_missing"));
        }
        cardField("🕒", t("card_last_opened"), [
            stats?.session_last_at
                ? formatFriendlyTime(stats.session_last_at, { clock: true })
                : t("card_never_opened"),
        ]);
        if (stats && stats.is_git === 1) {
            const files = stats.uncommitted_files ?? 0;
            const changed = files > 0 ||
                (stats.uncommitted_insertions ?? 0) > 0 ||
                (stats.uncommitted_deletions ?? 0) > 0;
            const values = [
                changed
                    ? t("card_changes_some", { n: files })
                    : t("card_changes_none"),
            ];
            const branch = stats.branch ?? "";
            if (branch && branch !== "main" && branch !== "master") {
                values.push(dim(t("card_branch", { branch: truncate(branch, 60) })));
            }
            cardField("📝", t("card_changes"), values);
        }
        if ((stats?.handoff_count ?? 0) > 0) {
            cardField("📌", t("card_handoff"), [t("card_handoff_count", { n: stats?.handoff_count ?? 0 })]);
        }
        if ((stats?.pending_count ?? 0) > 0) {
            cardField("🗒 ", t("card_pending"), [t("card_pending_count", { n: stats?.pending_count ?? 0 })]);
        }
        const services = integrationNames(repo.custom_json || "{}");
        if (services.length > 0) {
            cardField("🔗", t("card_services"), [services.join(t("card_list_separator"))]);
        }
        const recent = db
            .prepare(`SELECT last_activity_at, topic FROM sessions
         WHERE repo_name = ?
         ORDER BY last_activity_at DESC LIMIT 3`)
            .all(name);
        if (recent.length > 0) {
            cardField("💭", t("card_recent_topics"), recent.map((r) => t("card_recent_topic_line", {
                when: formatFriendlyTime(r.last_activity_at),
                topic: truncate(r.topic || t("list_no_topic"), 50),
            })));
        }
        cardFooter(folderExists
            ? t("card_repo_footer")
            : t("card_repo_footer_here"));
    });
}
function renderSimpleGroupCard(name) {
    if (name.startsWith("@") && renderLogicalGroup(name.slice(1)))
        return;
    withDb((db) => {
        const listed = db
            .prepare(`SELECT name, path, description, icon, ${reposV3Columns(db)}
         FROM repos WHERE disabled = 0
         ORDER BY name COLLATE NOCASE ASC`)
            .all();
        const group = listed.find((r) => r.name === name);
        if (!group) {
            cardNotice([
                ...t("card_not_in_cache", { name: truncate(name, 40) }).split("\n"),
            ]);
            return;
        }
        cardTitle(t("card_group_title", { icon: "📂", name: repoDisplayName(group) }));
        if (group.description) {
            console.log(`  ${truncate(group.description, 200)}`);
            console.log("");
        }
        console.log(t("card_group_is_heading"));
        console.log("");
        const entries = leadFirst(listed.filter((r) => r !== group && findParentRepo(r, listed) === group));
        if (entries.length === 0) {
            console.log(t("card_group_empty"));
            return;
        }
        cardField("🗂 ", t("card_group_members", { n: entries.length }), entries.map((r) => {
            const desc = r.description ? `  ${dim(truncate(r.description, 40))}` : "";
            const tag = r.launch === 0
                ? `  ${dim(t("card_tag_group"))}`
                : r.lead === 1
                    ? `  ${dim(t("card_tag_lead"))}`
                    : "";
            const icon = r.lead === 1 ? "👑" : truncate(r.icon || "", 8) || "📁";
            return `${icon} ${repoDisplayName(r)}${desc}${tag}`;
        }));
    });
}
async function renderSimpleSessionCard(uuid) {
    let row;
    withDb((db) => {
        row = db
            .prepare(`SELECT cwd, last_activity_at, topic, repo_name, NULL AS repo_label
           FROM sessions WHERE uuid = ?`)
            .get(uuid);
        if (row && row.repo_name) {
            const r = db
                .prepare(`SELECT name, ${reposV3Columns(db)} FROM repos WHERE name = ?`)
                .get(row.repo_name);
            row.repo_label = r ? repoDisplayName(r) : null;
        }
    });
    if (!row) {
        // withDb already printed the reason when the cache itself is missing.
        if (existsSync(getPaths().stateDb)) {
            cardNotice([
                ...t("card_session_not_in_cache").split("\n"),
            ]);
        }
        return;
    }
    const home = homedir();
    cardTitle(t("card_session_title"));
    if (row.repo_label)
        cardField("🏷 ", t("card_project"), [row.repo_label]);
    cardField("📂", t("card_folder"), [pathForDisplay(tildePath(truncate(row.cwd, 200), home))]);
    cardField("🕒", t("card_last_talked"), [
        formatFriendlyTime(row.last_activity_at, { clock: true }),
    ]);
    cardField("💭", t("card_topic"), [truncate(row.topic || t("list_no_topic"), 200)]);
    cardFooter(t("card_session_footer"));
    console.log("");
    await renderSessionPreview(uuid);
}
async function renderSimple(kind, key, cwd) {
    if (kind === "resume") {
        await renderSimpleSessionCard(key);
    }
    else if (kind === "new") {
        renderSimpleRepoCard(key, cwd);
    }
    else if (kind === "group") {
        renderSimpleGroupCard(key);
    }
    else if (kind === "separator") {
        cardNotice([t("card_separator")]);
    }
    else {
        cardNotice([t("card_cannot_open")]);
    }
}
// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------
async function main() {
    const kindKey = process.argv[2] || "";
    const cwd = process.argv[3] || "";
    if (!kindKey) {
        console.log("Usage: ccs-preview <KIND:KEY> <CWD>");
        return;
    }
    const colonIdx = kindKey.indexOf(":");
    if (colonIdx < 0) {
        console.log(`Invalid argument: ${kindKey} (expected KIND:KEY)`);
        return;
    }
    const kind = kindKey.slice(0, colonIdx);
    const key = kindKey.slice(colonIdx + 1);
    try {
        await renderSimple(kind, key, cwd);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        cardNotice([
            t("card_failed"),
            dim(truncate(msg, 120)),
        ]);
    }
}
main().catch((err) => {
    console.log(`Preview fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
});
