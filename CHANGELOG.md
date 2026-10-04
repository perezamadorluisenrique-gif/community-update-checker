# Changelog

The release workflow uses the section named after the version being released
as the release description, so every version needs one. `npm version <x.y.z>`
renames the `Unreleased` heading below to that version.

## 0.1.3

- Settings now use Obsidian's declarative settings API, so they appear in the settings search on 1.13 and later; older versions keep the previous settings page.

## 0.1.2

- Renamed to Update Radar (id `update-radar`): the previous name was already taken by an earlier submission in the community directory. Settings are stored under the plugin id, so an install of 0.1.1 starts with default settings.

## 0.1.1

- Renamed to Community Update Checker (id `community-update-checker`): the community directory does not accept the words "plugin" or "obsidian" in a plugin's name, id or description. Settings are stored under the new id, so a 0.1.0 install starts with default settings.

## 0.1.0

- First release: background update check (at startup and every N hours) for the plugins installed from the directory, a status-bar count, a list with release notes, update one or all, ignore a version, updates held back when they need a newer Obsidian, and a health section for removed, long-unreleased and unlisted plugins.
