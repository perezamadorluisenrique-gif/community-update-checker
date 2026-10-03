/**
 * Makes a release body safe to render in the user's vault. Rendering runs every
 * plugin's code-block processor, so a "```dataviewjs" fence in the notes would
 * execute before the user decided anything, and `[[links]]` and `![[embeds]]`
 * resolve against the vault. Fences lose their language so they render as plain
 * code, and double brackets are escaped.
 */
export function neutralizeNotes(markdown: string): string {
  return markdown
    .replace(/^([ \t]*(?:>[ \t]*)*)(`{3,}|~{3,})[^\n]*$/gm, (line, lead: string, fence: string) => {
      // A closing fence is a bare run of the same character; keeping the whole line is harmless.
      return /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})[ \t]*$/.test(line) ? line : `${lead}${fence}`;
    })
    .replace(/(!?)\[\[/g, (_m, bang: string) => `${bang ? '!\\[\\[' : '\\[\\['}`);
}
