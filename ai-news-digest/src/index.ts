import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import cron from "node-cron";
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
const CRON_SCHEDULE = "0 8 * * *"; // 08:00 every day, local time

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

/**
 * Normalize a URL for dedup: lowercase host, drop the fragment and common tracking
 * query params (utm_*, ref, etc.), and strip a trailing slash. Falls back to the raw
 * string (lowercased, trailing slash removed) if it isn't a parseable URL.
 */
function normalizeUrl(link: string): string {
  try {
    const url = new URL(link);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || /^(ref|ref_src|source|cmpid)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    let normalized = url.toString();
    if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
    return normalized;
  } catch {
    return link.trim().toLowerCase().replace(/\/+$/, "");
  }
}

/**
 * Remove duplicate articles that share the same normalized URL, keeping the first
 * occurrence (callers pass a time-sorted list, so that's the most recent). Articles
 * with no link are always kept — there's nothing to dedup on.
 */
function dedupeByUrl(articles: Article[]): Article[] {
  const seen = new Set<string>();
  const unique: Article[] = [];

  for (const article of articles) {
    if (!article.link) {
      unique.push(article);
      continue;
    }
    const key = normalizeUrl(article.link);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(article);
  }

  return unique;
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

/** Escape Markdown link-breaking characters so titles render correctly. */
function escapeMarkdown(text: string): string {
  return text.replace(/([\[\]])/g, "\\$1");
}

/** Local-time YYYY-MM-DD (consistent with the local-time "generated" header). */
function localDateStamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
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
    const safeTitle = escapeMarkdown(a.title);
    const title = a.link ? `[${safeTitle}](${a.link})` : safeTitle;
    lines.push(
      `- **${title}** — _${a.source}_ · ${a.publishedAt.toLocaleString()}`,
    );
    if (a.summary) lines.push(`  > ${a.summary}`);
  }

  return lines.join("\n") + "\n";
}

/** Fetch, filter, render, and write a single digest. Returns the output path. */
async function generateDigest(): Promise<void> {
  const now = new Date();
  const cutoff = now.getTime() - WINDOW_MS;

  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const collected = results
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .filter((a) => a.publishedAt.getTime() >= cutoff)
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

  const articles = dedupeByUrl(collected);
  const duplicates = collected.length - articles.length;
  if (duplicates > 0) {
    console.log(`🔁 Removed ${duplicates} duplicate article(s) by URL`);
  }

  const markdown = renderDigest(articles, now);

  const outDir = join(process.cwd(), "output");
  await mkdir(outDir, { recursive: true });
  const stamp = localDateStamp(now); // YYYY-MM-DD, local time
  const outPath = join(outDir, `ai-digest-${stamp}.md`);
  await writeFile(outPath, markdown, "utf8");

  console.log(
    `✅ ${articles.length} articles from the last 24h written to ${outPath}`,
  );
}

/** Run once immediately, or stay resident and run on a daily schedule with --cron. */
async function main(): Promise<void> {
  const cronMode = process.argv.includes("--cron");

  if (!cronMode) {
    await generateDigest();
    return;
  }

  if (!cron.validate(CRON_SCHEDULE)) {
    throw new Error(`Invalid cron schedule: ${CRON_SCHEDULE}`);
  }

  console.log(
    `⏰ Cron mode: generating a digest at "${CRON_SCHEDULE}" (08:00 daily, local time). Press Ctrl+C to stop.`,
  );

  cron.schedule(CRON_SCHEDULE, () => {
    console.log(`\n▶️  Scheduled run started at ${new Date().toLocaleString()}`);
    generateDigest().catch((err) => {
      console.error("Scheduled run failed:", err);
    });
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
