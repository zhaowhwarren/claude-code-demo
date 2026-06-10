import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Parser from "rss-parser";

interface Feed {
  name: string;
  url: string;
}

interface Article {
  title: string;
  link: string;
  publishedAt: Date;
  source: string;
  summary: string;
}

const FEEDS: Feed[] = [
  {
    name: "TechCrunch AI",
    url: "https://techcrunch.com/category/artificial-intelligence/feed/",
  },
  {
    name: "The Verge AI",
    url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",
  },
  {
    name: "Hacker News (AI)",
    url: "https://hnrss.org/newest?q=AI&count=30",
  },
];

const WINDOW_MS = 24 * 60 * 60 * 1000;
const SUMMARY_MAX = 100;

const parser = new Parser({ timeout: 15_000 });

/** Strip Hacker News RSS boilerplate (Article/Comments URL, Points, # Comments). */
function stripHnBoilerplate(text: string): string {
  return text
    .replace(/Article URL:\s*\S+/gi, " ")
    .replace(/Comments URL:\s*\S+/gi, " ")
    .replace(/Points:\s*\d+/gi, " ")
    .replace(/#\s*Comments:\s*\d+/gi, " ");
}

/**
 * Build a one-sentence summary: strip HTML and HN boilerplate, collapse whitespace,
 * and truncate to SUMMARY_MAX chars. Falls back to the title when nothing useful remains
 * (e.g. HN link posts whose body is only metadata).
 */
function buildSummary(raw: string | undefined, fallback: string): string {
  const clean = stripHnBoilerplate(raw ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const text = clean.length > 0 ? clean : fallback.trim();
  if (text.length <= SUMMARY_MAX) return text;
  return text.slice(0, SUMMARY_MAX).trimEnd() + "…";
}

/** Fetch and normalize a single feed. Failures are logged and yield an empty list. */
async function fetchFeed(feed: Feed): Promise<Article[]> {
  try {
    const parsed = await parser.parseURL(feed.url);
    const articles: Article[] = [];

    for (const item of parsed.items) {
      const rawDate = item.isoDate ?? item.pubDate;
      if (!rawDate) continue;
      const publishedAt = new Date(rawDate);
      if (Number.isNaN(publishedAt.getTime())) continue;

      articles.push({
        title: (item.title ?? "(untitled)").trim(),
        link: item.link ?? "",
        publishedAt,
        source: feed.name,
        summary: buildSummary(
          item.contentSnippet ?? item.content,
          item.title ?? "",
        ),
      });
    }

    return articles;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️  Skipping "${feed.name}" — ${message}`);
    return [];
  }
}

function renderDigest(articles: Article[], generatedAt: Date): string {
  const sourceCount = new Set(articles.map((a) => a.source)).size;

  const lines: string[] = [
    "# AI News Digest",
    "",
    `**${articles.length} articles collected from ${sourceCount} sources**`,
    "",
    `_Generated ${generatedAt.toLocaleString()} · last 24 hours_`,
    "",
  ];

  if (articles.length === 0) {
    lines.push("No articles in the last 24 hours.");
    return lines.join("\n") + "\n";
  }

  for (const a of articles) {
    const title = a.link ? `[${a.title}](${a.link})` : a.title;
    lines.push(
      `- **${title}** — _${a.source}_ · ${a.publishedAt.toLocaleString()}`,
    );
    if (a.summary) lines.push(`  > ${a.summary}`);
  }

  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const now = new Date();
  const cutoff = now.getTime() - WINDOW_MS;

  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const articles = results
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .filter((a) => a.publishedAt.getTime() >= cutoff)
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

  const markdown = renderDigest(articles, now);

  const outDir = join(process.cwd(), "output");
  await mkdir(outDir, { recursive: true });
  const stamp = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const outPath = join(outDir, `ai-digest-${stamp}.md`);
  await writeFile(outPath, markdown, "utf8");

  console.log(
    `✅ ${articles.length} articles from the last 24h written to ${outPath}`,
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
