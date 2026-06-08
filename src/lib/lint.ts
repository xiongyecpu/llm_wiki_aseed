import { readFile, listDirectory } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { useActivityStore } from "@/stores/activity-store"
import { getFileName, getRelativePath, normalizePath } from "@/lib/path-utils"
import { buildLanguageDirective } from "@/lib/output-language"
import { parseFrontmatterArray } from "@/lib/sources-merge"

export interface LintResult {
  type: "orphan" | "broken-link" | "no-outlinks" | "semantic"
  severity: "warning" | "info"
  page: string
  detail: string
  affectedPages?: string[]
}

// ── helpers ───────────────────────────────────────────────────────────────────

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const regex = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim())
  }
  return links
}

function extractOutlinks(content: string): string[] {
  const links = extractWikilinks(content)
  const related = parseFrontmatterArray(content, "related")
  return [...new Set([...links, ...related].map((link) => link.trim()).filter(Boolean))]
}

function extractFrontmatterTitle(content: string): string | null {
  const match = content.match(/^title:\s*["']?(.+?)["']?\s*$/m)
  return match?.[1]?.trim() || null
}

function relativeToSlug(relativePath: string): string {
  // relativePath relative to wiki/ dir, e.g. "entities/foo-bar" or "queries/my-page-2024-01-01"
  return relativePath.replace(/\.md$/, "")
}

function shouldCheckConnectivity(relativePath: string): boolean {
  return !relativePath.startsWith("sources/") && !relativePath.startsWith("queries/")
}

export function normalizeWikiLookupKey(value: string): string {
  const withoutExt = value
    .normalize("NFKC")
    .replace(/\.md$/i, "")
    .trim()
  const basename = getFileName(withoutExt)
  return basename
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[：:()（）[\]"'“”‘’.,，。/\\+]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function stripGeneratedDateSuffix(value: string): string {
  return value.replace(/-\d{4}-\d{2}-\d{2}(?:-\d{6})?$/i, "")
}

function wikiLookupKeys(value: string): string[] {
  const withoutExt = value.replace(/\.md$/i, "")
  const basename = getFileName(withoutExt)
  const normalized = normalizeWikiLookupKey(withoutExt)
  const normalizedBase = normalizeWikiLookupKey(basename)
  const undatedBase = stripGeneratedDateSuffix(basename)
  const normalizedUndatedBase = normalizeWikiLookupKey(undatedBase)
  const keys = [
    withoutExt.toLowerCase(),
    basename.toLowerCase(),
    normalized,
    normalized.replace(/-/g, ""),
    normalizedBase.replace(/-/g, ""),
  ]

  if (/^(?:wiki\/)?(?:entities|concepts)\//i.test(withoutExt)) {
    const undated = stripGeneratedDateSuffix(withoutExt)
    const normalizedUndated = normalizeWikiLookupKey(undated)
    keys.push(undated.toLowerCase())
    keys.push(normalizedUndated)
    keys.push(normalizedUndated.replace(/-/g, ""))
  }
  keys.push(undatedBase.toLowerCase())
  keys.push(normalizedUndatedBase)
  keys.push(normalizedUndatedBase.replace(/-/g, ""))

  return [...new Set(keys.filter((key) => key.length > 0))]
}

/**
 * Build a slug → absolute path map from wiki files. Keys are lowercased
 * so [[Transformer]] matches transformer.md — wikilink matching should
 * be case-insensitive (matching typical wiki conventions). Callers must
 * also lowercase their lookup keys.
 */
function buildSlugMap(
  wikiFiles: FileNode[],
  wikiRoot: string,
  pageTitles: Map<string, string>,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const f of wikiFiles) {
    // e.g. /path/to/project/wiki/entities/foo.md → entities/foo
    const rel = getRelativePath(f.path, wikiRoot).replace(/\.md$/, "")
    for (const key of wikiLookupKeys(rel)) {
      if (!map.has(key)) map.set(key, f.path)
    }
    const title = pageTitles.get(f.path)
    if (title) {
      for (const key of wikiLookupKeys(title)) {
        if (!map.has(key)) map.set(key, f.path)
      }
    }
  }
  return map
}

function resolveWikilinkTarget(
  slugMap: Map<string, string>,
  wikiRoot: string,
  link: string,
): string | null {
  for (const key of wikiLookupKeys(link)) {
    const target = slugMap.get(key)
    if (target) {
      return relativeToSlug(getRelativePath(target, wikiRoot)).toLowerCase()
    }
  }
  return null
}

// ── Structural lint ───────────────────────────────────────────────────────────

export async function runStructuralLint(projectPath: string): Promise<LintResult[]> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return []
  }

  const wikiFiles = flattenMdFiles(tree)
  // Exclude index.md and log.md from orphan checks
  const contentFiles = wikiFiles.filter(
    (f) => f.name !== "index.md" && f.name !== "log.md"
  )

  // Read all content files
  type PageData = {
    path: string
    slug: string
    content: string
    outlinks: string[]
    bodyLinks: string[]
  }
  const pages: PageData[] = []
  const pageTitles = new Map<string, string>()

  for (const f of contentFiles) {
    try {
      const content = await readFile(f.path)
      const slug = relativeToSlug(getRelativePath(f.path, wikiRoot))
      const title = extractFrontmatterTitle(content)
      if (title) pageTitles.set(f.path, title)
      const bodyLinks = extractWikilinks(content)
      const outlinks = extractOutlinks(content)
      pages.push({ path: f.path, slug, content, outlinks, bodyLinks })
    } catch {
      // skip unreadable files
    }
  }

  const slugMap = buildSlugMap(contentFiles, wikiRoot, pageTitles)

  // Build inbound link count. Lookups are case-insensitive — [[Transformer]]
  // should match transformer.md (slug "transformer").
  const inboundCounts = new Map<string, number>()
  for (const p of pages) {
    for (const link of p.outlinks) {
      const target = resolveWikilinkTarget(slugMap, wikiRoot, link) ?? link.toLowerCase()
      inboundCounts.set(target, (inboundCounts.get(target) ?? 0) + 1)
    }
  }

  const results: LintResult[] = []

  for (const p of pages) {
    const shortName = getRelativePath(p.path, wikiRoot)

    // Orphan: no inbound links (lowercased slug for case-insensitive match)
    const inbound = inboundCounts.get(p.slug.toLowerCase()) ?? 0
    if (shouldCheckConnectivity(shortName) && inbound === 0) {
      results.push({
        type: "orphan",
        severity: "info",
        page: shortName,
        detail: "No other pages link to this page.",
      })
    }

    // No outbound links
    if (shouldCheckConnectivity(shortName) && p.outlinks.length === 0) {
      results.push({
        type: "no-outlinks",
        severity: "info",
        page: shortName,
        detail: "This page has no [[wikilink]] references to other pages.",
      })
    }

    // Broken links — case-insensitive matching. Only body wikilinks
    // are reported here; frontmatter `related:` contributes graph
    // connectivity but is surfaced in the frontmatter UI instead of
    // as a prose broken-link warning.
    for (const link of p.bodyLinks) {
      const exists = resolveWikilinkTarget(slugMap, wikiRoot, link) !== null
      if (!exists) {
        results.push({
          type: "broken-link",
          severity: "warning",
          page: shortName,
          detail: `Broken link: [[${link}]] — target page not found.`,
        })
      }
    }
  }

  return results
}

// ── Semantic lint ─────────────────────────────────────────────────────────────

const LINT_BLOCK_REGEX =
  /---LINT:\s*([^\n|]+?)\s*\|\s*([^\n|]+?)\s*\|\s*([^\n-]+?)\s*---\n([\s\S]*?)---END LINT---/g

export async function runSemanticLint(
  projectPath: string,
  llmConfig: LlmConfig,
): Promise<LintResult[]> {
  const pp = normalizePath(projectPath)
  const activity = useActivityStore.getState()
  const activityId = activity.addItem({
    type: "lint",
    title: "Semantic wiki lint",
    status: "running",
    detail: "Reading wiki pages...",
    filesWritten: [],
  })

  const wikiRoot = `${pp}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    activity.updateItem(activityId, { status: "error", detail: "Failed to read wiki directory." })
    return []
  }

  const wikiFiles = flattenMdFiles(tree).filter(
    (f) => f.name !== "log.md"
  )

  // Build a compact summary of each page (frontmatter + first 500 chars)
  const summaries: string[] = []
  for (const f of wikiFiles) {
    try {
      const content = await readFile(f.path)
      const preview = content.slice(0, 500) + (content.length > 500 ? "..." : "")
      const shortPath = getRelativePath(f.path, wikiRoot)
      summaries.push(`### ${shortPath}\n${preview}`)
    } catch {
      // skip
    }
  }

  if (summaries.length === 0) {
    activity.updateItem(activityId, { status: "done", detail: "No wiki pages to lint." })
    return []
  }

  activity.updateItem(activityId, { detail: "Running LLM semantic analysis..." })

  // For auto-mode language detection, sample the concatenated summaries
  // so non-English wikis get a matching language directive.
  const summarySample = summaries.join("\n").slice(0, 2000)

  const prompt = [
    "You are a wiki quality analyst. Review the following wiki page summaries and identify issues.",
    "",
    buildLanguageDirective(summarySample),
    "",
    "For each issue, output exactly this format:",
    "",
    "---LINT: type | severity | Short title---",
    "Description of the issue.",
    "PAGES: page1.md, page2.md",
    "---END LINT---",
    "",
    "Types:",
    "- contradiction: two or more pages make conflicting claims",
    "- stale: information that appears outdated or superseded",
    "- missing-page: an important concept is heavily referenced but has no dedicated page",
    "- suggestion: a question or source worth adding to the wiki",
    "",
    "Severities:",
    "- warning: should be addressed",
    "- info: nice to have",
    "",
    "Only report genuine issues. Do not invent problems. Output ONLY the ---LINT--- blocks, no other text.",
    "",
    "## Wiki Pages",
    "",
    summaries.join("\n\n"),
  ].join("\n")

  let raw = ""
  let hadError = false

  await streamChat(
    llmConfig,
    [{ role: "user", content: prompt }],
    {
      onToken: (token) => { raw += token },
      onDone: () => {},
      onError: (err) => {
        hadError = true
        activity.updateItem(activityId, {
          status: "error",
          detail: `LLM error: ${err.message}`,
        })
      },
    },
  )

  if (hadError) return []

  const results: LintResult[] = []
  const matches = raw.matchAll(LINT_BLOCK_REGEX)

  for (const match of matches) {
    const rawType = match[1].trim().toLowerCase()
    const severity = match[2].trim().toLowerCase()
    const title = match[3].trim()
    const body = match[4].trim()

    // semantic results always use type "semantic"
    void rawType

    const pagesMatch = body.match(/^PAGES:\s*(.+)$/m)
    const affectedPages = pagesMatch
      ? pagesMatch[1].split(",").map((p) => p.trim())
      : undefined

    const detail = body.replace(/^PAGES:.*$/m, "").trim()

    results.push({
      type: "semantic",
      severity: (severity === "warning" ? "warning" : "info") as LintResult["severity"],
      page: title,
      detail: `[${rawType}] ${detail}`,
      affectedPages,
    })
  }

  activity.updateItem(activityId, {
    status: "done",
    detail: `Found ${results.length} semantic issue(s).`,
  })

  return results
}
