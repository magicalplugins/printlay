import { marked } from "marked";

/**
 * Single configured Markdown renderer shared by the registry (build/SSR) and
 * any runtime rendering. GitHub-flavoured markdown, no smartypants surprises.
 * Content is authored in-repo (trusted), so we render to raw HTML and inject
 * it via dangerouslySetInnerHTML inside the styled `.article-content` wrapper.
 */
marked.setOptions({
  gfm: true,
  breaks: false,
});

export function renderMarkdown(body: string): string {
  return marked.parse(body, { async: false }) as string;
}
