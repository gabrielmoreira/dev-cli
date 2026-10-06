/**
 * Markdown imported as text. Bun inlines the file at build time, so the release
 * binary carries the text instead of reading it from disk.
 */
declare module "*.md" {
  const content: string;
  export default content;
}
