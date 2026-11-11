// The "Inspect" link on each row: a fixed address on our own site, built from the plugin id. Nothing is sent
// anywhere until the user clicks it, and the id is the only thing in the address.
const INSPECTOR = 'https://perezamadorluisenrique-gif.github.io/plugin-inspector/';

export function inspectUrl(id: string): string {
  return `${INSPECTOR}?q=${encodeURIComponent(id)}`;
}
