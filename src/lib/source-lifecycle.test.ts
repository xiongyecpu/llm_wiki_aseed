import { describe, expect, it, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => ({
  copyFile: vi.fn(),
  createDirectory: vi.fn(),
  deleteFile: vi.fn(),
  fileExists: vi.fn(),
  getFileSize: vi.fn(),
  importLarkDoc: vi.fn(),
  listDirectory: vi.fn(),
  preprocessFile: vi.fn(),
  enqueueBatch: vi.fn(),
}))

vi.mock("@/commands/fs", async () => {
  const actual = await vi.importActual<typeof import("@/commands/fs")>("@/commands/fs")
  return {
    ...actual,
    copyFile: mocks.copyFile,
    createDirectory: mocks.createDirectory,
    deleteFile: mocks.deleteFile,
    fileExists: mocks.fileExists,
    getFileSize: mocks.getFileSize,
    importLarkDoc: mocks.importLarkDoc,
    listDirectory: mocks.listDirectory,
    preprocessFile: mocks.preprocessFile,
  }
})

vi.mock("@/lib/ingest-queue", () => ({
  enqueueBatch: mocks.enqueueBatch,
}))

import {
  folderContextForSourcePath,
  importLarkDocSources,
  importLarkDocSource,
  importSourceFiles,
  importSourceFolder,
  isIngestableSourcePath,
} from "./source-lifecycle"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.copyFile.mockResolvedValue(undefined)
  mocks.createDirectory.mockResolvedValue(undefined)
  mocks.deleteFile.mockResolvedValue(undefined)
  mocks.fileExists.mockResolvedValue(false)
  mocks.getFileSize.mockResolvedValue(1024)
  mocks.importLarkDoc.mockResolvedValue({
    path: "/project/raw/sources/lark/project-plan.md",
    title: "Project Plan",
  })
  mocks.listDirectory.mockResolvedValue([])
  mocks.preprocessFile.mockResolvedValue("")
  mocks.enqueueBatch.mockResolvedValue(["task"])
})

describe("source-lifecycle path helpers", () => {
  it("does not treat preprocessed cache files as ingestable sources", () => {
    expect(isIngestableSourcePath("raw/sources/.cache/report.pdf.txt")).toBe(false)
    expect(isIngestableSourcePath("/project/raw/sources/.cache/report.pdf.txt")).toBe(false)
  })

  it("derives folder context from absolute raw/sources paths without leaking the project prefix", () => {
    expect(
      folderContextForSourcePath("/tmp/project/raw/sources/reports/2026/report.pdf"),
    ).toBe("reports > 2026")
  })

  it("applies source watch exclusions during folder import before preprocess and ingest", async () => {
    mocks.listDirectory.mockResolvedValue([
      { name: "keep.md", path: "/external/imported/keep.md", is_dir: false },
      { name: "config.json", path: "/external/imported/config.json", is_dir: false },
      {
        name: "drafts",
        path: "/external/imported/drafts",
        is_dir: true,
        children: [
          { name: "skip.md", path: "/external/imported/drafts/skip.md", is_dir: false },
        ],
      },
    ])

    const copied = await importSourceFolder(
      { id: "p1", name: "Project", path: "/project" },
      "/external/imported",
      {
        provider: "openai",
        endpoint: "https://api.example.com/v1",
        apiKey: "key",
        model: "model",
        customModel: "",
        reasoning: { enabled: false, effort: "low" },
      } as never,
      {
        enabled: true,
        autoIngest: true,
        includeExtensions: ["md"],
        excludeExtensions: ["json"],
        excludeDirs: ["drafts"],
        excludeGlobs: [],
        maxFileSizeMb: 100,
      },
    )

    expect(copied).toEqual(["/project/raw/sources/imported/keep.md"])
    expect(mocks.copyFile).toHaveBeenCalledTimes(1)
    expect(mocks.copyFile).toHaveBeenCalledWith("/external/imported/keep.md", "/project/raw/sources/imported/keep.md")
    expect(mocks.copyFile).not.toHaveBeenCalledWith("/external/imported/config.json", expect.anything())
    expect(mocks.copyFile).not.toHaveBeenCalledWith("/external/imported/drafts/skip.md", expect.anything())
    expect(mocks.deleteFile).not.toHaveBeenCalled()
    expect(mocks.preprocessFile).toHaveBeenCalledOnce()
    expect(mocks.preprocessFile).toHaveBeenCalledWith("/project/raw/sources/imported/keep.md")
    expect(mocks.enqueueBatch).toHaveBeenCalledWith("p1", [
      {
        sourcePath: "/project/raw/sources/imported/keep.md",
        folderContext: "imported",
      },
    ])
  })

  it("filters single-file imports using the original source path before copying", async () => {
    const copied = await importSourceFiles(
      { id: "p1", name: "Project", path: "/project" },
      ["/external/drafts/spec.md", "/external/ready.md"],
      {
        provider: "openai",
        endpoint: "https://api.example.com/v1",
        apiKey: "key",
        model: "model",
        customModel: "",
        reasoning: { enabled: false, effort: "low" },
      } as never,
      {
        enabled: true,
        autoIngest: true,
        includeExtensions: ["md"],
        excludeExtensions: [],
        excludeDirs: ["drafts"],
        excludeGlobs: [],
        maxFileSizeMb: 100,
      },
    )

    expect(copied).toEqual(["/project/raw/sources/ready.md"])
    expect(mocks.copyFile).toHaveBeenCalledTimes(1)
    expect(mocks.copyFile).toHaveBeenCalledWith("/external/ready.md", "/project/raw/sources/ready.md")
    expect(mocks.copyFile).not.toHaveBeenCalledWith("/external/drafts/spec.md", expect.anything())
    expect(mocks.enqueueBatch).toHaveBeenCalledWith("p1", [
      {
        sourcePath: "/project/raw/sources/ready.md",
        folderContext: "",
      },
    ])
  })

  it("imports Lark documents as raw sources and enqueues them for ingest", async () => {
    const imported = await importLarkDocSource(
      { id: "p1", name: "Project", path: "/project" },
      "https://example.feishu.cn/docx/doc-token",
      {
        provider: "openai",
        endpoint: "https://api.example.com/v1",
        apiKey: "key",
        model: "model",
        customModel: "",
        reasoning: { enabled: false, effort: "low" },
      } as never,
    )

    expect(imported).toBe("/project/raw/sources/lark/project-plan.md")
    expect(mocks.importLarkDoc).toHaveBeenCalledWith(
      "/project",
      "https://example.feishu.cn/docx/doc-token",
    )
    expect(mocks.enqueueBatch).toHaveBeenCalledWith("p1", [
      {
        sourcePath: "/project/raw/sources/lark/project-plan.md",
        folderContext: "lark",
      },
    ])
  })

  it("imports multiple selected Lark documents before enqueueing one batch", async () => {
    mocks.importLarkDoc
      .mockResolvedValueOnce({
        path: "/project/raw/sources/lark/first.md",
        title: "First",
      })
      .mockResolvedValueOnce({
        path: "/project/raw/sources/lark/second.md",
        title: "Second",
      })

    const imported = await importLarkDocSources(
      { id: "p1", name: "Project", path: "/project" },
      [
        "https://example.feishu.cn/docx/first",
        "https://example.feishu.cn/wiki/second",
      ],
      {
        provider: "openai",
        endpoint: "https://api.example.com/v1",
        apiKey: "key",
        model: "model",
        customModel: "",
        reasoning: { enabled: false, effort: "low" },
      } as never,
    )

    expect(imported).toEqual([
      "/project/raw/sources/lark/first.md",
      "/project/raw/sources/lark/second.md",
    ])
    expect(mocks.importLarkDoc).toHaveBeenCalledTimes(2)
    expect(mocks.enqueueBatch).toHaveBeenCalledTimes(1)
    expect(mocks.enqueueBatch).toHaveBeenCalledWith("p1", [
      { sourcePath: "/project/raw/sources/lark/first.md", folderContext: "lark" },
      { sourcePath: "/project/raw/sources/lark/second.md", folderContext: "lark" },
    ])
  })
})
