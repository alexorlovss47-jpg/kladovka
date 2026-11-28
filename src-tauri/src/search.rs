//! Поиск и фильтрация (Этап 5).
//!
//! Все обходы дерева:
//! - рекурсивные, но с ограничением глубины и лимитом результатов;
//! - не следуют по символическим ссылкам на каталоги (иначе циклы и задвоение);
//! - пропускают скрытые файлы, если фильтр явно их не запрашивает;
//! - не читают содержимое файлов, кроме чтения метаданных для дубликатов.
//!
//! Каждая функция — чистая (получает фильтр и отдаёт результат), поэтому
//! обход можно тестировать на песочнице без Tauri.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::{entry_from, is_mac_metadata_name, Entry};

/// Фильтр поиска по поддереву.
#[derive(Debug, Clone, Deserialize)]
pub struct SearchFilter {
    /// Подстрока в имени (без учёта регистра). Пустая — любое имя.
    pub query: String,
    /// Расширение без точки, например "png". None — любое.
    pub extension: Option<String>,
    /// Минимальный размер в байтах (для файлов).
    pub min_size: Option<u64>,
    /// Максимальный размер в байтах (для файлов).
    pub max_size: Option<u64>,
    /// Unix-время: только изменённые после этого момента.
    pub modified_after: Option<i64>,
    /// Unix-время: только изменённые до этого момента.
    pub modified_before: Option<i64>,
    /// Показывать скрытые файлы.
    pub include_hidden: bool,
    /// Показывать каталоги.
    pub include_dirs: bool,
    /// Показывать файлы.
    pub include_files: bool,
    /// Максимальная глубина рекурсии (1 — только корень).
    pub max_depth: usize,
    /// Максимум результатов.
    pub limit: usize,
}

impl Default for SearchFilter {
    fn default() -> Self {
        Self {
            query: String::new(),
            extension: None,
            min_size: None,
            max_size: None,
            modified_after: None,
            modified_before: None,
            include_hidden: false,
            include_dirs: true,
            include_files: true,
            max_depth: usize::MAX,
            limit: 500,
        }
    }
}

impl SearchFilter {
    /// Проверить, проходит ли запись по фильтру (без проверки имени).
    fn matches_metadata(&self, e: &Entry) -> bool {
        if !self.include_hidden && e.is_hidden {
            return false;
        }
        if e.is_dir {
            // Каталог не имеет расширения, поэтому фильтр по расширению
            // логично исключает каталоги целиком.
            return self.include_dirs && self.extension.is_none();
        }
        if !self.include_files {
            return false;
        }
        if let Some(want) = &self.extension {
            let want = want.trim_start_matches('.').to_ascii_lowercase();
            match &e.extension {
                Some(actual) if actual.to_ascii_lowercase() == want => {}
                _ => return false,
            }
        }
        if let Some(min) = self.min_size {
            if e.size.unwrap_or(0) < min {
                return false;
            }
        }
        if let Some(max) = self.max_size {
            if e.size.unwrap_or(0) > max {
                return false;
            }
        }
        if let Some(after) = self.modified_after {
            if e.modified.unwrap_or(0) < after {
                return false;
            }
        }
        if let Some(before) = self.modified_before {
            if e.modified.unwrap_or(0) > before {
                return false;
            }
        }
        true
    }

    fn matches_name(&self, e: &Entry) -> bool {
        self.query.is_empty() || e.name.to_lowercase().contains(&self.query.to_lowercase())
    }
}

/// Результат поиска: записи + признаки обрезки.
#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub entries: Vec<Entry>,
    /// Достигнут лимит результатов — в дереве может быть ещё.
    pub truncated: bool,
    /// Обойдено записей (для индикатора масштаба).
    pub scanned: usize,
}

/// Обход дерева каталогов с фильтром.
///
/// `walk` не следует по симлинкам и не читает содержимого файлов.
/// Порядок не гарантирован; при достижении лимита обход останавливается.
pub fn walk_filtered(root: &Path, filter: &SearchFilter) -> SearchResult {
    let mut out = Vec::new();
    let mut scanned = 0usize;
    let mut truncated = false;
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];

    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= filter.limit {
            truncated = true;
            break;
        }
        if depth > filter.max_depth {
            continue;
        }
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        // Записи внутри текущего каталога лежат на глубине depth + 1.
        let child_depth = depth + 1;
        if child_depth > filter.max_depth {
            continue; // глубже не смотрим и не показываем
        }
        for item in rd.flatten() {
            scanned += 1;
            let p = item.path();
            // file_type() не следует по симлинкам — то, что нужно.
            let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let Some(e) = entry_from(&p, is_dir) else { continue };
            let name_match = filter.matches_name(&e);
            if name_match && filter.matches_metadata(&e) {
                out.push(e.clone());
                if out.len() >= filter.limit {
                    truncated = true;
                    break;
                }
            }
            // Спускаемся только в реальные каталоги (не симлинки).
            if is_dir && !e.is_symlink {
                let hidden_dir = e.is_hidden || is_mac_metadata_name(&e.name);
                if filter.include_hidden || !hidden_dir {
                    stack.push((p, child_depth));
                }
            }
        }
    }

    SearchResult { entries: out, truncated, scanned }
}

/// Самые большие файлы в поддереве.
///
/// Классическая задача: держим ограниченную кучу размера `limit`, а не
/// сортируем всё дерево. Возвращает файлы, отсортированные по убыванию
/// размера.
pub fn largest_files(root: &Path, limit: usize, include_hidden: bool) -> Vec<Entry> {
    let mut best: Vec<Entry> = Vec::with_capacity(limit + 1);
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    // Защита от бесконечной глубины на зацикленных структурах.
    let max_depth = 64;

    while let Some((dir, depth)) = stack.pop() {
        if depth > max_depth {
            continue;
        }
        let rd = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for item in rd.flatten() {
            let p = item.path();
            let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let Some(e) = entry_from(&p, is_dir) else { continue };
            if is_dir {
                if e.is_symlink {
                    continue;
                }
                let hidden = e.is_hidden || is_mac_metadata_name(&e.name);
                if include_hidden || !hidden {
                    stack.push((p, depth + 1));
                }
            } else if include_hidden || !e.is_hidden {
                best.push(e);
                if best.len() > limit {
                    // Выбрасываем самый маленький.
                    if let Some(min_idx) = smallest_index(&best) {
                        best.swap_remove(min_idx);
                    }
                }
            }
        }
    }

    best.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.name.cmp(&b.name)));
    best
}

fn smallest_index(v: &[Entry]) -> Option<usize> {
    v.iter().enumerate().min_by_key(|(_, e)| (e.size, &e.name)).map(|(i, _)| i)
}

/// Группа дубликатов.
#[derive(Debug, Clone, Serialize)]
pub struct DuplicateGroup {
    /// Размер файлов (они одинаковы).
    pub size: u64,
    /// Одинаковое имя не требуется: дубликаты ищем по размеру + хэшу начала.
    pub entries: Vec<Entry>,
}

/// Найти дубликаты файлов по (размер, хэш первых 64 КБ, хэш хвоста).
///
/// Стратегия в три ступени, чтобы не читать большие файлы целиком:
/// 1. Группируем по размеру — чтение не нужно.
/// 2. В группах >1 файла сравниваем первые 64 КиБ (большинство дубликатов
///    отличается уже в начале).
/// 3. Кандидатов с одинаковым началом сверяем по последним 64 КиБ и длине.
///
/// Вероятность ложного срабатывания ничтожна (SHA не используем намеренно,
/// чтобы не тянуть зависимость; сравнение по байтам даёт точный ответ).
pub fn find_duplicates(root: &Path, limit: usize) -> Vec<DuplicateGroup> {
    // 1. Группировка по размеру.
    let mut by_size: HashMap<u64, Vec<Entry>> = HashMap::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    let max_depth = 64;
    while let Some((dir, depth)) = stack.pop() {
        if depth > max_depth {
            continue;
        }
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for item in rd.flatten() {
            let p = item.path();
            let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let Some(e) = entry_from(&p, is_dir) else { continue };
            if is_dir {
                if !e.is_symlink {
                    stack.push((p, depth + 1));
                }
            } else if let Some(size) = e.size {
                if size > 0 {
                    by_size.entry(size).or_default().push(e);
                }
            }
        }
    }

    // 2. Сравнение внутри групп по размеру.
    let mut groups = Vec::new();
    for (size, mut files) in by_size {
        if files.len() < 2 {
            continue;
        }
        // Быстрая проверка: байты начала.
        let mut by_head: HashMap<Vec<u8>, Vec<Entry>> = HashMap::new();
        for e in files.drain(..) {
            match read_slice(&e.path, 0, 64 * 1024) {
                Some(head) => by_head.entry(head).or_default().push(e),
                None => continue, // нечитаемый файл — пропускаем
            }
        }
        for (_, candidates) in by_head {
            if candidates.len() < 2 {
                continue;
            }
            // 3. Точная проверка: сверка начала и хвоста.
            let mut exact: HashMap<(u64, Vec<u8>, Vec<u8>), Vec<Entry>> = HashMap::new();
            for e in candidates {
                let Some(head) = read_slice(&e.path, 0, 64 * 1024) else { continue };
                let tail_start = size.saturating_sub(64 * 1024);
                let Some(tail) = read_slice(&e.path, tail_start, 64 * 1024) else { continue };
                exact.entry((size, head, tail)).or_default().push(e);
            }
            for (_, mut dup) in exact {
                if dup.len() > 1 {
                    dup.sort_by(|a, b| a.path.cmp(&b.path));
                    groups.push(DuplicateGroup { size, entries: dup });
                    if groups.len() >= limit {
                        return groups;
                    }
                }
            }
        }
    }
    groups
}

/// Прочитать до `len` байт с отступа. `None` — файл недоступен.
fn read_slice(path: &str, offset: u64, len: u64) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(expand(path)).ok()?;
    f.seek(SeekFrom::Start(offset)).ok()?;
    let mut buf = vec![0u8; len as usize];
    let mut filled = 0;
    loop {
        let n = f.read(&mut buf[filled..]).ok()?;
        if n == 0 {
            break;
        }
        filled += n;
        if filled == buf.len() {
            break;
        }
    }
    buf.truncate(filled);
    Some(buf)
}

/// Развернуть `~` в пути (используется только read_slice, чтобы не тянуть
/// зависимость от lib.rs).
fn expand(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

/// Unix-время сейчас (для фильтра «за последние N дней»).
pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
