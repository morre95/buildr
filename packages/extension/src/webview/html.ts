import MarkdownIt from "markdown-it";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// `html: false` escapes any raw HTML in the source instead of rendering it, so
// model/tool output cannot inject markup into the webview. markdown-it also
// validates link protocols, blocking javascript:/data: URLs by default.
const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
});

export function renderMarkdown(value: string): string {
  return markdown.render(value);
}
