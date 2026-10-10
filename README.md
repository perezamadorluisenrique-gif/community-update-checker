# Update Radar

Checks your installed community plugins for updates in the background, shows what changed, and tells you which plugins look abandoned. A successor to Plugin Update Tracker, which has not had a release in over a year.

![The Plugin updates view listing four plugins with installed and available versions, release notes opened for one of them, and a plugin health section with a "No release in 2+ years" flag](https://raw.githubusercontent.com/perezamadorluisenrique-gif/community-update-checker/main/docs/update-view.png)

Formerly "Plugin Update Checker" and, briefly, "Community Update Checker"; renamed because the directory does not allow the word "plugin" in a name and the second name was already taken by an earlier submission.

Obsidian only looks for plugin updates when you open **Settings → Community plugins → Check for updates**. This plugin does it for you, every few hours, and puts the answer in the status bar.

## What you get

- **Updates in the status bar.** "3 plugin updates", hidden when there are none. Click it to open the list.
- **A list of what changed.** Each row shows the installed version, the new one, and, when you open **Release notes**, the notes from the plugin's GitHub release, rendered as Markdown.
- **Update one or all.** The same installer Obsidian uses; enabled plugins are reloaded afterwards.
- **Ignore this version.** Skips exactly that version; the next release shows up again. **Stop ignoring** brings it back.
- **Go back to an earlier version.** An update broke something? Right-click a plugin in the list, use the history button on an update row, open **Install an earlier version** at the bottom of the list, or run the command of the same name. You see the plugin's releases (up to 30) with version, date and the start of the notes; the installed one is marked, and a version that needs a newer Obsidian than yours is greyed out. Update Radar then stops offering the version you went back from.
- **Compatibility.** An update that needs a newer Obsidian than yours is listed apart, with the version it needs, and is never offered.
- **Plugin health.** Flags plugins that were **removed from the directory** (with the reason), have had **no release in two or more years**, or are **not from the directory** (installed by hand or with BRAT).

## Network use

**This plugin sends web requests, to GitHub only.** There is no analytics and no other service.

- Once a day it reads three public files from `obsidianmd/obsidian-releases` (the plugin list, the removed list and the stats), the same ones Obsidian itself uses.
- For each installed plugin from the directory, it reads that plugin's latest `manifest.json` from its GitHub releases, like Obsidian's own update check.
- When you open **Release notes** on a row, it reads that release from the GitHub API.
- When you choose **Install an earlier version**, it lists the plugin's releases from the GitHub API and downloads `main.js`, `manifest.json` and `styles.css` from the release you pick.

Nothing about your vault, notes or settings is sent. The requests do reveal your IP address to GitHub, as any download would. Turn off **Check shortly after Obsidian starts** and set **Check every** to *Never* to check only when you ask.

## Commands

| Command | What it does |
|---|---|
| Show plugin updates | Opens the list. Also on the ribbon. |
| Check for plugin updates now | Checks immediately and says how many updates there are. |
| Update all plugins | Installs every update that is available and compatible. |
| Install an earlier version of a plugin | Choose a plugin, then one of its previous releases, and install it. |

## Settings

| Setting | Default | What it does |
|---|---|---|
| Check shortly after Obsidian starts | on | One check about 15 seconds after startup. |
| Check every | 6 hours | While Obsidian stays open. 1, 3, 6, 12 or 24 hours, or never. |
| Show the update count in the status bar | on | Hidden at zero. Not shown on mobile. |
| Include pre-releases when installing an earlier version | off | Also lists pre-releases. Drafts are never listed. |

## Notes

- Updating uses Obsidian's internal plugin installer, which is not part of the public API. If a future Obsidian changes it, the plugin says so instead of failing silently; updating from **Settings → Community plugins** keeps working either way.
- The plugin directory only serves the latest version of each plugin, so **Install an earlier version** downloads from the plugin's GitHub releases instead. Everything is downloaded and checked first (it must be the same plugin, and not need a newer Obsidian than yours). Only then are `main.js`, `manifest.json` and `styles.css` replaced, and if writing fails the old files are put back. The plugin's `data.json` is never touched. The plugin is then turned off and on again. A release without `main.js` and `manifest.json` attached cannot be installed. An older version may not understand settings a newer one saved; Update Radar cannot know.
- Release notes are shown with code-block languages removed and `[[links]]` escaped, so nothing in them runs and nothing in them touches your vault.
- Plugins with updates are installed one at a time; this plugin's own update is installed last.
- "No release in 2+ years" uses the directory's last-release date. Plenty of finished plugins are stable rather than abandoned; the flag is a prompt to look, not a verdict.
- Versions are compared as semantic versions, so `1.10.0` is newer than `1.9.0` and a pre-release such as `2.0.0-beta.1` is older than `2.0.0`. A version that is not semver (four parts, a date) counts as an update whenever it differs, like Obsidian's own check.
- Plugins that are not in the directory cannot be checked for updates and appear only under health.

## Installation

In Obsidian, open **Settings → Community plugins → Browse** and search for "Update Radar".

## More plugins by Siulved54

| Plugin | What it does | Source |
| --- | --- | --- |
| [Shared Blocks](https://obsidian.md/plugins?id=shared-blocks) | Write a block of text once and reuse it in any note. Edit the source and every reference re-renders live. | [shared-blocks](https://github.com/perezamadorluisenrique-gif/shared-blocks) |
| [Text Case and Cleanup](https://obsidian.md/plugins?id=text-format) | Change case, make camelCase or slugs, sort lines and remove duplicates, and repair text pasted out of a PDF, without touching code or URLs. | [text-format](https://github.com/perezamadorluisenrique-gif/text-format) |
| [Typography as You Type](https://obsidian.md/plugins?id=typography-as-you-type) | Curly quotes, dashes and ellipses as you type, kept out of code and maths, with Backspace to take one back. | [smart-typography-plugin](https://github.com/perezamadorluisenrique-gif/smart-typography-plugin) |
| [Section Numbering](https://obsidian.md/plugins?id=section-numbering) | Number headings as an outline (1, 1.1, 1.2) and keep every link to them working when they renumber. | [section-numbering](https://github.com/perezamadorluisenrique-gif/section-numbering) |
| [Spreadsheet to Table](https://obsidian.md/plugins?id=spreadsheet-to-table) | Paste cells from Excel or Google Sheets as a Markdown table with a real header, insert CSV files, and copy tables back out. | [spreadsheet-to-table](https://github.com/perezamadorluisenrique-gif/spreadsheet-to-table) |
| [Hybrid Line Numbers](https://obsidian.md/plugins?id=hybrid-line-numbers) | Relative and hybrid line numbers for Vim-style jumps, where a folded section counts as one line. | [hybrid-line-numbers](https://github.com/perezamadorluisenrique-gif/hybrid-line-numbers) |
| [List Item Callouts](https://obsidian.md/plugins?id=list-item-callouts) | Colour a single list item as a callout by starting it with a character such as `&`, `!` or `?`. | [list-item-callouts](https://github.com/perezamadorluisenrique-gif/list-item-callouts) |
| [Folder Counts](https://obsidian.md/plugins?id=folder-counts) | See how many notes or files each folder holds, right in the file explorer, with a vault total and folder exclusions. | [folder-counts](https://github.com/perezamadorluisenrique-gif/folder-counts) |
| [Note Reading Time](https://obsidian.md/plugins?id=note-reading-time) | Reading time of the current note or your selection in the status bar, optionally saved to a property. | [note-reading-time](https://github.com/perezamadorluisenrique-gif/note-reading-time) |
| [Task Rollover](https://obsidian.md/plugins?id=task-rollover) | Roll unfinished tasks from your last daily note into today's when it is created, with a real undo. | [task-rollover](https://github.com/perezamadorluisenrique-gif/task-rollover) |
| [Zoom Into Section](https://obsidian.md/plugins?id=zoom-into-section) | Zoom into a heading or list item to see only it and its contents, with a breadcrumb bar to climb back out. | [zoom-into-section](https://github.com/perezamadorluisenrique-gif/zoom-into-section) |
| [Link Title on Paste](https://obsidian.md/plugins?id=link-title-on-paste) | Paste a web address and get a Markdown link with the page's title, fetched in the background and undone in one step. | [link-title-on-paste](https://github.com/perezamadorluisenrique-gif/link-title-on-paste) |
| [Dataview to Bases](https://obsidian.md/plugins?id=dataview-to-bases) | Convert Dataview queries into Bases blocks, and see which queries in your vault can be converted. | [dataview-to-bases](https://github.com/perezamadorluisenrique-gif/dataview-to-bases) |
| [Line Editing Commands](https://obsidian.md/plugins?id=line-editing-commands) | Duplicate, join, sort and reverse lines, insert blank lines and jump to a line number, with multi-cursor support. | [line-editing-commands](https://github.com/perezamadorluisenrique-gif/line-editing-commands) |
| [Note Mover Rules](https://obsidian.md/plugins?id=note-mover-rules) | Move notes into folders by ordered rules on tags, properties, titles and paths, with a preview before any bulk move. | [note-mover-rules](https://github.com/perezamadorluisenrique-gif/note-mover-rules) |
| [Tab History](https://obsidian.md/plugins?id=tab-history) | Keeps each tab's back and forward history across restarts, and adds commands to move, maximize and close tabs. | [tab-history](https://github.com/perezamadorluisenrique-gif/tab-history) |
| [URL Cards](https://obsidian.md/plugins?id=url-cards) | Shows web addresses as cards with title, description and image, and reads existing cardlink blocks. | [url-cards](https://github.com/perezamadorluisenrique-gif/url-cards) |
| [Vim Config](https://obsidian.md/plugins?id=vim-config) | Loads a vimrc-style file from your vault so your key mappings and editor commands are ready when vim mode starts. | [vim-config](https://github.com/perezamadorluisenrique-gif/vim-config) |
| [Task Archive](https://obsidian.md/plugins?id=task-archive) | Moves completed tasks, with their sub-items, into an archive section or note. | [task-archive](https://github.com/perezamadorluisenrique-gif/task-archive) |
| [Revisit Later](https://obsidian.md/plugins?id=revisit-later) | Link the current note into a future daily note, with a date typed in plain English, so it comes back when you want to review it. | [revisit-later](https://github.com/perezamadorluisenrique-gif/revisit-later) |
| [Explorer Colors Plus](https://obsidian.md/plugins?id=explorer-colors-plus) | Color files and folders in the file explorer, with a palette, cascading to children, and import from File Color. | [explorer-colors-plus](https://github.com/perezamadorluisenrique-gif/explorer-colors-plus) |
| [Book Lookup](https://obsidian.md/plugins?id=book-lookup) | Create book notes from Open Library or Google Books, with cover images, ISBN search and Book Search compatible templates. | [book-lookup](https://github.com/perezamadorluisenrique-gif/book-lookup) |
| [Web Search Menu](https://obsidian.md/plugins?id=web-search-menu) | Search the web for selected text or the note title from the right-click menu, with engines you define. | [web-search-menu](https://github.com/perezamadorluisenrique-gif/web-search-menu) |

All of them are in the community directory: Settings -> Community plugins ->
Browse, then search for the name.
