# Update Radar

Checks your installed community plugins for updates in the background, shows what changed, and tells you which plugins look abandoned. A successor to Plugin Update Tracker, which has not had a release in over a year.

Formerly "Plugin Update Checker" and, briefly, "Community Update Checker"; renamed because the directory does not allow the word "plugin" in a name and the second name was already taken by an earlier submission.

Obsidian only looks for plugin updates when you open **Settings → Community plugins → Check for updates**. This plugin does it for you, every few hours, and puts the answer in the status bar.

## What you get

- **Updates in the status bar.** "3 plugin updates", hidden when there are none. Click it to open the list.
- **A list of what changed.** Each row shows the installed version, the new one, and, when you open **Release notes**, the notes from the plugin's GitHub release, rendered as Markdown.
- **Update one or all.** The same installer Obsidian uses; enabled plugins are reloaded afterwards.
- **Ignore this version.** Skips exactly that version; the next release shows up again. **Stop ignoring** brings it back.
- **Compatibility.** An update that needs a newer Obsidian than yours is listed apart, with the version it needs, and is never offered.
- **Plugin health.** Flags plugins that were **removed from the directory** (with the reason), have had **no release in two or more years**, or are **not from the directory** (installed by hand or with BRAT).

## Network use

**This plugin sends web requests, to GitHub only.** There is no analytics and no other service.

- Once a day it reads three public files from `obsidianmd/obsidian-releases` (the plugin list, the removed list and the stats), the same ones Obsidian itself uses.
- For each installed plugin from the directory, it reads that plugin's latest `manifest.json` from its GitHub releases, like Obsidian's own update check.
- When you open **Release notes** on a row, it reads that release from the GitHub API.

Nothing about your vault, notes or settings is sent. The requests do reveal your IP address to GitHub, as any download would. Turn off **Check shortly after Obsidian starts** and set **Check every** to *Never* to check only when you ask.

## Commands

| Command | What it does |
|---|---|
| Show plugin updates | Opens the list. Also on the ribbon. |
| Check for plugin updates now | Checks immediately and says how many updates there are. |
| Update all plugins | Installs every update that is available and compatible. |

## Settings

| Setting | Default | What it does |
|---|---|---|
| Check shortly after Obsidian starts | on | One check about 15 seconds after startup. |
| Check every | 6 hours | While Obsidian stays open. 1, 3, 6, 12 or 24 hours, or never. |
| Show the update count in the status bar | on | Hidden at zero. Not shown on mobile. |

## Notes

- Updating uses Obsidian's internal plugin installer, which is not part of the public API. If a future Obsidian changes it, the plugin says so instead of failing silently; updating from **Settings → Community plugins** keeps working either way.
- Release notes are shown with code-block languages removed and `[[links]]` escaped, so nothing in them runs and nothing in them touches your vault.
- Plugins with updates are installed one at a time; this plugin's own update is installed last.
- "No release in 2+ years" uses the directory's last-release date. Plenty of finished plugins are stable rather than abandoned; the flag is a prompt to look, not a verdict.
- Versions are compared as semantic versions, so `1.10.0` is newer than `1.9.0` and a pre-release such as `2.0.0-beta.1` is older than `2.0.0`. A version that is not semver (four parts, a date) counts as an update whenever it differs, like Obsidian's own check.
- Plugins that are not in the directory cannot be checked for updates and appear only under health.

## Installation

In Obsidian, open **Settings → Community plugins → Browse** and search for "Update Radar".
