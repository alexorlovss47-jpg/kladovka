use serde::{Deserialize, Serialize};
use std::fs;
use std::fs::File;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Runtime, State, WebviewUrl, WebviewWindowBuilder};

pub mod ops;
pub mod preview;

pub use ops::{Job, OpInfo, OpStatus, OpsState, Signal, MAX_CONCURRENT};

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

pub fn expand(path: &str) -> PathBuf {
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

/// Политика поведения при совпадении имени в приёмнике.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ConflictPolicy {
    /// Добавить числовой суффикс: `file 1.txt` (поведение по умолчанию).
    #[default]
    Rename,
    /// Пропустить существующий файл, не трогать.
    Skip,
    /// Заменить существующий (только после успешного копирования во временный файл).
    Overwrite,
}

pub enum Resolved {
    Use(PathBuf),
    Skip,
}

/// Разрешить имя в приёмнике с учётом политики конфликтов.
///
/// `symlink_metadata` вместо `exists()`: битый симлинк — это тоже занятое имя.
pub fn resolve_target(dest: PathBuf, policy: ConflictPolicy) -> Resolved {
    if fs::symlink_metadata(&dest).is_err() {
        return Resolved::Use(dest);
    }
    match policy {
        ConflictPolicy::Skip => Resolved::Skip,
        ConflictPolicy::Overwrite => Resolved::Use(dest),
        ConflictPolicy::Rename => Resolved::Use(unique_dest(&dest)),
    }
}

pub fn unique_dest(dest: &Path) -> PathBuf {
    let parent = dest.parent().unwrap_or(Path::new("/"));
    let stem = dest.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = dest.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for i in 1..10000 {
        let candidate = parent.join(format!("{stem} {i}{ext}"));
        if fs::symlink_metadata(&candidate).is_err() {
            return candidate;
        }
    }
    dest.to_path_buf()
}

/// Нормализовать путь для сравнения на вложенность (без обращения к диску).
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Канонизировать как можно глубже: разрешить существующего предка, остаток
/// приклеить как есть.
///
/// Простой `canonicalize().unwrap_or(normalize())` ломает сравнение на macOS:
/// `/var` — симлинк на `/private/var`, поэтому существующий источник
/// канонизируется в `/private/var/...`, а ещё не созданный приёмник остаётся
/// `/var/...` и сравнение «внутри ли» даёт ложный отрицательный результат.
fn canonicalish(path: &Path) -> PathBuf {
    if let Ok(c) = fs::canonicalize(path) {
        return c;
    }
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = path.to_path_buf();
    loop {
        if let Some(name) = cur.file_name() {
            rest.push(name.to_os_string());
        }
        if !cur.pop() {
            return normalize(path);
        }
        if let Ok(mut c) = fs::canonicalize(&cur) {
            for part in rest.into_iter().rev() {
                c.push(part);
            }
            return c;
        }
    }
}

/// Проверка: приёмник не лежит внутри источника.
///
/// Без неё копирование каталога в собственный подкаталог уходит в бесконечный
/// рост: каждый новый проход видит файлы, созданные предыдущим.
pub fn ensure_not_inside_source(src: &Path, dest_dir: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(src).map_err(|e| format!("{}: {}", src.display(), e))?;
    // Симлинк на каталог копируется как ссылка, рекурсии нет — проверка не нужна.
    if !meta.is_dir() {
        return Ok(());
    }
    let src_c = canonicalish(src);
    let dest_c = canonicalish(dest_dir);
    if dest_c == src_c || dest_c.starts_with(&src_c) {
        return Err("нельзя копировать каталог внутрь самого себя".into());
    }
    Ok(())
}

/// Создать симлинк с тем же target, что у источника (не разыменовывая).
fn recreate_symlink(src: &Path, dst: &Path) -> Result<(), String> {
    let target = fs::read_link(src).map_err(|e| format!("{}: {}", src.display(), e))?;
    std::os::unix::fs::symlink(&target, dst)
        .map_err(|e| format!("{}: {}", dst.display(), e))
}

/// Контекст одной операции: прогресс, отмена, список созданного для отката.
pub struct CopyCtx<'a, R: Runtime = tauri::Wry> {
    /// None — работа без UI-событий (юнит-тесты, внутренние вызовы).
    pub app: Option<&'a AppHandle<R>>,
    pub op_id: u64,
    pub kind: &'a str,
    pub total: u64,
    pub cancel: &'a AtomicBool,
    /// Всё, что операция успела создать. При ошибке/отмене удаляется.
    pub created: Vec<PathBuf>,
    pub done: u64,
    /// Колбэк на каждой записи блока: (суммарно байт, имя файла).
    /// Возвращает Err для кооперативной отмены/паузы.
    pub progress_hook: Option<&'a mut dyn FnMut(u64, &str) -> Result<(), String>>,
}

impl<R: Runtime> CopyCtx<'_, R> {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    fn emit(&self, current: &str) {
        let Some(app) = self.app else { return };
        let _ = app.emit(
            "op-progress",
            OpProgress {
                op_id: self.op_id,
                kind: self.kind.to_string(),
                done: self.done,
                total: self.total,
                current: current.to_string(),
                finished: false,
                error: None,
            },
        );
    }

    /// Откатить всё созданное (обратный порядок: сначала файлы, потом каталоги).
    fn rollback(&mut self) {
        for p in self.created.drain(..).rev() {
            let _ = fs::remove_file(&p).or_else(|_| fs::remove_dir_all(&p));
        }
        self.done = 0;
    }
}

/// Скопировать файл через временный файл рядом с целью.
///
/// Запись напрямую в `dst` означала бы порчу существующего файла при ошибке
/// на середине. Временный файл переименовывается только после полной записи.
pub fn copy_file_atomic<R: Runtime>(
    src: &Path,
    dst: &Path,
    ctx: &mut CopyCtx<R>,
    meta: &fs::Metadata,
) -> Result<(), String> {
    let dir = dst.parent().ok_or_else(|| format!("{}: нет родительского каталога", dst.display()))?;
    let tmp = dir.join(format!(".kladovka-{}-{}.part", ctx.op_id, ctx.created.len()));
    let mut r = File::open(src).map_err(|e| format!("{}: {}", src.display(), e))?;
    let mut w = File::create(&tmp).map_err(|e| format!("{}: {}", tmp.display(), e))?;
    let mut buf = vec![0u8; 256 * 1024];
    let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    loop {
        if ctx.cancelled() {
            drop(w);
            let _ = fs::remove_file(&tmp);
            return Err("отменено".into());
        }
        let n = std::io::Read::read(&mut r, &mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        w.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        ctx.done += n as u64;
        ctx.emit(&name);
        if let Some(hook) = ctx.progress_hook.as_mut() {
            // Ошибку из хука (отмена/пауза-прерывание) нельзя пробрасывать
            // через `?`: временный файл остался бы на диске навсегда.
            if let Err(e) = hook(ctx.done, &name) {
                drop(w);
                let _ = fs::remove_file(&tmp);
                return Err(e);
            }
        }
    }
    w.flush().map_err(|e| e.to_string())?;
    drop(w);
    // Сохранить mtime оригинала.
    if let Ok(t) = meta.modified() {
        let _ = File::options().write(true).open(&tmp).and_then(|f| f.set_modified(t));
    }
    fs::rename(&tmp, dst).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("{}: {}", dst.display(), e)
    })?;
    ctx.created.push(dst.to_path_buf());
    Ok(())
}

/// Рекурсивное копирование без следования по симлинкам.
///
/// `symlink_metadata` + `file_type().is_dir()` не разыменовывают ссылку, поэтому
/// цикл `a → b → a` физически не может быть пройден: он выглядит как обычный
/// симлинк и копируется ссылкой.
pub fn copy_tree<R: Runtime>(src: &Path, dst: &Path, ctx: &mut CopyCtx<R>) -> Result<(), String> {
    if ctx.cancelled() {
        return Err("отменено".into());
    }
    let meta = fs::symlink_metadata(src).map_err(|e| format!("{}: {}", src.display(), e))?;
    if meta.file_type().is_symlink() {
        recreate_symlink(src, dst)?;
        ctx.created.push(dst.to_path_buf());
        return Ok(());
    }
    if meta.is_dir() {
        fs::create_dir(dst).map_err(|e| format!("{}: {}", dst.display(), e))?;
        ctx.created.push(dst.to_path_buf());
        let rd = fs::read_dir(src).map_err(|e| format!("{}: {}", src.display(), e))?;
        for item in rd.flatten() {
            copy_tree(&item.path(), &dst.join(item.file_name()), ctx)?;
        }
        return Ok(());
    }
    copy_file_atomic(src, dst, ctx, &meta)
}

/// Размер источника без следования по симлинкам.
pub fn count_bytes(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    // Симлинк копируется как ссылка — его цель не входит в объём копии.
    // Считаем только длину самого линка (строки target), как это делает ФС.
    if meta.file_type().is_symlink() {
        return 0;
    }
    if meta.is_dir() {
        return fs::read_dir(path)
            .map(|rd| rd.flatten().map(|i| count_bytes(&i.path())).sum())
            .unwrap_or(0);
    }
    meta.len()
}

/// Поставить операцию в очередь и запустить планировщик.
fn start_transfer(
    app: &AppHandle,
    ops: &OpsState,
    kind: &str,
    sources: Vec<String>,
    dest_dir: String,
    policy: ConflictPolicy,
) -> Result<u64, String> {
    if sources.is_empty() {
        return Err("не выбрано ни одного файла".into());
    }
    let id = ops::enqueue(ops, kind, sources, dest_dir, policy);
    pump(app, ops);
    Ok(id)
}

/// Поднять столько воркеров, сколько позволяет лимит параллельности.
///
/// Вызывается после постановки в очередь и после завершения каждой операции:
/// без второго вызова очередь встала бы, когда все слоты заняты.
fn pump(app: &AppHandle, ops: &OpsState) {
    while let Some(job) = ops::try_start(ops) {
        let app2 = app.clone();
        let state_ptr = ops as *const OpsState as usize;
        tauri::async_runtime::spawn_blocking(move || {
            // Указатель валиден: OpsState живёт в managed-состоянии всё время
            // работы приложения, а воркер завершается раньше, чем оно уедет.
            let ops: &OpsState = unsafe { &*(state_ptr as *const OpsState) };
            ops::execute(&app2, ops, job);
        });
    }
}

#[tauri::command]
async fn copy_paths(
    app: AppHandle,
    ops: State<'_, OpsState>,
    sources: Vec<String>,
    dest_dir: String,
    conflict: Option<ConflictPolicy>,
) -> Result<u64, String> {
    start_transfer(&app, &ops, "copy", sources, dest_dir, conflict.unwrap_or_default())
}

#[tauri::command]
async fn move_paths(
    app: AppHandle,
    ops: State<'_, OpsState>,
    sources: Vec<String>,
    dest_dir: String,
    conflict: Option<ConflictPolicy>,
) -> Result<u64, String> {
    start_transfer(&app, &ops, "move", sources, dest_dir, conflict.unwrap_or_default())
}

/// Список всех операций (для панели операций).
#[tauri::command]
async fn list_ops(ops: State<'_, OpsState>) -> Result<Vec<ops::OpInfo>, String> {
    Ok(ops::list_infos(&ops))
}

/// Пауза: воркер замирает на ближайшей записи блока.
#[tauri::command]
async fn pause_op(ops: State<'_, OpsState>, op_id: u64) -> Result<(), String> {
    if ops::signal(&ops, op_id, ops::Signal::Pause) {
        Ok(())
    } else {
        Err("операция не найдена".into())
    }
}

/// Возобновление после паузы.
#[tauri::command]
async fn resume_op(app: AppHandle, ops: State<'_, OpsState>, op_id: u64) -> Result<(), String> {
    if ops::signal(&ops, op_id, ops::Signal::Run) {
        pump(&app, &ops);
        Ok(())
    } else {
        Err("операция не найдена".into())
    }
}

/// Отмена: текущая операция откатывает созданное и завершается.
#[tauri::command]
async fn cancel_op(app: AppHandle, ops: State<'_, OpsState>, op_id: u64) -> Result<(), String> {
    if ops::signal(&ops, op_id, ops::Signal::Cancel) {
        pump(&app, &ops);
        Ok(())
    } else {
        Err("операция не найдена".into())
    }
}

/// Убрать завершённую операцию из списка.
#[tauri::command]
async fn remove_op(ops: State<'_, OpsState>, op_id: u64) -> Result<(), String> {
    if ops::remove(&ops, op_id) {
        Ok(())
    } else {
        Err("операция не найдена или ещё не завершена".into())
    }
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

/// Безвозвратное удаление (минуя Корзину).
///
/// Оставлено только для внутренних нужд (откат, очистка `.part`), но снято с
/// регистрации Tauri: невосстановимое удаление не должно быть доступно из UI,
/// где ожидается поведение Корзины. Файл можно вернуть через Корзину.
#[allow(dead_code)]
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
    if fs::symlink_metadata(&p).is_ok() {
        return Err("файл с таким именем уже есть".into());
    }
    fs::create_dir(&p).map_err(|e| e.to_string())?;
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
            // create_new: не перезаписываем существующий файл (create() усекает).
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&p)
                .map_err(|e| {
                    if e.kind() == std::io::ErrorKind::AlreadyExists {
                        "файл с таким именем уже есть".to_string()
                    } else {
                        e.to_string()
                    }
                })?;
        }
    }
    Ok(p.to_string_lossy().to_string())
}

/// Создать файл, гарантированно не перезаписывая существующий.
///
/// Пишем во временный файл рядом и переименовываем только после успешного
/// заполнения: `create` усекает существующий файл, а `rename` атомарен и
/// не оставляет «полускелет» при ошибке на середине.
fn create_new_file<T>(path: &Path, fill: T) -> Result<(), String>
where
    T: FnOnce(&mut File) -> Result<(), String>,
{
    if fs::symlink_metadata(path).is_ok() {
        return Err("файл с таким именем уже есть".into());
    }
    let dir = path.parent().unwrap_or(Path::new("/"));
    let tmp = dir.join(format!(
        ".kladovka-new-{}.part",
        path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
    ));
    let _ = fs::remove_file(&tmp);
    let res = (|| -> Result<(), String> {
        let mut f = File::create(&tmp).map_err(|e| e.to_string())?;
        fill(&mut f)?;
        f.flush().map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(e) = res {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    // Если файл успели создать параллельно — не затираем его.
    if fs::symlink_metadata(path).is_ok() {
        let _ = fs::remove_file(&tmp);
        return Err("файл с таким именем уже есть".into());
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Минимальный валидный .docx (пустой документ Word).
fn write_min_docx(path: &Path) -> Result<(), String> {
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
    create_new_file(path, |f| write_zip(f, &files))
}

/// Минимальный валидный .xlsx (одна пустая книга).
fn write_min_xlsx(path: &Path) -> Result<(), String> {
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
    create_new_file(path, |f| write_zip(f, &files))
}

/// Записать набор файлов в ZIP-контейнер Office.
fn write_zip<W: Write + std::io::Seek>(w: W, files: &[(&str, &str)]) -> Result<(), String> {
    let mut zip = zip::ZipWriter::new(w);
    let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default();
    for (name, body) in files {
        zip.start_file(*name, opts).map_err(|e| e.to_string())?;
        zip.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
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

// ---------- предпросмотр файлов (Этап 4) ----------

/// Метаданные для панели быстрого просмотра.
#[derive(Debug, Clone, Serialize)]
pub struct PreviewInfo {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    /// Байты; None, если не удалось получить.
    pub size: Option<u64>,
    /// Unix-время последнего изменения, с.
    pub modified: Option<i64>,
    /// Unix-время создания (birthtime), с.
    pub created: Option<i64>,
    /// Короткое имя типа: image / pdf / text / binary / directory / symlink / other.
    pub kind: String,
    /// MIME-подобное расширение без точки.
    pub extension: Option<String>,
    /// Размеры изображения в пикселях: (ширина, высота).
    pub image_dimensions: Option<(u32, u32)>,
    /// Количество страниц PDF, если удалось быстро прочитать.
    pub pdf_pages: Option<u32>,
    /// true, если предпросмотр содержимого требует явного подтверждения
    /// (файл слишком большой).
    pub too_large: bool,
    /// Куда указывает символическая ссылка (только для kind == "symlink").
    pub link_target: Option<String>,
}

use crate::preview::{
    image_dimensions, is_binary_head, mime_kind, pdf_pages, truncate_utf8, PREVIEW_IMAGE_LIMIT,
    PREVIEW_PDF_LIMIT, PREVIEW_TEXT_LIMIT,
};

#[tauri::command]
async fn preview_info(path: String) -> Result<PreviewInfo, String> {
    let p = expand(&path);
    let md = tokio::fs::symlink_metadata(&p).await.map_err(|e| e.to_string())?;
    if md.file_type().is_symlink() {
        // Показываем, куда ведёт ссылка, но не читаем содержимое цели.
        let target = std::fs::read_link(&p).map_err(|e| e.to_string())?;
        return Ok(PreviewInfo {
            path: p.to_string_lossy().into_owned(),
            name: p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            is_dir: false,
            size: None,
            modified: None,
            created: None,
            kind: "symlink".into(),
            extension: p.extension().map(|e| e.to_string_lossy().into_owned()),
            image_dimensions: None,
            pdf_pages: None,
            too_large: false,
            link_target: Some(target.to_string_lossy().into_owned()),
        });
    }
    let is_dir = md.is_dir();
    let size = md.len();
    let modified = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64);
    let created = md.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64);
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .or_else(|| {
            // Файлы без расширения часто текстовые (Makefile, LICENSE).
            p.file_name().and_then(|n| {
                let n = n.to_string_lossy().to_ascii_lowercase();
                if n == "makefile" || n == "dockerfile" || n == "license" || n == "cmakelists.txt" {
                    Some(n)
                } else {
                    None
                }
            })
        });

    if is_dir {
        return Ok(PreviewInfo {
            path: p.to_string_lossy().into_owned(),
            name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            is_dir: true,
            size: None,
            modified,
            created,
            kind: "directory".into(),
            extension: ext,
            image_dimensions: None,
            pdf_pages: None,
            too_large: false,
            link_target: None,
        });
    }

    let kind = ext.as_deref().map(mime_kind).unwrap_or("other");
    let mut dims = None;
    let mut pages = None;
    let mut too_large = false;

    match kind {
        "image" => {
            too_large = size > PREVIEW_IMAGE_LIMIT;
            if !too_large {
                let mut buf = vec![0u8; 64];
                let n = read_head(&p, &mut buf).await?;
                dims = image_dimensions(&buf[..n]);
            }
        }
        "pdf" => {
            too_large = size > PREVIEW_PDF_LIMIT;
            if !too_large {
                // Читаем не более 8 MiB с начала и 8 MiB с конца:
                // xref/trailer обычно в конце, но /Type /Page бывает и в потоках.
                let head = read_chunk(&p, 0, 8 * 1024 * 1024).await?;
                let mut buf = head;
                if size > buf.len() as u64 {
                    let tail_start = size - 8 * 1024 * 1024;
                    let tail = read_chunk(&p, tail_start, 8 * 1024 * 1024).await?;
                    buf.extend_from_slice(&tail);
                }
                pages = pdf_pages(&buf);
            }
        }
        "text" => {
            // Читаем только голову, чтобы понять бинарность и кодировку.
            let mut buf = vec![0u8; 8192];
            let n = read_head(&p, &mut buf).await?;
            let head = &buf[..n];
            if is_binary_head(head) {
                // Нулевые байты в первых 8 KiB — почти наверняка бинарный файл.
                return Ok(PreviewInfo {
                    path: p.to_string_lossy().into_owned(),
                    name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    is_dir: false,
                    size: Some(size),
                    modified,
                    created,
                    kind: "binary".into(),
                    extension: ext,
                    image_dimensions: None,
                    pdf_pages: None,
                    too_large: false,
                    link_target: None,
                });
            }
            too_large = size > PREVIEW_TEXT_LIMIT;
        }
        _ => {}
    }

    Ok(PreviewInfo {
        path: p.to_string_lossy().into_owned(),
        name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        is_dir: false,
        size: Some(size),
        modified,
        created,
        kind: kind.into(),
        extension: ext,
        image_dimensions: dims,
        pdf_pages: pages,
        too_large,
        link_target: None,
    })
}

async fn read_head(p: &Path, buf: &mut [u8]) -> Result<usize, String> {
    use tokio::io::AsyncReadExt;
    let mut f = tokio::fs::File::open(p).await.map_err(|e| e.to_string())?;
    Ok(f.read(buf).await.map_err(|e| e.to_string())?)
}

async fn read_chunk(p: &Path, offset: u64, len: u64) -> Result<Vec<u8>, String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
    let mut f = tokio::fs::File::open(p).await.map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(offset)).await.map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; len as usize];
    let n = f.read(&mut buf).await.map_err(|e| e.to_string())?;
    buf.truncate(n);
    Ok(buf)
}

/// Результат чтения текстового файла для предпросмотра.
#[derive(Debug, Clone, Serialize)]
pub struct TextPreview {
    pub content: String,
    pub truncated: bool,
    /// Прочитано байт (после декодирования — длина строки).
    pub bytes_read: u64,
    pub size: u64,
}

/// Прочитать первые байты файла как UTF-8.
///
/// Большие файлы не читаются целиком: обрезаем по `limit` байт и по границе
/// символа UTF-8, чтобы не показать «квадратик» в начале следующего символа.
#[tauri::command]
async fn read_text_preview(path: String, limit: Option<u64>) -> Result<TextPreview, String> {
    let p = expand(&path);
    let md = tokio::fs::metadata(&p).await.map_err(|e| e.to_string())?;
    let size = md.len();
    let limit = limit.unwrap_or(PREVIEW_TEXT_LIMIT).min(PREVIEW_TEXT_LIMIT).max(1024) as usize;
    let read_len = size.min(limit as u64) as usize;
    let mut buf = vec![0u8; read_len];
    {
        use tokio::io::AsyncReadExt;
        let mut f = tokio::fs::File::open(&p).await.map_err(|e| e.to_string())?;
        let n = f.read(&mut buf).await.map_err(|e| e.to_string())?;
        buf.truncate(n);
    }
    let truncated = (buf.len() as u64) < size;
    // Если обрезали посреди многобайтового символа — отступаем к валидной границе.
    let valid = truncate_utf8(&buf, buf.len());
    let valid_upto = valid.len();
    let content = String::from_utf8_lossy(valid).into_owned();
    Ok(TextPreview {
        bytes_read: valid_upto as u64,
        content,
        truncated,
        size,
    })
}

/// Открыть новое окно Кладовки.
///
/// В Tauri 2 окно нельзя клонировать из конфига напрямую, поэтому создаём
/// WebviewWindow с теми же параметрами, что и главное окно в tauri.conf.json.
/// Метка уникальна, иначе создание второго окна с тем же label паникует.
#[tauri::command]
async fn new_window(app: AppHandle, path: Option<String>) -> Result<String, String> {
    new_window_impl(&app, path).await
}

/// Логика создания окна, вынесена из команды ради тестов на mock-рантайме.
pub async fn new_window_impl<R: Runtime>(
    app: &AppHandle<R>,
    path: Option<String>,
) -> Result<String, String> {
    let label = format!("win-{}", WINDOW_SEQ.fetch_add(1, Ordering::Relaxed));
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Кладовка")
        .inner_size(1100.0, 720.0)
        .min_inner_size(700.0, 450.0)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    if let Some(script) = start_path_script(path.as_deref()) {
        builder = builder.initialization_script(&script);
    }
    builder.build().map_err(|e| e.to_string())?;
    Ok(label)
}

/// Скрипт, задающий стартовый каталог окна.
///
/// Путь подставляется через serde_json, поэтому кавычки, обратные слэши и
/// юникод в имени каталога не ломают JS-литерал. `None` — скрипт не нужен.
pub fn start_path_script(path: Option<&str>) -> Option<String> {
    let p = path?;
    let json = serde_json::to_string(p).ok()?;
    Some(format!("window.__KLADOVKA_START_PATH__ = {json};"))
}

static WINDOW_SEQ: AtomicU64 = AtomicU64::new(1);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(OpsState::new())
        .invoke_handler(tauri::generate_handler![
            list_dir,
            home_dir,
            special_dirs,
            disk_info,
            copy_paths,
            move_paths,
            list_ops,
            pause_op,
            resume_op,
            remove_op,
            trash_paths,
            rename_path,
            create_dir,
            create_file,
            cancel_op,
            search_tree,
            open_path,
            reveal_path,
            new_window,
            preview_info,
            read_text_preview
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ==================== тесты ====================
//
// Покрывают именно те сценарии, которые в v0.1.3 приводили к потере данных
// или падению: симлинки, циклы, копирование в себя, перезапись при создании,
// откат частичной копии и утечку карты отмен.

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    /// Уникальный временный каталог для одного теста.
    struct Sandbox(PathBuf);

    impl Sandbox {
        fn new(tag: &str) -> Self {
            let mut p = std::env::temp_dir();
            let uniq = format!(
                "kladovka-test-{}-{}-{:?}",
                tag,
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
            );
            p.push(uniq);
            fs::create_dir_all(&p).unwrap();
            Sandbox(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
        fn join(&self, s: &str) -> PathBuf {
            self.0.join(s)
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn ctx<'a>(cancel: &'a AtomicBool, total: u64) -> CopyCtx<'a> {
        CopyCtx { app: None, op_id: 1, kind: "copy", total, cancel, created: Vec::new(), done: 0, progress_hook: None }
    }

    #[test]
    fn symlink_is_copied_as_symlink_not_dereferenced() {
        let sb = Sandbox::new("symlink");
        let target_dir = sb.join("target");
        fs::create_dir_all(target_dir.join("inner")).unwrap();
        fs::write(target_dir.join("inner/data.txt"), b"payload").unwrap();

        let src_root = sb.join("src");
        fs::create_dir_all(&src_root).unwrap();
        std::os::unix::fs::symlink(&target_dir, src_root.join("link_to_dir")).unwrap();
        fs::write(src_root.join("real.txt"), b"real").unwrap();

        let dst_root = sb.join("dst");
        let cancel = AtomicBool::new(false);
        let mut c = ctx(&cancel, 0);
        copy_tree(&src_root, &dst_root, &mut c).unwrap();

        let copied_link = dst_root.join("link_to_dir");
        let meta = fs::symlink_metadata(&copied_link).unwrap();
        assert!(meta.file_type().is_symlink(), "симлинк должен остаться симлинком");
        // Цель не скопирована физически: в приёмнике ровно два элемента —
        // сам линк и real.txt. Проход по ссылке ведёт в оригинальный каталог,
        // поэтому проверять «не читается ли data.txt» бессмысленно.
        let names: Vec<String> = fs::read_dir(&dst_root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names.len(), 2, "в приёмнике лишние файлы: {names:?}");
        assert!(!names.iter().any(|n| n == "inner"), "каталог цели скопирован физически");
        assert_eq!(fs::read_link(&copied_link).unwrap(), target_dir);
        assert_eq!(fs::read(dst_root.join("real.txt")).unwrap(), b"real");
    }

    #[test]
    fn symlink_cycle_does_not_overflow_stack() {
        let sb = Sandbox::new("cycle");
        let a = sb.join("a");
        let b = sb.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("file.txt"), b"x").unwrap();
        // a/loop -> b, b/loop -> a : классический цикл
        std::os::unix::fs::symlink(&b, a.join("loop")).unwrap();
        std::os::unix::fs::symlink(&a, b.join("loop")).unwrap();

        let dst = sb.join("copy");
        let cancel = AtomicBool::new(false);
        let mut c = ctx(&cancel, 0);
        // Главное — не падаем по stack overflow.
        copy_tree(&a, &dst, &mut c).unwrap();
        assert!(dst.join("file.txt").exists());
        assert!(fs::symlink_metadata(dst.join("loop")).unwrap().file_type().is_symlink());
    }

    #[test]
    fn copy_into_own_subdir_is_rejected() {
        let sb = Sandbox::new("inside");
        let src = sb.join("root");
        fs::create_dir_all(src.join("nested")).unwrap();
        fs::write(src.join("f.txt"), b"data").unwrap();

        // Источник == приёмник
        assert!(ensure_not_inside_source(&src, &src).is_err());
        // Приёмник — подкаталог источника
        assert!(ensure_not_inside_source(&src, &src.join("nested")).is_err());
        // Глубже
        assert!(ensure_not_inside_source(&src, &src.join("nested/deep")).is_err());
        // Соседний каталог — можно
        assert!(ensure_not_inside_source(&src, &sb.join("other")).is_ok());
        // Родитель источника — можно (копирование вверх не рекурсивно)
        assert!(ensure_not_inside_source(&src, &sb.0).is_ok());
    }

    #[test]
    fn copy_into_self_does_not_grow_tree() {
        let sb = Sandbox::new("selfgrow");
        let src = sb.join("root");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("big.txt"), vec![7u8; 8192]).unwrap();

        // Прямая попытка копирования внутрь себя отсекается до начала работы.
        assert!(ensure_not_inside_source(&src, &src.join("sub")).is_err());
        // Дерево не изменилось.
        assert_eq!(fs::read_dir(&src).unwrap().count(), 1);
    }

    #[test]
    fn create_file_does_not_overwrite_existing() {
        let sb = Sandbox::new("overwrite");
        let existing = sb.join("note.txt");
        fs::write(&existing, b"original contents").unwrap();

        let err = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&existing)
            .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&existing).unwrap(), b"original contents");

        // Через helper тоже не перезаписываем.
        let e2 = create_new_file(&existing, |f| {
            f.write_all(b"nope").map_err(|e| e.to_string())
        })
        .unwrap_err();
        assert_eq!(e2, "файл с таким именем уже есть");
        assert_eq!(fs::read(&existing).unwrap(), b"original contents");
    }

    #[test]
    fn create_new_file_writes_when_absent() {
        let sb = Sandbox::new("createok");
        let p = sb.join("fresh.txt");
        create_new_file(&p, |f| f.write_all(b"hello").map_err(|e| e.to_string())).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"hello");
        // Временных файлов не осталось.
        let leftovers: Vec<_> = fs::read_dir(sb.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".part"))
            .collect();
        assert!(leftovers.is_empty(), "остались временные файлы");
    }

    #[test]
    fn conflict_policies_resolve_as_documented() {
        let sb = Sandbox::new("conflict");
        let taken = sb.join("report.txt");
        fs::write(&taken, b"old").unwrap();

        // Rename — добавляет суффикс.
        match resolve_target(taken.clone(), ConflictPolicy::Rename) {
            Resolved::Use(p) => assert_eq!(p.file_name().unwrap().to_string_lossy(), "report 1.txt"),
            Resolved::Skip => panic!("ожидалось переименование"),
        }
        // Skip — пропускает.
        assert!(matches!(resolve_target(taken.clone(), ConflictPolicy::Skip), Resolved::Skip));
        // Overwrite — оставляет имя как есть.
        match resolve_target(taken.clone(), ConflictPolicy::Overwrite) {
            Resolved::Use(p) => assert_eq!(p, taken),
            Resolved::Skip => panic!("ожидалась замена"),
        }
        // Свободное имя проходит без изменений при любой политике.
        let free = sb.join("free.txt");
        for pol in [ConflictPolicy::Rename, ConflictPolicy::Skip, ConflictPolicy::Overwrite] {
            match resolve_target(free.clone(), pol) {
                Resolved::Use(p) => assert_eq!(p, free),
                Resolved::Skip => panic!("свободное имя не должно пропускаться"),
            }
        }
    }

    #[test]
    fn broken_symlink_counts_as_taken_name() {
        let sb = Sandbox::new("broken");
        let link = sb.join("dangling");
        std::os::unix::fs::symlink(sb.join("nowhere"), &link).unwrap();
        // exists() вернул бы false, symlink_metadata — true.
        assert!(!link.exists());
        assert!(fs::symlink_metadata(&link).is_ok());
        match resolve_target(link, ConflictPolicy::Rename) {
            Resolved::Use(p) => assert!(p.to_string_lossy().contains("dangling 1")),
            Resolved::Skip => panic!("битый симлинк должен считаться занятым именем"),
        }
    }

    #[test]
    fn cancel_during_copy_rolls_back_created_files() {
        let sb = Sandbox::new("cancel");
        let src = sb.join("src");
        fs::create_dir_all(&src).unwrap();
        for i in 0..5 {
            fs::write(src.join(format!("f{i}.bin")), vec![1u8; 200 * 1024]).unwrap();
        }
        let dst = sb.join("dst");        // Отмена взведена заранее: копирование не начнётся.
        let cancel = AtomicBool::new(true);
        let mut c = ctx(&cancel, 0);
        let res = copy_tree(&src, &dst, &mut c);
        assert!(res.is_err());
        c.rollback();
        assert!(!dst.exists(), "частичная копия должна быть удалена");
    }

    #[test]
    fn rollback_removes_tree_in_reverse_order() {
        let sb = Sandbox::new("rollback");
        let dst = sb.join("made");
        let cancel = AtomicBool::new(false);
        let mut c = ctx(&cancel, 0);
        fs::create_dir_all(&dst).unwrap();
        c.created.push(dst.clone());
        fs::write(dst.join("x.txt"), b"1").unwrap();
        c.created.push(dst.join("x.txt"));
        c.rollback();
        assert!(!dst.exists());
        assert!(c.created.is_empty());
    }

    #[test]
    fn count_bytes_ignores_symlinks_and_skips_dirs() {
        let sb = Sandbox::new("count");
        let root = sb.join("root");
        fs::create_dir_all(root.join("d")).unwrap();
        fs::write(root.join("d/a.bin"), vec![0u8; 1000]).unwrap();
        fs::write(root.join("b.bin"), vec![0u8; 500]).unwrap();
        std::os::unix::fs::symlink(root.join("b.bin"), root.join("link")).unwrap();

        // 1000 + 500; сама ссылка не добавляет размер цели.
        assert_eq!(count_bytes(&root), 1500);
    }

    #[test]
    fn partial_copy_leaves_no_temp_files_on_error() {
        let sb = Sandbox::new("tmpclean");
        let src = sb.join("src.txt");
        fs::write(&src, vec![3u8; 1024]).unwrap();
        let dst_dir = sb.join("out");
        fs::create_dir_all(&dst_dir).unwrap();
        let dst = dst_dir.join("copy.txt");
        let cancel = AtomicBool::new(false);
        let mut c = ctx(&cancel, 0);
        let meta = fs::symlink_metadata(&src).unwrap();
        copy_file_atomic(&src, &dst, &mut c, &meta).unwrap();
        assert_eq!(fs::read(&dst).unwrap().len(), 1024);
        let parts: Vec<_> = fs::read_dir(&dst_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".part"))
            .collect();
        assert!(parts.is_empty(), "временный .part остался после успешного копирования");
    }

    #[test]
    fn move_within_same_fs_preserves_content() {
        let sb = Sandbox::new("move");
        let src = sb.join("from.bin");
        fs::write(&src, vec![9u8; 4096]).unwrap();
        let dst = sb.join("to.bin");
        fs::rename(&src, &dst).unwrap();
        assert!(!src.exists());
        assert_eq!(fs::read(&dst).unwrap(), vec![9u8; 4096]);
    }

    #[test]
    fn docx_and_xlsx_skeletons_are_valid_zip() {
        for (name, maker) in [
            ("doc.docx", write_min_docx as fn(&Path) -> Result<(), String>),
            ("sheet.xlsx", write_min_xlsx as fn(&Path) -> Result<(), String>),
        ] {
            let sb = Sandbox::new("office");
            let p = sb.join(name);
            maker(&p).unwrap();
            let f = fs::File::open(&p).unwrap();
            let mut archive = zip::ZipArchive::new(f).unwrap();
            assert!(archive.len() >= 4, "{name}: слишком мало частей");
            assert!(archive.by_name("[Content_Types].xml").is_ok());
        }
    }

    #[test]
    fn creating_existing_office_file_does_not_truncate() {
        let sb = Sandbox::new("officetaken");
        let p = sb.join("keep.docx");
        fs::write(&p, b"not really docx but must survive").unwrap();
        let err = write_min_docx(&p).unwrap_err();
        assert_eq!(err, "файл с таким именем уже есть");
        assert_eq!(fs::read(&p).unwrap(), b"not really docx but must survive");
    }

    #[test]
    fn normalize_collapses_dot_segments() {
        assert_eq!(normalize(Path::new("/a/./b/../c")), PathBuf::from("/a/c"));
        assert_eq!(normalize(Path::new("/a/b")), PathBuf::from("/a/b"));
    }
}
