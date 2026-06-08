import type { FileNode } from "@/types/wiki"
import { parseFrontmatter } from "@/lib/frontmatter"

/**
 * Strip Obsidian-style `[[target]]` or `[[target|alias]]` wrapping
 * from a value, returning `{ slug, label }`. Frontmatter authors
 * (humans and the LLM) sometimes write related entries as
 * wikilinks instead of bare slugs; we want to display the alias
 * (or target) without the bracket noise and look up by target.
 *
 * Non-wikilink input is returned with `slug === label === input`.
 */
export function unwrapWikilink(s: string): { slug: string; label: string } {
  const m = s.match(/^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/)
  if (!m) return { slug: s, label: s }
  const target = m[1].trim()
  const alias = m[2]?.trim()
  return { slug: target, label: alias && alias.length > 0 ? alias : target }
}

/**
 * Walk a FileNode tree and return the absolute path of the first
 * file whose name matches `targetName`, restricted to subtrees that
 * sit underneath any directory whose absolute path contains
 * `pathContains`. Returns null when nothing matches.
 *
 * Used by the frontmatter panel to resolve `related: [slug]` to a
 * concrete `wiki/.../<slug>.md` path so a chip can navigate, and
 * `sources: [name.pdf]` to a `raw/sources/.../name.pdf` path so a
 * card can open the raw file. We intentionally take the first
 * match — duplicate basenames across subfolders are a wiki-author
 * collision the user sees in the file tree anyway, and resolving
 * arbitrarily is no worse than the prior text-only display.
 */
export function findInTreeByName(
  tree: FileNode[],
  targetName: string,
  pathContains: string,
): string | null {
  function walk(nodes: FileNode[]): string | null {
    for (const node of nodes) {
      if (node.is_dir) {
        if (node.children) {
          const r = walk(node.children)
          if (r) return r
        }
        continue
      }
      if (node.name === targetName && node.path.includes(pathContains)) {
        return node.path
      }
    }
    return null
  }
  return walk(tree)
}

export function normalizeWikiPageLookupKey(value: string): string {
  const withoutExt = value
    .normalize("NFKC")
    .replace(/\.md$/i, "")
    .trim()
  const base = withoutExt.split(/[\\/]/).pop() ?? withoutExt
  return base
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[：:()（）[\]"'“”‘’.,，。/\\+]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function stripGeneratedDateSuffix(value: string): string {
  return value.replace(/-\d{4}-\d{2}-\d{2}(?:-\d{6})?$/i, "")
}

function relatedLookupKeys(ref: string): string[] {
  const withoutExt = ref.replace(/\.md$/i, "")
  const base = withoutExt.split(/[\\/]/).pop() ?? withoutExt
  const normalized = normalizeWikiPageLookupKey(withoutExt)
  const normalizedBase = normalizeWikiPageLookupKey(base)
  const undatedBase = stripGeneratedDateSuffix(base)
  const normalizedUndatedBase = normalizeWikiPageLookupKey(undatedBase)
  const keys = [
    withoutExt.toLowerCase(),
    base.toLowerCase(),
    normalized,
    normalized.replace(/-/g, ""),
    normalizedBase.replace(/-/g, ""),
    undatedBase.toLowerCase(),
    normalizedUndatedBase,
    normalizedUndatedBase.replace(/-/g, ""),
  ]
  if (/^(?:wiki\/)?(?:entities|concepts)\//i.test(withoutExt)) {
    const undated = stripGeneratedDateSuffix(withoutExt)
    const normalizedUndated = normalizeWikiPageLookupKey(undated)
    keys.push(undated.toLowerCase())
    keys.push(normalizedUndated)
    keys.push(normalizedUndated.replace(/-/g, ""))
  }
  return [...new Set(keys.filter((key) => key.length > 0))]
}

function findInTreeByRelatedLookupKey(
  tree: FileNode[],
  ref: string,
  pathContains: string,
): string | null {
  const targets = new Set(relatedLookupKeys(ref))
  function walk(nodes: FileNode[]): string | null {
    for (const node of nodes) {
      if (node.is_dir) {
        if (node.children) {
          const r = walk(node.children)
          if (r) return r
        }
        continue
      }
      const filenameKey = normalizeWikiPageLookupKey(node.name)
      const pathKey = normalizeWikiPageLookupKey(node.path)
      if (
        node.path.includes(pathContains) &&
        (targets.has(filenameKey) || targets.has(pathKey))
      ) {
        return node.path
      }
    }
    return null
  }
  return walk(tree)
}

function collectMarkdownFiles(tree: FileNode[], pathContains: string): string[] {
  const paths: string[] = []
  function walk(nodes: FileNode[]) {
    for (const node of nodes) {
      if (node.is_dir) {
        if (node.children) walk(node.children)
        continue
      }
      if (node.path.includes(pathContains) && node.name.toLowerCase().endsWith(".md")) {
        paths.push(node.path)
      }
    }
  }
  walk(tree)
  return paths
}

/**
 * Resolve a `related:` reference to an absolute wiki page path.
 * Accepts three shapes the wiki has historically written:
 *   1. project-relative path:  `wiki/entities/dpao.md`
 *   2. bare filename with .md: `dpao.md`
 *   3. bare slug:              `dpao`
 * Returns the absolute path of an existing file, or null if none
 * matches. Always restricts the lookup to `wiki/` to avoid pulling
 * in a same-named file from `raw/sources/`.
 */
export function resolveRelatedSlug(
  tree: FileNode[],
  ref: string,
  wikiRoot: string,
): string | null {
  // Path-like → resolve relative to project root (one segment up
  // from wikiRoot).
  if (ref.includes("/")) {
    const projectRoot = wikiRoot.replace(/\/wiki$/, "")
    const target = `${projectRoot}/${ref}`
    const found = findInTreeByPath(tree, target)
    if (found && found.includes(`${wikiRoot}/`)) return found
    return findInTreeByRelatedLookupKey(tree, ref, `${wikiRoot}/`)
  }

  const filename = ref.endsWith(".md") ? ref : `${ref}.md`
  return (
    findInTreeByName(tree, filename, `${wikiRoot}/`) ??
    findInTreeByRelatedLookupKey(tree, ref, `${wikiRoot}/`)
  )
}

/**
 * Fallback for links written as human titles while the real page has
 * a generated or encoded filename, especially source-summary pages in
 * `wiki/sources/`. The file tree only exposes names/paths, so callers
 * provide a reader for the rare cases where filename lookup failed.
 */
export async function resolveRelatedSlugByTitle(
  tree: FileNode[],
  ref: string,
  wikiRoot: string,
  read: (path: string) => Promise<string>,
): Promise<string | null> {
  const targets = new Set(relatedLookupKeys(ref))
  for (const path of collectMarkdownFiles(tree, `${wikiRoot}/`)) {
    let content: string
    try {
      content = await read(path)
    } catch {
      continue
    }
    const title = parseFrontmatter(content).frontmatter?.title
    if (typeof title !== "string") continue
    if (relatedLookupKeys(title).some((key) => targets.has(key))) {
      return path
    }
  }
  return null
}

/**
 * Resolve a `sources:` reference. Accepts:
 *   1. project-relative path:  `wiki/sources/foo.md` or
 *                              `raw/sources/year-2025/q1.pdf`
 *   2. bare filename with ext: `q1.pdf`
 *   3. wiki source-summary:    `foo.md` (in wiki/sources/)
 * Tries wiki/sources/ first when the ref is a bare .md filename
 * (the ingest pipeline writes summary pages there), then falls
 * back to raw/sources/. Returns null if nothing matches.
 */
export function resolveSourceName(
  tree: FileNode[],
  ref: string,
  sourcesRoot: string,
): string | null {
  // sourcesRoot is `<project>/raw/sources` — derive project root
  // and wiki/ root from it.
  const projectRoot = sourcesRoot.replace(/\/raw\/sources$/, "")
  const wikiSources = `${projectRoot}/wiki/sources`

  if (ref.includes("/")) {
    const normalizedRef = ref.replace(/\\/g, "/").replace(/^\/+/, "")
    const candidates = normalizedRef.startsWith("raw/sources/") ||
      normalizedRef.startsWith("wiki/")
      ? [`${projectRoot}/${normalizedRef}`]
      : [
          `${sourcesRoot}/${normalizedRef}`,
          `${projectRoot}/${normalizedRef}`,
        ]

    for (const target of candidates) {
      const found = findInTreeByPath(tree, target)
      if (found) return found
    }
    return null
  }

  // Bare .md filename → look in wiki/sources/ first (ingest's
  // canonical home for source-summary pages).
  if (ref.endsWith(".md")) {
    const inWiki = findInTreeByName(tree, ref, `${wikiSources}/`)
    if (inWiki) return inWiki
  }

  // Otherwise, search raw/sources/.
  return findInTreeByName(tree, ref, `${sourcesRoot}/`)
}

function findInTreeByPath(tree: FileNode[], targetPath: string): string | null {
  function walk(nodes: FileNode[]): string | null {
    for (const node of nodes) {
      if (node.path === targetPath) return node.path
      if (node.is_dir && node.children) {
        const r = walk(node.children)
        if (r) return r
      }
    }
    return null
  }
  return walk(tree)
}
