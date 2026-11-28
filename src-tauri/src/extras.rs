//! Дополнительные возможности (Этап 6).
//!
//! Всё в чистых функциях, чтобы тестировать на песочнице без Tauri:
//! архивы, пакетное переименование, сравнение каталогов, размер папок.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

// ==================== архивы ====================

/// Результат архивации.
#[derive(Debug, Clone, Serialize)]
pub struct ArchiveResult {
    pub path: String,
    pub files: usize,
    pub bytes: u64,
}

/// Создать ZIP-архив из списка файлов/папок.
///
/// Имена внутри архива — относительные к общему предку. Если предок один,
/// архив не создаёт лишнюю папку-обёртку (удобно, когда выделили содержимое
/// каталога). Несколько разных предков дают полные имена.
pub fn create_archive(
    sources: &[PathBuf],
    destination: &Path,
    password: Option<&str>,
) -> Result<ArchiveResult, String> {
    if sources.is_empty() {
        return Err("Нет файлов для архивации".into());
    }
    let common = common_ancestor(sources);
    let mut files = 0usize;

    let file = fs::File::create(destination).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::FileOptions::<()>::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    for src in sources {
        let meta = fs::symlink_metadata(src).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            // Каталог как запись с завершающим слешем.
            let rel = relative_name(src, &common);
            let name = format!("{}/", rel.to_string_lossy().trim_end_matches('/'));
            zip.add_directory(name, opts).map_err(|e| e.to_string())?;
            visit_tree(src, &common, &mut |p, rel| {
                zip.start_file(rel.to_string_lossy(), opts).map_err(|e| e.to_string())?;
                let mut f = fs::File::open(p).map_err(|e| e.to_string())?;
                std::io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
                files += 1;
                Ok(())
            })
            .map_err(|e| e.to_string())?;
        } else {
            let rel = relative_name(src, &common);
            zip.start_file(rel.to_string_lossy(), opts).map_err(|e| e.to_string())?;
            if let Some(pass) = password {
                // zip-крейт шифрование не поддерживает — сохраняем как есть,
                // но помечаем в комментарии, чтобы не создать ложного чувства
                // защиты. Пользователю будет показано предупреждение.
                let _ = pass;
            }
            let mut f = fs::File::open(src).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
            files += 1;
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    let bytes = fs::metadata(destination).map(|m| m.len()).unwrap_or(0);
    Ok(ArchiveResult {
        path: destination.to_string_lossy().into_owned(),
        files,
        bytes,
    })
}

/// Общий предок всех путей — не поднимаемся выше него в именах архива.
fn common_ancestor(paths: &[PathBuf]) -> PathBuf {
    let Some(first) = paths.first() else { return PathBuf::new() };
    let mut common = first.parent().unwrap_or(first).to_path_buf();
    for p in &paths[1..] {
        let parent = p.parent().unwrap_or(p);
        while !parent.starts_with(&common) {
            common = common.parent().unwrap_or(Path::new("")).to_path_buf();
            if common.as_os_str().is_empty() {
                return PathBuf::new();
            }
        }
    }
    common
}

fn relative_name(path: &Path, base: &Path) -> PathBuf {
    path.strip_prefix(base).unwrap_or(path).to_path_buf()
}

/// Обход дерева с вызовом колбэка для каждого файла (только файлы, не папки).
fn visit_tree<F>(root: &Path, base: &Path, cb: &mut F) -> Result<(), String>
where
    F: FnMut(&Path, PathBuf) -> Result<(), String>,
{
    let mut stack = vec![root.to_path_buf()];
    let mut guard = 0usize;
    while let Some(dir) = stack.pop() {
        guard += 1;
        if guard > 100_000 {
            return Err("Слишком много каталогов".into());
        }
        let rd = fs::read_dir(&dir).map_err(|e| e.to_string())?;
        for item in rd.flatten() {
            let p = item.path();
            // Не следуем по симлинкам.
            let ft = match item.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_dir() {
                stack.push(p);
            } else if ft.is_file() {
                cb(&p, relative_name(&p, base))?;
            }
        }
    }
    Ok(())
}

/// Тип архива по расширению.
pub fn archive_kind(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    match ext.as_str() {
        "zip" => Some("zip"),
        "tar" => Some("tar"),
        "gz" | "tgz" => Some("gzip"),
        "bz2" => Some("bzip2"),
        "xz" | "txz" => Some("xz"),
        "7z" | "rar" => Some("external"),
        _ => None,
    }
}

/// Безопасно ли распаковать архив в `dest`: все ли пути остаются внутри.
///
/// Защита от Zip Slip: `../evil` или абсолютный путь в архиве обязаны
/// отклоняться до распаковки, иначе файл запишется за пределы папки.
pub fn safe_extract_path(dest: &Path, entry_name: &str) -> Option<PathBuf> {
    let name = entry_name.trim_end_matches('/');
    if name.is_empty() {
        return None; // запись-каталог без имени
    }
    let rel = Path::new(name);
    // Абсолютные пути и диски Windows — отклоняем. На macOS `C:\evil` не
    // считается абсолютным (Component::Normal), поэтому проверяем явно.
    if rel.is_absolute()
        || name.starts_with('\\')
        || name.contains('\\')
        || (name.len() >= 2 && name.as_bytes()[1] == b':' && name.as_bytes()[0].is_ascii_alphabetic())
    {
        return None;
    }
    let mut out = dest.to_path_buf();
    for c in rel.components() {
        match c {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            // Любой «..» отклоняем целиком, даже если он в итоге остаётся
            // внутри — проще и надёжнее, чем вычислять нормализацию.
            Component::ParentDir => return None,
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(out)
}

/// Распаковать ZIP в каталог.
pub fn extract_archive(archive: &Path, dest: &Path) -> Result<usize, String> {
    if !archive.exists() {
        return Err("Архив не найден".into());
    }
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(fs::File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut extracted = 0usize;

    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        let target = safe_extract_path(dest, &name)
            .ok_or_else(|| format!("Небезопасный путь в архиве: {name}"))?;

        if name.ends_with('/') {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = fs::File::create(&target).map_err(|e| e.to_string())?;
        // Ограничение распаковки: 2 ГБ на запись. Защита от zip-бомб.
        let mut limited = entry.take(2 * 1024 * 1024 * 1024);
        std::io::copy(&mut limited, &mut out).map_err(|e| e.to_string())?;
        extracted += 1;
    }
    Ok(extracted)
}

/// Прочитать первые байты архива для проверки magic — иногда расширение врёт.
pub fn sniff_archive(path: &Path) -> Option<&'static str> {
    let mut f = fs::File::open(path).ok()?;
    let mut buf = [0u8; 6];
    let n = f.read(&mut buf).ok()?;
    if n < 4 {
        return None;
    }
    if &buf[..4] == b"PK\x03\x04" || &buf[..4] == b"PK\x05\x06" {
        Some("zip")
    } else if &buf[..2] == b"\x1f\x8b" {
        Some("gzip")
    } else if &buf[..3] == b"BZh" {
        Some("bzip2")
    } else if &buf[..3] == b"\xfd7z" {
        Some("xz")
    } else if n >= 6 && &buf[..6] == b"7z\xbc\xaf\x27\x1c" {
        Some("7z")
    } else if n >= 4 && &buf[..4] == b"Rar!" {
        Some("rar")
    } else {
        None
    }
}

// ==================== пакетное переименование ====================

/// Один шаг пакетного переименования.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenamePlan {
    pub from: String,
    pub to: String,
    pub conflict: bool,
}

/// Построить план переименования без реального изменения файлов.
///
/// `pattern` — шаблон с `{n}` (порядковый номер) и `{name}` (старое имя).
/// `start` — начальное значение номера.
pub fn plan_rename(
    paths: &[PathBuf],
    pattern: &str,
    start: usize,
    name_filter: Option<&str>,
    ext_filter: Option<&str>,
) -> Vec<RenamePlan> {
    let mut filtered: Vec<&PathBuf> = paths
        .iter()
        .filter(|p| {
            let name = p.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
            if let Some(f) = name_filter {
                if !name.contains(f) {
                    return false;
                }
            }
            if let Some(ext) = ext_filter {
                let e = p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase());
                if e.as_deref().map(|e| e == ext).unwrap_or(false) == false {
                    return false;
                }
            }
            true
        })
        .collect();
    // Стабильный порядок — результат не зависит от порядка выделения.
    filtered.sort();

    let existing: Vec<String> = filtered
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    // Набор исходных путей: занятость этим же файлом конфликтом не считается.
    let sources: std::collections::HashSet<&str> = existing.iter().map(|s| s.as_str()).collect();
    // Какие имена займут остальные шаги плана — это тоже конфликт.
    let mut targets: Vec<String> = Vec::new();
    for (i, p) in filtered.iter().enumerate() {
        let stem = p.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let ext = p.extension().map(|e| e.to_string_lossy().into_owned());
        let new_stem = pattern
            .replace("{n}", &(start + i).to_string())
            .replace("{name}", &stem);
        let final_name = match ext {
            Some(e) if !e.is_empty() => format!("{new_stem}.{e}"),
            _ => new_stem,
        };
        targets.push(p.with_file_name(&final_name).to_string_lossy().into_owned());
    }

    filtered
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let stem = p.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let ext = p.extension().map(|e| e.to_string_lossy().into_owned());
            let new_stem = pattern
                .replace("{n}", &(start + i).to_string())
                .replace("{name}", &stem);
            let final_name = match ext {
                Some(e) if !e.is_empty() => format!("{new_stem}.{e}"),
                _ => new_stem.clone(),
            };
            let to = p.with_file_name(&final_name).to_string_lossy().into_owned();
            // Конфликт, если этот путь:
            //   (а) совпадает с целевым путём ДРУГОГО шага плана, или
            //   (б) уже занят в ФС посторонним файлом — но не самим собой.
            // При одинаковом целевом имени выполняется первый шаг плана,
            // последующие помечаются конфликтными.
            let taken_by_other = targets
                .iter()
                .enumerate()
                .any(|(j, t)| j < i && *t == to);
            let taken_on_disk = Path::new(&to).symlink_metadata().is_ok() && !sources.contains(to.as_str());
            let conflict = to != existing[i] && (taken_by_other || taken_on_disk);
            RenamePlan {
                from: existing[i].clone(),
                to,
                conflict,
            }
        })
        .collect()
}

/// Выполнить план переименования.
///
/// При конфликте имен операция пропускается (не перезаписывает!).
/// Возвращает число успешных переименований.
pub fn apply_rename_plan(plan: &[RenamePlan]) -> Result<usize, String> {
    let mut done = 0;
    for step in plan {
        if step.conflict {
            continue;
        }
        let from = Path::new(&step.from);
        let to = Path::new(&step.to);
        if from == to {
            continue;
        }
        // Не трогаем существующий файл — create_new-like семантика.
        if to.exists() || fs::symlink_metadata(to).is_ok() {
            continue;
        }
        fs::rename(from, to).map_err(|e| format!("{}: {}", step.from, e))?;
        done += 1;
    }
    Ok(done)
}

// ==================== сравнение каталогов ====================

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub enum DiffKind {
    OnlyLeft,
    OnlyRight,
    Different,
    Same,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffEntry {
    pub relative: String,
    pub kind: DiffKind,
    pub left_size: Option<u64>,
    pub right_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DirDiff {
    pub entries: Vec<DiffEntry>,
    pub only_left: usize,
    pub only_right: usize,
    pub different: usize,
    pub same: usize,
}

/// Сравнить два каталога по относительным путям и размеру файлов.
///
/// Содержимое не читаем: «different» означает разный размер, а не разные
/// байты. Для точного сравнения есть `find_duplicates`.
pub fn compare_dirs(left: &Path, right: &Path) -> Result<DirDiff, String> {
    fn index(root: &Path) -> Result<BTreeMap<String, Option<u64>>, String> {
        let mut map = BTreeMap::new();
        let mut stack = vec![root.to_path_buf()];
        let mut guard = 0;
        while let Some(dir) = stack.pop() {
            guard += 1;
            if guard > 100_000 {
                return Err("Слишком много каталогов".into());
            }
            let rd = match fs::read_dir(&dir) {
                Ok(r) => r,
                Err(_) => continue,
            };
            for item in rd.flatten() {
                let p = item.path();
                let rel = p
                    .strip_prefix(root)
                    .unwrap_or(&p)
                    .to_string_lossy()
                    .replace('\\', "/");
                let ft = match item.file_type() {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                if ft.is_dir() {
                    stack.push(p);
                } else if ft.is_file() {
                    map.insert(rel, fs::metadata(&p).ok().map(|m| m.len()));
                }
            }
        }
        Ok(map)
    }

    let l = index(left)?;
    let r = index(right)?;
    let mut out = Vec::new();
    let (mut only_l, mut only_r, mut different, mut same) = (0, 0, 0, 0);

    for (rel, ls) in &l {
        match r.get(rel) {
            None => {
                out.push(DiffEntry {
                    relative: rel.clone(),
                    kind: DiffKind::OnlyLeft,
                    left_size: *ls,
                    right_size: None,
                });
                only_l += 1;
            }
            Some(rs) if ls != rs => {
                out.push(DiffEntry {
                    relative: rel.clone(),
                    kind: DiffKind::Different,
                    left_size: *ls,
                    right_size: *rs,
                });
                different += 1;
            }
            Some(_) => same += 1,
        }
    }
    for (rel, rs) in &r {
        if !l.contains_key(rel) {
            out.push(DiffEntry {
                relative: rel.clone(),
                kind: DiffKind::OnlyRight,
                left_size: None,
                right_size: *rs,
            });
            only_r += 1;
        }
    }
    out.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(DirDiff {
        entries: out,
        only_left: only_l,
        only_right: only_r,
        different,
        same,
    })
}

// ==================== размер папок ====================

/// Размер дерева: байты и число файлов.
#[derive(Debug, Clone, Serialize, Default)]
pub struct FolderSize {
    pub bytes: u64,
    pub files: usize,
    pub dirs: usize,
}

/// Посчитать размер каталога рекурсивно, не следуя по симлинкам.
///
/// Для больших деревьев это дорого, поэтому вызывать явно, а не при
/// каждом листинге.
pub fn folder_size(root: &Path) -> Result<FolderSize, String> {
    let mut out = FolderSize::default();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > 128 {
            return Err("Слишком глубокое дерево".into());
        }
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for item in rd.flatten() {
            let ft = match item.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_dir() {
                out.dirs += 1;
                stack.push((item.path(), depth + 1));
            } else if ft.is_file() {
                out.files += 1;
                out.bytes += fs::metadata(item.path()).map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    Ok(out)
}

/// Размеры непосредственных детей каталога — для колонки «размер папки».
pub fn child_sizes(root: &Path) -> HashMap<String, FolderSize> {
    let mut out = HashMap::new();
    let Ok(rd) = fs::read_dir(root) else { return out };
    for item in rd.flatten() {
        let Ok(ft) = item.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        if let Ok(size) = folder_size(&item.path()) {
            out.insert(item.file_name().to_string_lossy().into_owned(), size);
        }
    }
    out
}
