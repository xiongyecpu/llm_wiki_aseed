use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::commands::file_sync;
use crate::panic_guard::run_guarded;

#[derive(Debug, Serialize)]
pub struct LarkDocImportResult {
    pub path: String,
    pub title: String,
    #[serde(rename = "documentId")]
    pub document_id: Option<String>,
    #[serde(rename = "revisionId")]
    pub revision_id: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct LarkDocSearchResult {
    pub id: String,
    pub title: String,
    pub url: String,
    #[serde(rename = "docType")]
    pub doc_type: Option<String>,
    pub owner: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<String>,
    pub summary: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LarkFetchOutput {
    ok: Option<bool>,
    error: Option<serde_json::Value>,
    data: Option<LarkFetchData>,
}

#[derive(Debug, Deserialize)]
struct LarkFetchData {
    document: LarkDocument,
}

#[derive(Debug, Deserialize)]
struct LarkDocument {
    document_id: Option<String>,
    revision_id: Option<i64>,
    content: String,
}

#[derive(Debug, Deserialize)]
struct LarkSearchOutput {
    ok: Option<bool>,
    error: Option<serde_json::Value>,
    data: Option<LarkSearchData>,
}

#[derive(Debug, Deserialize)]
struct LarkSearchData {
    results: Vec<LarkSearchItem>,
}

#[derive(Debug, Deserialize)]
struct LarkSearchItem {
    title_highlighted: Option<String>,
    summary_highlighted: Option<String>,
    result_meta: Option<LarkSearchMeta>,
}

#[derive(Debug, Deserialize)]
struct LarkSearchMeta {
    token: Option<String>,
    url: Option<String>,
    doc_types: Option<String>,
    owner_name: Option<String>,
    update_time_iso: Option<String>,
}

#[tauri::command]
pub async fn import_lark_doc(
    project_path: String,
    doc: String,
) -> Result<LarkDocImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("import_lark_doc", || {
            import_lark_doc_impl(&project_path, &doc)
        })
    })
    .await
    .map_err(|e| format!("import_lark_doc blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn search_lark_docs(query: String) -> Result<Vec<LarkDocSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("search_lark_docs", || search_lark_docs_impl(&query))
    })
    .await
    .map_err(|e| format!("search_lark_docs blocking task join error: {e}"))?
}

fn import_lark_doc_impl(project_path: &str, doc: &str) -> Result<LarkDocImportResult, String> {
    let project_root = PathBuf::from(project_path);
    if !project_root.is_dir() {
        return Err(format!("Project path does not exist: {project_path}"));
    }
    let doc = doc.trim();
    if doc.is_empty() {
        return Err("Lark document URL or token is required.".to_string());
    }

    let lark_cli =
        which::which("lark-cli").map_err(|_| "`lark-cli` not found on PATH".to_string())?;
    let output = Command::new(lark_cli)
        .args([
            "docs",
            "+fetch",
            "--api-version",
            "v2",
            "--doc",
            doc,
            "--doc-format",
            "markdown",
            "--format",
            "json",
        ])
        .output()
        .map_err(|e| format!("Failed to spawn `lark-cli`: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(format_lark_cli_error(
            output.status.code(),
            stdout.trim(),
            stderr.trim(),
        ));
    }

    let fetched: LarkFetchOutput = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse `lark-cli` JSON output: {e}"))?;
    if fetched.ok == Some(false) {
        return Err(format!(
            "`lark-cli` returned an error: {}",
            format_json_error(fetched.error)
        ));
    }

    let document = fetched
        .data
        .ok_or_else(|| "`lark-cli` output did not include data.document".to_string())?
        .document;
    let title = title_from_markdown(&document.content)
        .or_else(|| document.document_id.clone())
        .unwrap_or_else(|| "lark-document".to_string());
    let file_name = unique_lark_doc_file_name(
        &project_root.join("raw").join("sources").join("lark"),
        &title,
        document.document_id.as_deref(),
    )?;
    let dest_path = project_root
        .join("raw")
        .join("sources")
        .join("lark")
        .join(file_name);

    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Lark source directory: {e}"))?;
    }

    let source = render_lark_source_markdown(doc, &title, &document);
    file_sync::mark_app_write_path(&dest_path);
    fs::write(&dest_path, source)
        .map_err(|e| format!("Failed to write Lark source '{}': {e}", dest_path.display()))?;
    file_sync::mark_app_write_path(&dest_path);

    Ok(LarkDocImportResult {
        path: dest_path.to_string_lossy().into_owned(),
        title,
        document_id: document.document_id,
        revision_id: document.revision_id,
    })
}

fn search_lark_docs_impl(query: &str) -> Result<Vec<LarkDocSearchResult>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("Search query is required.".to_string());
    }

    let lark_cli =
        which::which("lark-cli").map_err(|_| "`lark-cli` not found on PATH".to_string())?;
    let output = Command::new(lark_cli)
        .args([
            "drive",
            "+search",
            "--query",
            query,
            "--doc-types",
            "doc,docx,wiki",
            "--page-size",
            "20",
            "--format",
            "json",
        ])
        .output()
        .map_err(|e| format!("Failed to spawn `lark-cli`: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(format_lark_cli_error(
            output.status.code(),
            stdout.trim(),
            stderr.trim(),
        ));
    }

    let searched: LarkSearchOutput = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse `lark-cli` search JSON output: {e}"))?;
    if searched.ok == Some(false) {
        return Err(format!(
            "`lark-cli` returned an error: {}",
            format_json_error(searched.error)
        ));
    }

    let results = searched
        .data
        .ok_or_else(|| "`lark-cli` output did not include data.results".to_string())?
        .results
        .into_iter()
        .filter_map(lark_search_item_to_result)
        .collect();
    Ok(results)
}

fn lark_search_item_to_result(item: LarkSearchItem) -> Option<LarkDocSearchResult> {
    let meta = item.result_meta?;
    let url = meta.url?;
    let id = meta.token.clone().unwrap_or_else(|| url.clone());
    let title = item
        .title_highlighted
        .map(|value| clean_lark_highlight(&value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| id.clone());
    let summary = item
        .summary_highlighted
        .map(|value| clean_lark_highlight(&value))
        .filter(|value| !value.is_empty());

    Some(LarkDocSearchResult {
        id,
        title,
        url,
        doc_type: meta.doc_types,
        owner: meta.owner_name,
        updated_at: meta.update_time_iso,
        summary,
    })
}

fn format_lark_cli_error(code: Option<i32>, stdout: &str, stderr: &str) -> String {
    let mut parts = Vec::new();
    if let Some(code) = code {
        parts.push(format!("exit code {code}"));
    }
    if !stderr.is_empty() {
        parts.push(stderr.to_string());
    }
    if !stdout.is_empty() {
        parts.push(stdout.to_string());
    }
    if parts.is_empty() {
        "`lark-cli` failed without output".to_string()
    } else {
        parts.join(": ")
    }
}

fn format_json_error(error: Option<serde_json::Value>) -> String {
    error
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unknown error".to_string())
}

fn render_lark_source_markdown(doc: &str, title: &str, document: &LarkDocument) -> String {
    let fetched_at = Utc::now().to_rfc3339();
    let document_id = document.document_id.as_deref().unwrap_or("");
    let revision_id = document
        .revision_id
        .map(|value| value.to_string())
        .unwrap_or_default();
    format!(
        "---\ntype: lark-doc\ntitle: \"{}\"\nsource: \"{}\"\ndocument_id: \"{}\"\nrevision_id: \"{}\"\nfetched_at: \"{}\"\n---\n\n{}",
        yaml_escape(title),
        yaml_escape(doc),
        yaml_escape(document_id),
        yaml_escape(&revision_id),
        yaml_escape(&fetched_at),
        document.content.trim_start(),
    )
}

fn title_from_markdown(markdown: &str) -> Option<String> {
    markdown.lines().find_map(|line| {
        let trimmed = line.trim();
        trimmed
            .strip_prefix("# ")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn unique_lark_doc_file_name(
    dir: &Path,
    title: &str,
    document_id: Option<&str>,
) -> Result<String, String> {
    let mut base = slugify(title);
    if base.is_empty() {
        base = document_id
            .map(slugify)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| format!("lark-document-{}", Utc::now().timestamp()));
    }
    let mut candidate = format!("{base}.md");
    let mut counter = 2;
    while dir.join(&candidate).exists() {
        candidate = format!("{base}-{counter}.md");
        counter += 1;
        if counter > 10_000 {
            return Err("Could not find a unique filename for the Lark document.".to_string());
        }
    }
    Ok(candidate)
}

fn slugify(value: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if ch.is_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').chars().take(80).collect()
}

fn yaml_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn clean_lark_highlight(value: &str) -> String {
    strip_html_tags(value)
        .replace("<h>", "")
        .replace("</h>", "")
        .replace("<b>", "")
        .replace("</b>", "")
        .replace("&quot;", "\"")
        .replace("&#34;", "\"")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .trim()
        .to_string()
}

fn strip_html_tags(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_tag = false;
    for ch in value.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        clean_lark_highlight, lark_search_item_to_result, slugify, title_from_markdown,
        unique_lark_doc_file_name, LarkSearchItem, LarkSearchMeta,
    };

    #[test]
    fn title_from_markdown_uses_first_h1() {
        assert_eq!(
            title_from_markdown("intro\n# Project Plan\nbody").as_deref(),
            Some("Project Plan"),
        );
    }

    #[test]
    fn slugify_keeps_cjk_and_ascii_words() {
        assert_eq!(slugify("飞书 Doc: Project Plan!"), "飞书-doc-project-plan");
    }

    #[test]
    fn unique_name_uses_incrementing_suffix() {
        let tmp =
            std::env::temp_dir().join(format!("llm-wiki-lark-doc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("project-plan.md"), "existing").unwrap();
        let name = unique_lark_doc_file_name(&tmp, "Project Plan", None).unwrap();
        std::fs::remove_dir_all(&tmp).unwrap();
        assert_eq!(name, "project-plan-2.md");
    }

    #[test]
    fn clean_highlight_removes_lark_markup_and_entities() {
        assert_eq!(
            clean_lark_highlight("A <h>Test</h> <b>&amp;</b> &#34;Plan&#34;"),
            "A Test & \"Plan\"",
        );
    }

    #[test]
    fn search_item_maps_required_fields_for_import() {
        let result = lark_search_item_to_result(LarkSearchItem {
            title_highlighted: Some("<h>Project</h> Plan".to_string()),
            summary_highlighted: Some("Owner notes".to_string()),
            result_meta: Some(LarkSearchMeta {
                token: Some("doc-token".to_string()),
                url: Some("https://example.feishu.cn/docx/doc-token".to_string()),
                doc_types: Some("DOCX".to_string()),
                owner_name: Some("Neal".to_string()),
                update_time_iso: Some("2026-06-06T10:00:00+08:00".to_string()),
            }),
        })
        .unwrap();

        assert_eq!(result.id, "doc-token");
        assert_eq!(result.title, "Project Plan");
        assert_eq!(result.url, "https://example.feishu.cn/docx/doc-token");
        assert_eq!(result.owner.as_deref(), Some("Neal"));
    }
}
