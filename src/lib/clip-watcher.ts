import { useWikiStore } from "@/stores/wiki-store"
import { enqueueIngest } from "./ingest-queue"
import { listDirectory } from "@/commands/fs"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { importSourceFiles } from "@/lib/source-lifecycle"

const POLL_INTERVAL = 3000 // Check every 3 seconds
let intervalId: ReturnType<typeof setInterval> | null = null

/**
 * Start polling the clip server for new web clips.
 * When a clip is detected, triggers auto-ingest and refreshes the file tree.
 */
export function startClipWatcher() {
  if (intervalId) return // Already running

  intervalId = setInterval(async () => {
    try {
      const res = await fetch("http://127.0.0.1:19827/clips/pending", { method: "GET" })
      const data = await res.json()

      if (data.ok && data.clips && data.clips.length > 0) {
        const store = useWikiStore.getState()
        const project = store.project

        for (const clip of data.clips) {
          const clipProjectPath: string = clip.projectPath
          const clipFilePath: string = clip.filePath

          // Refresh file tree if clip is for current project
          if (project && clipProjectPath === project.path) {
            try {
              const tree = await listDirectory(project.path)
              store.setFileTree(tree)
            } catch {
              // ignore
            }

            // Enqueue (not auto-ingest directly) so the task lands in the
            // persisted queue, shows up in the activity panel, and survives
            // a UI refresh. Same path used by file imports from sources-view.
            // Pass the project's stable UUID — the queue looks up the
            // current filesystem path from the registry at run time.
            if (hasUsableLlm(store.llmConfig)) {
              enqueueIngest(project.id, clipFilePath).catch((err) => {
                console.error("Failed to enqueue web clip:", err)
              })
            }
          }
        }
      }

      const fileRes = await fetch("http://127.0.0.1:19827/files/pending", { method: "GET" })
      const fileData = await fileRes.json()
      if (!fileData.ok || !fileData.files || fileData.files.length === 0) return

      const latestStore = useWikiStore.getState()
      const latestProject = latestStore.project
      if (!latestProject) return

      const paths = fileData.files
        .filter((item: { projectPath?: string }) => item.projectPath === latestProject.path)
        .map((item: { filePath?: string }) => item.filePath)
        .filter((path: unknown): path is string => typeof path === "string" && path.length > 0)

      if (paths.length === 0) return
      await importSourceFiles(
        latestProject,
        paths,
        latestStore.llmConfig,
        latestStore.sourceWatchConfig,
      )
      try {
        const tree = await listDirectory(latestProject.path)
        latestStore.setFileTree(tree)
      } catch {
        // ignore
      }
    } catch {
      // Server not running or network error — silently ignore
    }
  }, POLL_INTERVAL)
}

export function stopClipWatcher() {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}
