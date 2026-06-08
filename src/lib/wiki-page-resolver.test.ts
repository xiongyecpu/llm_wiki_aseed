import { describe, it, expect } from "vitest"
import type { FileNode } from "@/types/wiki"
import {
  findInTreeByName,
  resolveRelatedSlug,
  resolveRelatedSlugByTitle,
  resolveSourceName,
  unwrapWikilink,
} from "./wiki-page-resolver"

const PP = "/p"
const WIKI = `${PP}/wiki`
const SOURCES = `${PP}/raw/sources`

function file(path: string): FileNode {
  const name = path.split("/").pop()!
  return { name, path, is_dir: false }
}
function dir(path: string, children: FileNode[]): FileNode {
  const name = path.split("/").pop()!
  return { name, path, is_dir: true, children }
}

const TREE: FileNode[] = [
  dir(`${PP}/wiki`, [
    dir(`${WIKI}/entities`, [file(`${WIKI}/entities/foo.md`)]),
    dir(`${WIKI}/concepts`, [
      file(`${WIKI}/concepts/bar.md`),
      file(`${WIKI}/concepts/zwift-ride.md`),
      file(`${WIKI}/concepts/遗产产品.md`),
      file(`${WIKI}/concepts/ai智能体智能副将domestique.md`),
    ]),
    dir(`${WIKI}/queries`, [file(`${WIKI}/queries/what-is-foo.md`)]),
    dir(`${WIKI}/sources`, [
      file(`${WIKI}/sources/paper.md`),
      file(`${WIKI}/sources/4-lark--102-bu-ai-v2--571phr.md`),
    ]),
  ]),
  dir(`${PP}/raw`, [
    dir(`${SOURCES}`, [
      file(`${SOURCES}/report.pdf`),
      dir(`${SOURCES}/year-2025`, [
        file(`${SOURCES}/year-2025/q1.pdf`),
        file(`${SOURCES}/year-2025/notes.md`),
      ]),
    ]),
  ]),
]

describe("unwrapWikilink", () => {
  it("unwraps a bare [[target]]", () => {
    expect(unwrapWikilink("[[nh3-n]]")).toEqual({ slug: "nh3-n", label: "nh3-n" })
  })

  it("unwraps [[target|alias]] and uses alias as label", () => {
    expect(unwrapWikilink("[[nh3-n|NH3-N (氨氮)]]")).toEqual({
      slug: "nh3-n",
      label: "NH3-N (氨氮)",
    })
  })

  it("trims whitespace inside the wikilink", () => {
    expect(unwrapWikilink("[[ nh3-n | 氨氮 ]]")).toEqual({
      slug: "nh3-n",
      label: "氨氮",
    })
  })

  it("returns input unchanged for non-wikilink strings", () => {
    expect(unwrapWikilink("nh3-n")).toEqual({ slug: "nh3-n", label: "nh3-n" })
    expect(unwrapWikilink("wiki/entities/nh3-n.md")).toEqual({
      slug: "wiki/entities/nh3-n.md",
      label: "wiki/entities/nh3-n.md",
    })
  })

  it("does not match partial brackets", () => {
    expect(unwrapWikilink("[[broken")).toEqual({ slug: "[[broken", label: "[[broken" })
    expect(unwrapWikilink("broken]]")).toEqual({ slug: "broken]]", label: "broken]]" })
  })

  it("returns target when alias is empty pipe", () => {
    expect(unwrapWikilink("[[nh3-n|]]")).toEqual({ slug: "nh3-n", label: "nh3-n" })
  })
})

describe("findInTreeByName", () => {
  it("returns null on an empty tree", () => {
    expect(findInTreeByName([], "foo.md", "/wiki/")).toBeNull()
  })

  it("finds a file at the top of a subtree", () => {
    expect(findInTreeByName(TREE, "foo.md", `${WIKI}/`)).toBe(`${WIKI}/entities/foo.md`)
  })

  it("recurses into nested directories", () => {
    expect(findInTreeByName(TREE, "q1.pdf", `${SOURCES}/`)).toBe(
      `${SOURCES}/year-2025/q1.pdf`,
    )
  })

  it("respects pathContains as a subtree filter", () => {
    // "notes.md" exists under raw/sources/year-2025 but not under wiki/.
    expect(findInTreeByName(TREE, "notes.md", `${WIKI}/`)).toBeNull()
    expect(findInTreeByName(TREE, "notes.md", `${SOURCES}/`)).toBe(
      `${SOURCES}/year-2025/notes.md`,
    )
  })

  it("returns null when nothing matches", () => {
    expect(findInTreeByName(TREE, "missing.md", `${WIKI}/`)).toBeNull()
  })
})

describe("resolveRelatedSlug", () => {
  it("appends .md and finds entities by bare slug", () => {
    expect(resolveRelatedSlug(TREE, "foo", WIKI)).toBe(`${WIKI}/entities/foo.md`)
  })

  it("finds queries with hyphenated slugs", () => {
    expect(resolveRelatedSlug(TREE, "what-is-foo", WIKI)).toBe(
      `${WIKI}/queries/what-is-foo.md`,
    )
  })

  it("accepts bare filename with .md extension", () => {
    expect(resolveRelatedSlug(TREE, "foo.md", WIKI)).toBe(`${WIKI}/entities/foo.md`)
  })

  it("accepts a project-relative wiki path", () => {
    expect(resolveRelatedSlug(TREE, "wiki/entities/foo.md", WIKI)).toBe(
      `${WIKI}/entities/foo.md`,
    )
  })

  it("accepts a project-relative path under nested wiki subfolder", () => {
    expect(resolveRelatedSlug(TREE, "wiki/concepts/bar.md", WIKI)).toBe(
      `${WIKI}/concepts/bar.md`,
    )
  })

  it("resolves title-style wikilinks to kebab-case filenames", () => {
    expect(resolveRelatedSlug(TREE, "Zwift Ride", WIKI)).toBe(
      `${WIKI}/concepts/zwift-ride.md`,
    )
  })

  it("resolves legacy dated entity/concept paths to the stable page", () => {
    expect(resolveRelatedSlug(TREE, "wiki/concepts/遗产产品-2026-06-05-232551", WIKI)).toBe(
      `${WIKI}/concepts/遗产产品.md`,
    )
  })

  it("resolves separator variants for mixed CJK and Latin slugs", () => {
    expect(resolveRelatedSlug(TREE, "ai智能体-智能副将-domestique", WIKI)).toBe(
      `${WIKI}/concepts/ai智能体智能副将domestique.md`,
    )
  })

  it("returns null when slug doesn't exist", () => {
    expect(resolveRelatedSlug(TREE, "ghost", WIKI)).toBeNull()
  })

  it("returns null when path-like ref doesn't exist", () => {
    expect(resolveRelatedSlug(TREE, "wiki/entities/ghost.md", WIKI)).toBeNull()
  })

  it("resolves human titles to generated source-summary filenames", async () => {
    const sourcePath = `${WIKI}/sources/4-lark--102-bu-ai-v2--571phr.md`
    const read = async (path: string) =>
      path === sourcePath
        ? "---\ntitle: 顽鹿 BU AI 原生组织架构方案 v2.2\n---\n\n# Summary\n"
        : "---\ntitle: Other\n---\n"

    await expect(
      resolveRelatedSlugByTitle(
        TREE,
        "顽鹿BU AI原生组织架构方案v2.2",
        WIKI,
        read,
      ),
    ).resolves.toBe(sourcePath)
  })

  it("never returns a path under raw/sources, even if a matching .md exists there", () => {
    expect(resolveRelatedSlug(TREE, "notes", WIKI)).toBeNull()
  })

  it("rejects path-like refs that point outside wiki/", () => {
    expect(resolveRelatedSlug(TREE, "raw/sources/year-2025/notes.md", WIKI)).toBeNull()
  })
})

describe("resolveSourceName", () => {
  it("finds a top-level source file", () => {
    expect(resolveSourceName(TREE, "report.pdf", SOURCES)).toBe(
      `${SOURCES}/report.pdf`,
    )
  })

  it("finds a source nested in a subfolder", () => {
    expect(resolveSourceName(TREE, "q1.pdf", SOURCES)).toBe(
      `${SOURCES}/year-2025/q1.pdf`,
    )
  })

  it("returns null when filename doesn't exist", () => {
    expect(resolveSourceName(TREE, "ghost.pdf", SOURCES)).toBeNull()
  })

  it("prefers wiki/sources/<name>.md over raw/sources for bare .md refs", () => {
    // paper.md only exists under wiki/sources, so it should resolve there.
    expect(resolveSourceName(TREE, "paper.md", SOURCES)).toBe(
      `${WIKI}/sources/paper.md`,
    )
  })

  it("accepts a project-relative path", () => {
    expect(resolveSourceName(TREE, "raw/sources/year-2025/q1.pdf", SOURCES)).toBe(
      `${SOURCES}/year-2025/q1.pdf`,
    )
  })

  it("accepts a raw/sources relative source identity", () => {
    expect(resolveSourceName(TREE, "year-2025/q1.pdf", SOURCES)).toBe(
      `${SOURCES}/year-2025/q1.pdf`,
    )
  })

  it("accepts a project-relative wiki/sources path", () => {
    expect(resolveSourceName(TREE, "wiki/sources/paper.md", SOURCES)).toBe(
      `${WIKI}/sources/paper.md`,
    )
  })
})
