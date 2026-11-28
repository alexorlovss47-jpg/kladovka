//! Разбор заголовков файлов для панели быстрого просмотра.
//!
//! Только чистые функции: никакого I/O и Tauri. Поэтому их легко тестировать
//! и нельзя случайно заблокировать на большом файле — вызывающий код читает
//! ограниченное число байт и отдаёт сюда срез.

/// Пороговые размеры для безопасного предпросмотра.
pub const PREVIEW_TEXT_LIMIT: u64 = 512 * 1024; // 512 KiB текста достаточно
pub const PREVIEW_IMAGE_LIMIT: u64 = 64 * 1024 * 1024; // 64 MiB
pub const PREVIEW_PDF_LIMIT: u64 = 128 * 1024 * 1024; // 128 MiB

pub const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif", "heic", "heif", "avif", "ico",
];
pub const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "json", "toml", "yaml", "yml", "ini", "cfg", "conf", "csv", "tsv",
    "rs", "ts", "tsx", "js", "jsx", "py", "go", "c", "h", "cpp", "hpp", "java", "kt", "swift",
    "rb", "php", "sh", "bash", "zsh", "fish", "sql", "html", "css", "scss", "less", "xml", "svg",
    "log", "env", "gitignore", "dockerfile", "makefile", "lock",
];

/// Определить вид файла по расширению.
pub fn mime_kind(ext: &str) -> &'static str {
    let e = ext.to_ascii_lowercase();
    if IMAGE_EXTS.contains(&e.as_str()) {
        "image"
    } else if e == "pdf" {
        "pdf"
    } else if TEXT_EXTS.contains(&e.as_str()) || e.is_empty() {
        // Пустое расширение часто текст (LICENSE, Makefile); содержимое проверит is_binary_head.
        "text"
    } else {
        "other"
    }
}

/// Похоже ли начало файла на двоичные данные.
///
/// Признаки: нулевой байт или заметная доля управляющих символов.
/// Пустой срез считается текстом — пустой файл безопасно показать.
pub fn is_binary_head(head: &[u8]) -> bool {
    if head.is_empty() {
        return false;
    }
    if head.contains(&0) {
        return true;
    }
    // Управляющие символы, кроме \t \n \r \f \x0B и ESC(0x1B — ANSI-цвета).
    let controls = head
        .iter()
        .filter(|b| {
            let b = **b;
            b < 0x09 || (b > 0x0D && b < 0x20 && b != 0x1B)
        })
        .count();
    controls * 100 / head.len() > 5
}

/// Обрезать байты по границе символа UTF-8.
pub fn truncate_utf8(bytes: &[u8], max: usize) -> &[u8] {
    let mut end = max.min(bytes.len());
    while end > 0 && std::str::from_utf8(&bytes[..end]).is_err() {
        end -= 1;
    }
    &bytes[..end]
}

/// Размеры изображения из заголовка. Поддержаны PNG, GIF, JPEG, BMP, WebP.
pub fn image_dimensions(buf: &[u8]) -> Option<(u32, u32)> {
    if buf.len() >= 24 && buf.starts_with(b"\x89PNG\r\n\x1a\n") {
        let w = u32::from_be_bytes(buf.get(16..20)?.try_into().ok()?);
        let h = u32::from_be_bytes(buf.get(20..24)?.try_into().ok()?);
        return Some((w, h));
    }
    if buf.len() >= 10 && (buf.starts_with(b"GIF87a") || buf.starts_with(b"GIF89a")) {
        let w = u16::from_le_bytes(buf.get(6..8)?.try_into().ok()?) as u32;
        let h = u16::from_le_bytes(buf.get(8..10)?.try_into().ok()?) as u32;
        return Some((w, h));
    }
    if buf.len() >= 2 && buf[0] == 0xFF && buf[1] == 0xD8 {
        return jpeg_dimensions(buf);
    }
    if buf.len() >= 26 && buf.starts_with(b"BM") {
        let w = i32::from_le_bytes(buf.get(18..22)?.try_into().ok()?) as u32;
        let h = i32::from_le_bytes(buf.get(22..26)?.try_into().ok()?).unsigned_abs();
        return Some((w, h));
    }
    if buf.len() >= 30 && buf.starts_with(b"RIFF") && &buf[8..12] == b"WEBP" {
        return webp_dimensions(buf);
    }
    None
}

fn jpeg_dimensions(buf: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2usize;
    while i + 9 <= buf.len() {
        if buf[i] != 0xFF {
            return None; // поток повреждён
        }
        let marker = buf[i + 1];
        // SOF0..SOF15, кроме DHT(0xC4), JPG(0xC8), DAC(0xCC)
        let is_sof = (0xC0..=0xCF).contains(&marker)
            && marker != 0xC4
            && marker != 0xC8
            && marker != 0xCC;
        let len = u16::from_be_bytes(buf.get(i + 2..i + 4)?.try_into().ok()?) as usize;
        if is_sof {
            let h = u16::from_be_bytes(buf.get(i + 5..i + 7)?.try_into().ok()?) as u32;
            let w = u16::from_be_bytes(buf.get(i + 7..i + 9)?.try_into().ok()?) as u32;
            return Some((w, h));
        }
        // Маркер без длины (RSTn, SOI, EOI) не должен зациклить: len >= 2.
        let step = 2 + len.max(2);
        i = i.checked_add(step)?;
    }
    None
}

pub fn webp_dimensions(buf: &[u8]) -> Option<(u32, u32)> {
    let chunk = buf.get(12..)?;
    match chunk.get(..4)? {
        b"VP8X" => {
            let w = (u32::from(*chunk.get(4)?) | (u32::from(*chunk.get(5)?) << 8) | (u32::from(*chunk.get(6)?) << 16)) + 1;
            let h = (u32::from(*chunk.get(7)?) | (u32::from(*chunk.get(8)?) << 8) | (u32::from(*chunk.get(9)?) << 16)) + 1;
            Some((w, h))
        }
        b"VP8 " => {
            let w = u32::from(u16::from_le_bytes(chunk.get(14..16)?.try_into().ok()?) & 0x3FFF);
            let h = u32::from(u16::from_le_bytes(chunk.get(16..18)?.try_into().ok()?) & 0x3FFF);
            Some((w, h))
        }
        b"VP8L" => {
            let bits = u32::from_le_bytes(chunk.get(9..13)?.try_into().ok()?);
            let w = (bits & 0x3FFF) + 1;
            let h = ((bits >> 14) & 0x3FFF) + 1;
            Some((w, h))
        }
        _ => None,
    }
}

/// Посчитать страницы PDF по вхождениям `/Type /Page`.
///
/// Это не полноценный парсер: xref не читается, объекты в сжатых потоках
/// (object streams, PDF 1.5+) не видны. Но для быстрой оценки числа страниц
/// в обычном документе работает, а цена — один проход по байтам.
pub fn pdf_pages(buf: &[u8]) -> Option<u32> {
    let mut count = 0u32;
    let mut i = 0usize;
    while let Some(pos) = find_sub(buf.get(i..)?, b"/Type") {
        let at = i + pos;
        let mut j = at + 5;
        while j < buf.len() && matches!(buf[j], b' ' | b'\r' | b'\n' | b'\t') {
            j += 1;
        }
        // /Type /Pages — узел дерева, его не считаем.
        if buf[j..].starts_with(b"/Page") && !buf[j..].starts_with(b"/Pages") {
            count += 1;
        }
        i = at + 5;
        if i >= buf.len() {
            break;
        }
    }
    if count == 0 {
        None
    } else {
        Some(count)
    }
}

fn find_sub(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_sub_находит_и_не_находит() {
        assert_eq!(find_sub(b"abcdef", b"cd"), Some(2));
        assert_eq!(find_sub(b"abc", b"xyz"), None);
        assert_eq!(find_sub(b"", b"a"), None);
    }
}
