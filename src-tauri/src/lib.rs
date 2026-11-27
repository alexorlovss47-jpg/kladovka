use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

// ---------- модели ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    /// Байты; None для каталогов и нечитаемых записей.
    pub size: Option<u64>,
    /// Unix-время изменения в секундах.
    pub modified: Option<i64>,
    pub extension: Option<String>,
    pub is_hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DirListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<Entry>,
    /// Нет прав на чтение — entries пустой, UI показывает причину.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpProgress {
    pub op_id: u64,
    pub kind: String,
    pub done: u64,
    pub total: u64,
    pub current: String,
    pub finished: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiskInfo {
    pub mount: String,
    pub label: String,
    pub total: u64,
    pub available: u64,
    pub removable: bool,
    /// Эмодзи-иконка; UI не зависит от локали label.
    pub ico: String,
}

#[derive(Default)]
pub struct AppState {
    next_op: AtomicU64,
    /// op_id -> флаг отмены
    cancels: Mutex<HashMap<u64, std::sync::Arc<std::sync::atomic::AtomicBool>>>,
}

// ---------- утилиты ----------

fn entry_from(path: &Path, meta_is_dir: bool) -> Option<Entry> {
    let name = path.file_name()?.to_string_lossy().to_string();
    let meta = fs::symlink_metadata(path).ok();
    let is_symlink = meta.as_ref().map(|m| m.file_type().is_symlink()).unwrap_or(false);
    // для симлинка следуем, чтобы понять, каталог ли он
    let is_dir = if is_symlink {
        fs::metadata(path).map(|m| m.is_dir()).unwrap_or(meta_is_dir)
    } else {
        meta_is_dir
    };
    let size = if is_dir { None } else { meta.as_ref().map(|m| m.len()) };
    let modified = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);
    let extension = if is_dir { None } else { path.extension().map(|e| e.to_string_lossy().to_lowercase()) };
    Some(Entry {
        name: name.clone(),
        path: path.to_string_lossy().to_string(),
        is_dir,
        is_symlink,
        size,
        modified,
        extension,
        is_hidden: name.starts_with('.') || is_mac_metadata_name(&name),
    })
}

/// Служебные файлы macOS/ntfs-3g, которые нельзя показывать пользователю.
///
/// ntfs-3g хранит xattrs macOS как NTFS alternate data streams и рядом с каждым
/// файлом создаёт «спутник» `._name`. На NTFS они видны как обычные файлы, в
/// Finder скрыты флагом. Показывать их бессмысленно: это метаданные, а не данные.
///
/// Также отсекаем мусор от Windows и архиваторов.
fn is_mac_metadata_name(name: &str) -> bool {
    name.starts_with("._")            // xattr-спутники (ntfs-3g, tar, ditto)
        || name == "System Volume Information"
        || name == "$RECYCLE.BIN"
        || name == "desktop.ini"
        || name == "Thumbs.db"
}

fn expand(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    if path == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    }
    PathBuf::from(path)
}

// ---------- команды ----------

#[tauri::command]
async fn list_dir(path: String, show_hidden: bool) -> Result<DirListing, String> {
    let dir = expand(&path);
    let parent = dir.parent().map(|p| p.to_string_lossy().to_string());
    let shown = dir.to_string_lossy().to_string();

    let read = tokio::task::spawn_blocking(move || -> Result<Vec<Entry>, String> {
        let rd = fs::read_dir(&dir).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for item in rd.flatten() {
            let p = item.path();
            let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if let Some(e) = entry_from(&p, is_dir) {
                out.push(e);
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?;

    match read {
        Ok(mut entries) => {
            entries.retain(|e| show_hidden || !e.is_hidden);
            // каталоги первыми, затем по имени (регистронезависимо)
            entries.sort_by(|a, b| {
                b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });
            Ok(DirListing { path: shown, parent, entries, error: None })
        }
        Err(err) => Ok(DirListing { path: shown, parent, entries: Vec::new(), error: Some(err) }),
    }
}

#[tauri::command]
async fn home_dir() -> String {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")).to_string_lossy().to_string()
}

#[tauri::command]
async fn special_dirs() -> Vec<DiskInfo> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let candidates: Vec<(&str, PathBuf, &str)> = vec![
        ("Домашняя", home.clone(), "🏠"),
        ("Документы", home.join("Documents"), "📄"),
        ("Загрузки", home.join("Downloads"), "⬇"),
        ("Рабочий стол", home.join("Desktop"), "🖥"),
        ("Картинки", home.join("Pictures"), "🖼"),
        ("Проекты", home.join("projects"), "🛠"),
    ];
    candidates
        .into_iter()
        .filter(|(_, p, _)| p.exists())
        .map(|(label, p, ico)| DiskInfo {
            mount: p.to_string_lossy().to_string(),
            label: label.to_string(),
            total: 0,
            available: 0,
            removable: false,
            ico: ico.to_string(),
        })
        .collect()
}

fn simple_disk(path: &str) -> Option<DiskInfo> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(std::ffi::OsStr::new(path).as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statvfs(c.as_ptr(), &mut st) };
    if rc != 0 {
        return None;
    }
    let bsize = st.f_frsize as u64;
    Some(DiskInfo {
        mount: path.to_string(),
        label: path.to_string(),
        total: bsize * st.f_blocks as u64,
        available: bsize * st.f_bavail as u64,
        removable: false,
        ico: String::new(),
    })
}

#[tauri::command]
async fn disk_info() -> Vec<DiskInfo> {
    tokio::task::spawn_blocking(|| {
        let mut internal: Vec<DiskInfo> = Vec::new();
        let mut external: Vec<DiskInfo> = Vec::new();

        if let Some(mut root) = simple_disk("/") {
            root.label = "Macintosh HD".into();
            root.ico = "🖥".into();
            internal.push(root);
        }

        if let Ok(rd) = fs::read_dir("/Volumes") {
            for item in rd.flatten() {
                let p = item.path();
                let s = p.to_string_lossy().to_string();
                let name = p
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| s.clone());

                // Macintosh HD — это уже добавленный корень
                if name == "Macintosh HD" {
                    continue;
                }
                // Recovery — системный том восстановления, не пользовательский
                if name == "Recovery" {
                    continue;
                }
                // Метаданные APFS-контейнера (Preboot, VM, Update, Data и т.п.)
                const SYSTEM_TOMES: [&str; 6] =
                    ["Preboot", "VM", "Update", "Data", "BaseSystem", "com.apple.TimeMachine"];
                if SYSTEM_TOMES.contains(&name.as_str()) {
                    continue;
                }

                if let Some(mut d) = simple_disk(&s) {
                    // statvfs на APFS/Big Sur+ томах, которые лежат в одном
                    // контейнере с корнем, возвращает объём всего контейнера.
                    // Если том отдаёт ровно те же цифры, что и "/", это не
                    // отдельный диск — не показываем его второй раз.
                    let fake_root = internal
                        .first()
                        .map(|r| r.total == d.total && r.available == d.available)
                        .unwrap_or(false);
                    if fake_root {
                        continue;
                    }

                    d.label = name;
                    d.removable = true;
                    d.ico = "💾".into();
                    external.push(d);
                }
            }
        }

        // Отдельные устройства — первыми, по объёму; мелкие образы (Pake и пр.) внизу.
        // read_dir отдаёт произвольный порядок, поэтому сортировка обязательна:
        // иначе свежевставленная флешка уезжает за нижний край сайдбара.
        external.sort_by(|a, b| b.total.cmp(&a.total));

        internal.extend(external);
        internal
    })
    .await
    .unwrap_or_default()
}

// ---------- файловые операции ----------

fn unique_dest(dest: &Path) -> PathBuf {
    if !dest.exists() {
        return dest.to_path_buf();
    }
    let parent = dest.parent().unwrap_or(Path::new("/"));
    let stem = dest.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = dest.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for i in 1..10000 {
        let candidate = parent.join(format!("{stem} {i}{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dest.to_path_buf()
}

fn copy_with_progress(
    src: &Path,
    dst: &Path,
    app: &AppHandle,
    op_id: u64,
    done: &mut u64,
    total: u64,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<(), String> {
    use std::io::{Read, Write};
    if cancel.load(Ordering::Relaxed) {
        return Err("отменено".into());
    }
    if src.is_dir() {
        fs::create_dir_all(dst).map_err(|e| e.to_string())?;
        for item in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
            let name = item.file_name();
            copy_with_progress(&item.path(), &dst.join(name), app, op_id, done, total, cancel)?;
        }
    } else {
        let mut r = fs::File::open(src).map_err(|e| e.to_string())?;
        let mut w = fs::File::create(dst).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            if cancel.load(Ordering::Relaxed) {
                let _ = fs::remove_file(dst);
                return Err("отменено".into());
            }
            let n = r.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            w.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            *done += n as u64;
            let _ = app.emit(
                "op-progress",
                OpProgress {
                    op_id,
                    kind: "copy".into(),
                    done: *done,
                    total,
                    current: src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                    finished: false,
                    error: None,
                },
            );
        }
        if let Ok(meta) = fs::metadata(src) {
            if let Ok(t) = meta.modified() {
                if let Ok(f) = fs::File::options().write(true).open(dst) {
                    let _ = f.set_modified(t);
                }
            }
        }
    }
    Ok(())
}

fn count_bytes(path: &Path) -> u64 {
    if path.is_dir() {
        fs::read_dir(path).map(|rd| rd.flatten().map(|i| count_bytes(&i.path())).sum()).unwrap_or(0)
    } else {
        fs::metadata(path).map(|m| m.len()).unwrap_or(0)
    }
}

#[tauri::command]
async fn copy_paths(
    app: AppHandle,
    state: State<'_, AppState>,
    sources: Vec<String>,
    dest_dir: String,
) -> Result<u64, String> {
    let op_id = state.next_op.fetch_add(1, Ordering::SeqCst);
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    state.cancels.lock().unwrap().insert(op_id, cancel.clone());

    let dest = expand(&dest_dir);
    let srcs: Vec<PathBuf> = sources.iter().map(|s| expand(s)).collect();
    let app2 = app.clone();

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let total: u64 = srcs.iter().map(|p| count_bytes(p)).sum();
        let mut done = 0u64;
        let mut final_err = None;
        for src in &srcs {
            let name = match src.file_name() {
                Some(n) => n,
                None => {
                    final_err = Some("неверный путь".into());
                    break;
                }
            };
            let target = unique_dest(&dest.join(name));
            if let Err(e) = copy_with_progress(src, &target, &app2, op_id, &mut done, total, &cancel) {
                final_err = Some(e);
                break;
            }
        }
        let _ = app2.emit(
            "op-progress",
            OpProgress {
                op_id,
                kind: "copy".into(),
                done,
                total,
                current: String::new(),
                finished: true,
                error: final_err.clone(),
            },
        );
        match final_err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
    .map(|_| op_id)
}

#[tauri::command]
async fn move_paths(
    app: AppHandle,
    state: State<'_, AppState>,
    sources: Vec<String>,
    dest_dir: String,
) -> Result<u64, String> {
    let op_id = state.next_op.fetch_add(1, Ordering::SeqCst);
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    state.cancels.lock().unwrap().insert(op_id, cancel.clone());

    let dest = expand(&dest_dir);
    let srcs: Vec<PathBuf> = sources.iter().map(|s| expand(s)).collect();
    let app2 = app.clone();

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let total: u64 = srcs.iter().map(|p| count_bytes(p)).sum();
        let mut done = 0u64;
        let mut final_err = None;
        for src in &srcs {
            if cancel.load(Ordering::Relaxed) {
                final_err = Some("отменено".into());
                break;
            }
            let name = match src.file_name() {
                Some(n) => n,
                None => {
                    final_err = Some("неверный путь".into());
                    break;
                }
            };
            let target = unique_dest(&dest.join(name));
            if fs::rename(&src, &target).is_err() {
                if let Err(e) = copy_with_progress(&src, &target, &app2, op_id, &mut done, total, &cancel) {
                    final_err = Some(e);
                    break;
                }
                if let Err(e) = fs::remove_dir_all(&src).or_else(|_| fs::remove_file(&src)) {
                    final_err = Some(e.to_string());
                    break;
                }
            } else {
                done += count_bytes(&target);
            }
            let _ = app2.emit(
                "op-progress",
                OpProgress {
                    op_id,
                    kind: "move".into(),
                    done,
                    total,
                    current: src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                    finished: false,
                    error: None,
                },
            );
        }
        let _ = app2.emit(
            "op-progress",
            OpProgress {
                op_id,
                kind: "move".into(),
                done,
                total,
                current: String::new(),
                finished: true,
                error: final_err.clone(),
            },
        );
        match final_err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
    .map(|_| op_id)
}

/// Удаление в Корзину через Finder (нативно, восстановимо).
#[tauri::command]
async fn trash_paths(paths: Vec<String>) -> Result<(), String> {
    let expanded: Vec<String> = paths.iter().map(|p| expand(p).to_string_lossy().to_string()).collect();
    let list = expanded
        .iter()
        .map(|p| format!("POSIX file \"{}\"", p.replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(", ");
    let script = format!("tell application \"Finder\" to delete {{{list}}}");
    let out = tokio::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

#[tauri::command]
async fn delete_paths(paths: Vec<String>) -> Result<(), String> {
    for p in paths {
        let path = expand(&p);
        if path.is_dir() {
            fs::remove_dir_all(&path).map_err(|e| format!("{}: {}", path.display(), e))?;
        } else {
            fs::remove_file(&path).map_err(|e| format!("{}: {}", path.display(), e))?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn rename_path(from: String, to_name: String) -> Result<String, String> {
    let src = expand(&from);
    let parent = src.parent().ok_or("нет родителя")?;
    let dst = parent.join(&to_name);
    if dst.exists() {
        return Err("файл с таким именем уже есть".into());
    }
    fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().to_string())
}

#[tauri::command]
async fn create_dir(parent: String, name: String) -> Result<String, String> {
    let p = expand(&parent).join(&name);
    fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
async fn create_file(parent: String, name: String) -> Result<String, String> {
    let p = expand(&parent).join(&name);
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    // docx/xlsx — это ZIP-контейнеры; пустой файл Office не откроет,
    // поэтому кладём минимальный валидный скелет.
    match ext.as_str() {
        "docx" => write_min_docx(&p)?,
        "xlsx" => write_min_xlsx(&p)?,
        _ => {
            fs::File::create(&p).map_err(|e| e.to_string())?;
        }
    }
    Ok(p.to_string_lossy().to_string())
}

/// Минимальный валидный .docx (пустой документ Word).
fn write_min_docx(path: &Path) -> Result<(), String> {
    use std::io::Write as _;
    let f = fs::File::create(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(f);
    let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default();
    let files: [(&str, &str); 4] = [
        (
            "[Content_Types].xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
        ),
        (
            "_rels/.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#,
        ),
        (
            "word/document.xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>"#,
        ),
        (
            "word/_rels/document.xml.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>"#,
        ),
    ];
    for (name, body) in files {
        zip.start_file(name, opts).map_err(|e| e.to_string())?;
        zip.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// Минимальный валидный .xlsx (одна пустая книга).
fn write_min_xlsx(path: &Path) -> Result<(), String> {
    use std::io::Write as _;
    let f = fs::File::create(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(f);
    let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default();
    let files: [(&str, &str); 5] = [
        (
            "[Content_Types].xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
        ),
        (
            "_rels/.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
        ),
        (
            "xl/workbook.xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Лист1" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
        ),
        (
            "xl/_rels/workbook.xml.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
        ),
        (
            "xl/worksheets/sheet1.xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>"#,
        ),
    ];
    for (name, body) in files {
        zip.start_file(name, opts).map_err(|e| e.to_string())?;
        zip.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn cancel_op(state: State<'_, AppState>, op_id: u64) -> Result<(), String> {
    if let Some(flag) = state.cancels.lock().unwrap().get(&op_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Поиск по имени в поддереве (с ограничением глубины и количества).
#[tauri::command]
async fn search_tree(root: String, query: String, limit: usize) -> Result<Vec<Entry>, String> {
    let root_path = expand(&root);
    let q = query.to_lowercase();
    tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        let mut stack = vec![(root_path, 0usize)];
        while let Some((dir, depth)) = stack.pop() {
            if out.len() >= limit || depth > 12 {
                break;
            }
            let rd = match fs::read_dir(&dir) {
                Ok(r) => r,
                Err(_) => continue,
            };
            for item in rd.flatten() {
                let p = item.path();
                let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
                if let Some(e) = entry_from(&p, is_dir) {
                    if e.name.to_lowercase().contains(&q) {
                        out.push(e.clone());
                        if out.len() >= limit {
                            break;
                        }
                    }
                    if is_dir && !e.is_hidden {
                        stack.push((p, depth + 1));
                    }
                }
            }
        }
        Ok::<Vec<Entry>, String>(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Открыть файл системным приложением.
#[tauri::command]
async fn open_path(path: String) -> Result<(), String> {
    let p = expand(&path);
    tokio::process::Command::new("open").arg(&p).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Показать в Finder.
#[tauri::command]
async fn reveal_path(path: String) -> Result<(), String> {
    let p = expand(&path);
    tokio::process::Command::new("open").arg("-R").arg(&p).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            list_dir,
            home_dir,
            special_dirs,
            disk_info,
            copy_paths,
            move_paths,
            trash_paths,
            delete_paths,
            rename_path,
            create_dir,
            create_file,
            cancel_op,
            search_tree,
            open_path,
            reveal_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
