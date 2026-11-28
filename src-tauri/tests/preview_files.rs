//! Интеграционные тесты предпросмотра на настоящих файлах.
//!
//! Проверяют полный путь: файл на диске → stat → чтение головы → разбор.
//! Пропускаются, если нужного файла нет в системе (тест не должен падать
//! на чужой машине из-за отсутствия системных ресурсов).

use file_manager_lib::preview::{
    is_binary_head, mime_kind, truncate_utf8, PREVIEW_TEXT_LIMIT,
};
use std::fs;
use std::io::Write;

fn sandbox(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "kladovka-preview-{}-{}-{}",
        tag,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn настоящий_png_даёт_размеры() {
    let path = "/Users/alexorlovsmail.ru/projects/kiraai-desktop/src-tauri/icons/icon.png";
    let Ok(bytes) = fs::read(path) else {
        eprintln!("пропуск: нет {path}");
        return;
    };
    let dims = file_manager_lib::preview::image_dimensions(&bytes[..bytes.len().min(64)]);
    assert!(dims.is_some(), "PNG в системе должен разбираться");
    let (w, h) = dims.unwrap();
    assert!(w > 0 && h > 0, "нулевые размеры: {w}x{h}");
    assert_eq!(w, h, "иконка приложения обычно квадратная");
}

#[test]
fn настоящий_pdf_считает_страницы() {
    let path = "/Users/alexorlovsmail.ru/Library/CloudStorage/Box-Box/Docs/AI-dlya-raboty-bez-boli-v1.pdf";
    let Ok(bytes) = fs::read(path) else {
        eprintln!("пропуск: нет {path}");
        return;
    };
    let pages = file_manager_lib::preview::pdf_pages(&bytes);
    assert!(pages.is_some(), "в реальном PDF должны найтись страницы");
    assert!(pages.unwrap() > 0, "страниц должно быть больше нуля");
}

#[test]
fn heic_распознаётся_как_изображение() {
    // HEIC-размеры мы не парсим (это ISO-BMFF), но тип обязан быть image,
    // иначе панель попытается показать его как текст.
    assert_eq!(mime_kind("heic"), "image");
    assert_eq!(mime_kind("HEIF"), "image");
}

#[test]
fn текст_из_реального_файла_не_бинарный() {
    let dir = sandbox("txt");
    let p = dir.join("note.md");
    let mut f = fs::File::create(&p).unwrap();
    f.write_all("# Заголовок\n\nПривет, мир! Текст с кириллицей.\n".as_bytes())
        .unwrap();
    drop(f);

    let bytes = fs::read(&p).unwrap();
    assert!(!is_binary_head(&bytes));
    assert_eq!(mime_kind("md"), "text");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn бинарный_файл_определяется_по_нулям() {
    let dir = sandbox("bin");
    let p = dir.join("data.bin");
    let mut f = fs::File::create(&p).unwrap();
    f.write_all(&[0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x00, 0x00, 0xff, 0xfe])
        .unwrap();
    drop(f);

    let bytes = fs::read(&p).unwrap();
    assert!(is_binary_head(&bytes), "ELF должен распознаваться как бинарный");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn текст_больше_лимита_обрезается_по_границе() {
    let dir = sandbox("big");
    let p = dir.join("big.txt");
    // Строка из кириллицы: 2 байта на символ.
    let chunk = "Привет ".repeat(1000);
    let mut f = fs::File::create(&p).unwrap();
    for _ in 0..200 {
        f.write_all(chunk.as_bytes()).unwrap();
    }
    drop(f);

    let size = fs::metadata(&p).unwrap().len();
    assert!(size > PREVIEW_TEXT_LIMIT, "файл должен превышать лимит");

    // Обрезаем как это делает команда: читаем ровно лимит.
    let mut buf = vec![0u8; PREVIEW_TEXT_LIMIT as usize];
    let n = {
        use std::io::Read;
        let mut f = fs::File::open(&p).unwrap();
        f.read(&mut buf).unwrap()
    };
    buf.truncate(n);
    let trimmed = truncate_utf8(&buf, buf.len());
    // Обрезка не должна ломать UTF-8: строка обязана быть валидной.
    assert!(
        std::str::from_utf8(trimmed).is_ok(),
        "обрезанный текст должен остаться валидным UTF-8"
    );
    assert!(!trimmed.is_empty());
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn пустой_файл_не_падает() {
    let dir = sandbox("empty");
    let p = dir.join("empty.txt");
    fs::File::create(&p).unwrap();

    let bytes = fs::read(&p).unwrap();
    assert!(bytes.is_empty());
    assert!(!is_binary_head(&bytes), "пустой файл считаем текстом");
    assert_eq!(truncate_utf8(&bytes, 0).len(), 0);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn каталог_открывается_но_не_читается() {
    // ВАЖНО (macOS): open(2) на каталоге успешен, «Is a directory» приходит
    // только на read(2). Поэтому нельзя проверять «это файл?» через
    // File::open — проверка обязана идти по metadata().is_dir() ДО открытия.
    use std::io::Read;
    let dir = sandbox("dir");
    let mut f = fs::File::open(&dir).expect("на macOS каталог открывается");
    let mut buf = [0u8; 16];
    let err = f.read(&mut buf).expect_err("чтение каталога должно падать");
    assert!(
        err.to_string().to_lowercase().contains("directory")
            || err.raw_os_error() == Some(21), // EISDIR
        "неожиданная ошибка чтения каталога: {err}"
    );
    fs::remove_dir_all(&dir).ok();
}
