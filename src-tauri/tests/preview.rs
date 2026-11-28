//! Тесты предпросмотра (Этап 4).
//!
//! Парсеры заголовков изображений и счётчик страниц PDF — самая хрупкая часть:
//! они читают байты по смещениям и ломаются молча. Тесты подают им настоящие
//! заголовки форматов, включая битые и обрезанные данные.

use file_manager_lib::preview::{
    image_dimensions, is_binary_head, mime_kind, pdf_pages, truncate_utf8, webp_dimensions,
};

/// PNG-заголовок: сигнатура + длина IHDR + "IHDR" + ширина/высота.
fn png_header(w: u32, h: u32) -> Vec<u8> {
    let mut v = b"\x89PNG\r\n\x1a\n".to_vec();
    v.extend_from_slice(&[0, 0, 0, 13]); // длина IHDR
    v.extend_from_slice(b"IHDR");
    v.extend_from_slice(&w.to_be_bytes());
    v.extend_from_slice(&h.to_be_bytes());
    v
}

fn gif_header(w: u16, h: u16) -> Vec<u8> {
    let mut v = b"GIF89a".to_vec();
    v.extend_from_slice(&w.to_le_bytes());
    v.extend_from_slice(&h.to_le_bytes());
    v.extend_from_slice(&[0, 0, 0]);
    v
}

fn bmp_header(w: i32, h: i32) -> Vec<u8> {
    let mut v = b"BM".to_vec();
    v.extend_from_slice(&[0; 16]);
    v.extend_from_slice(&w.to_le_bytes());
    v.extend_from_slice(&h.to_le_bytes());
    v
}

/// SOI + SOF0 с размерами.
fn jpeg_header(w: u16, h: u16) -> Vec<u8> {
    let mut v = vec![0xFF, 0xD8]; // SOI
    v.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x10]); // APP0, длина 16
    v.extend_from_slice(b"JFIF\0");
    v.extend_from_slice(&[1, 1, 0, 0, 1, 0, 1, 0, 0]); // 9 байт тела APP0
    v.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]); // SOF0, длина 17, точность 8
    v.extend_from_slice(&h.to_be_bytes());
    v.extend_from_slice(&w.to_be_bytes());
    v
}

// ---------- PNG ----------

#[test]
fn png_размеры_читаются() {
    assert_eq!(image_dimensions(&png_header(1920, 1080)), Some((1920, 1080)));
}

#[test]
fn png_маленький_размер() {
    assert_eq!(image_dimensions(&png_header(1, 1)), Some((1, 1)));
}

#[test]
fn png_обрезанный_заголовок_не_паникует() {
    let full = png_header(1920, 1080);
    // Проверяем всё, что короче полного заголовка: не должно быть паники.
    for len in 0..full.len() {
        let _ = image_dimensions(&full[..len]);
    }
    assert_eq!(image_dimensions(&full[..8]), None, "без IHDR размеров нет");
}

// ---------- GIF ----------

#[test]
fn gif_размеры_читаются() {
    assert_eq!(image_dimensions(&gif_header(320, 240)), Some((320, 240)));
}

#[test]
fn gif87a_тоже_поддерживается() {
    let mut v = b"GIF87a".to_vec();
    v.extend_from_slice(&100u16.to_le_bytes());
    v.extend_from_slice(&50u16.to_le_bytes());
    v.extend_from_slice(&[0, 0, 0]);
    assert_eq!(image_dimensions(&v), Some((100, 50)));
}

// ---------- BMP ----------

#[test]
fn bmp_размеры_читаются() {
    assert_eq!(image_dimensions(&bmp_header(640, 480)), Some((640, 480)));
}

#[test]
fn bmp_отрицательная_высота_даёт_модуль() {
    // В BMP отрицательная высота означает перевёрнутое изображение,
    // но пользователю нужен размер, а не знак.
    assert_eq!(image_dimensions(&bmp_header(640, -480)), Some((640, 480)));
}

// ---------- JPEG ----------

#[test]
fn jpeg_размеры_читаются_из_sof0() {
    assert_eq!(image_dimensions(&jpeg_header(800, 600)), Some((800, 600)));
}

#[test]
fn jpeg_с_несколькими_сегментами_до_sof() {
    let mut v = vec![0xFF, 0xD8];
    // APP1 (EXIF), длина 8: 2 байта длины + 6 тела
    v.extend_from_slice(&[0xFF, 0xE1, 0x00, 0x08]);
    v.extend_from_slice(b"Exif\0\0");
    // SOF2 (прогрессивный), длина 17
    v.extend_from_slice(&[0xFF, 0xC2, 0x00, 0x11, 0x08]);
    v.extend_from_slice(&300u16.to_be_bytes());
    v.extend_from_slice(&400u16.to_be_bytes());
    assert_eq!(image_dimensions(&v), Some((400, 300)), "ширина 400, высота 300");
}

#[test]
fn jpeg_битый_поток_не_паникует() {
    let mut v = vec![0xFF, 0xD8];
    v.extend_from_slice(&[0xFF, 0xC0, 0xFF, 0xFF]); // длина выходит за пределы
    let _ = image_dimensions(&v);

    // Мусор без маркеров.
    let _ = image_dimensions(&[0xFF, 0xD8, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
}

// ---------- WebP ----------

#[test]
fn webp_lossy_размеры() {
    let mut v = b"RIFF".to_vec();
    v.extend_from_slice(&[0, 0, 0, 0]); // размер файла
    v.extend_from_slice(b"WEBP");
    v.extend_from_slice(b"VP8 ");
    v.extend_from_slice(&[0u8; 10]); // заголовок чанка до размеров
    v.extend_from_slice(&(640u16 & 0x3FFF).to_le_bytes());
    v.extend_from_slice(&(480u16 & 0x3FFF).to_le_bytes());
    assert_eq!(image_dimensions(&v), Some((640, 480)));
}

#[test]
fn webp_обрезанный_не_паникует() {
    let v = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
    let _ = image_dimensions(&v);
}

#[test]
fn webp_неизвестный_чанк_даёт_none() {
    let mut v = b"RIFF".to_vec();
    v.extend_from_slice(&[0, 0, 0, 0]);
    v.extend_from_slice(b"WEBP");
    v.extend_from_slice(b"XXXX");
    v.extend_from_slice(&[0u8; 20]);
    assert_eq!(webp_dimensions(&v), None);
}

// ---------- чужие данные ----------

#[test]
fn текстовый_файл_не_считается_картинкой() {
    assert_eq!(image_dimensions(b"Hello, world! This is plain text.\n"), Some((0, 0)).filter(|_| false));
}

#[test]
fn пустой_буфер_даёт_none() {
    assert_eq!(image_dimensions(&[]), None);
}

// ---------- PDF ----------

#[test]
fn pdf_считает_страницы() {
    let pdf = b"%PDF-1.7\n1 0 obj\n<< /Type /Pages /Count 2 >>\nendobj\n\
2 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj\n\
3 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj\n";
    assert_eq!(pdf_pages(pdf), Some(2));
}

#[test]
fn pdf_не_путает_Pages_с_Page() {
    // /Type /Pages — это узел дерева, а не страница.
    let pdf = b"%PDF-1.4\n<< /Type /Pages /Kids [2 0 R 3 0 R 4 0 R] >>";
    assert_eq!(pdf_pages(pdf), None, "узлов дерева не считаем");
}

#[test]
fn pdf_без_страниц_даёт_none() {
    assert_eq!(pdf_pages(b"%PDF-1.4\nnot a real pdf"), None);
}

#[test]
fn pdf_с_разными_пробелами_после_type() {
    for sep in [&b" "[..], &b"\n"[..], &b"\r\n"[..], &b"\t"[..]] {
        let mut v = b"<< /Type".to_vec();
        v.extend_from_slice(sep);
        v.extend_from_slice(b"/Page /Parent 1 0 R >>");
        assert_eq!(pdf_pages(&v), Some(1), "разделитель {sep:?}");
    }
}

#[test]
fn pdf_без_пробела_после_type() {
    assert_eq!(pdf_pages(b"<< /Type/Page >>"), Some(1));
}

#[test]
fn pdf_много_страниц() {
    let mut pdf = b"%PDF-1.7\n".to_vec();
    for i in 0..500 {
        pdf.extend_from_slice(format!("{i} 0 obj\n<< /Type /Page >>\nendobj\n").as_bytes());
    }
    assert_eq!(pdf_pages(&pdf), Some(500));
}

#[test]
fn pdf_битые_данные_не_паникуют() {
    let _ = pdf_pages(&[]);
    let _ = pdf_pages(b"/Type");
    let _ = pdf_pages(b"/Type ");
    let _ = pdf_pages(&[0xFF; 1000]);
}

// ---------- тип по расширению ----------

#[test]
fn тип_по_расширению() {
    assert_eq!(mime_kind("png"), "image");
    assert_eq!(mime_kind("JPG"), "image", "регистр не важен");
    assert_eq!(mime_kind("heic"), "image");
    assert_eq!(mime_kind("pdf"), "pdf");
    assert_eq!(mime_kind("rs"), "text");
    assert_eq!(mime_kind("md"), "text");
    assert_eq!(mime_kind(""), "text", "без расширения чаще текст");
    assert_eq!(mime_kind("dmg"), "other");
    assert_eq!(mime_kind("mp4"), "other", "видео не превьюим пока");
}

// ---------- определение бинарности ----------

#[test]
fn текст_не_бинарный() {
    assert!(!is_binary_head("Привет, мир!\nЭто текст.\n".as_bytes()));
    assert!(!is_binary_head(b""));
}

#[test]
fn нулевой_байт_означает_бинарный() {
    assert!(is_binary_head(b"\x7fELF\x02\x01\x00\x00"));
    assert!(is_binary_head(&[0x41, 0x42, 0x00, 0x43]));
}

#[test]
fn управляющие_символы_считаются_бинарными() {
    // Много байтов ниже 0x09 — признак двоичного файла.
    assert!(is_binary_head(&[1, 2, 3, 4, 5, 6, 7, 8]));
}

// ---------- обрезка UTF-8 ----------

#[test]
fn обрезка_по_границе_символа() {
    let s = "Привет";
    let bytes = s.as_bytes();
    // «П» занимает 2 байта: обрезка на 1 байте не даёт валидной строки.
    assert_eq!(truncate_utf8(bytes, 1).len(), 0);
    assert_eq!(truncate_utf8(bytes, 2).len(), 2);
    assert_eq!(truncate_utf8(bytes, 3).len(), 2, "не рвём второй символ");
}

#[test]
fn обрезка_ascii_полная() {
    assert_eq!(truncate_utf8(b"hello", 3).len(), 3);
    assert_eq!(truncate_utf8(b"hello", 100).len(), 5);
}

#[test]
fn эмодзи_не_рвётся() {
    let s = "🦝";
    let b = s.as_bytes();
    assert_eq!(b.len(), 4);
    assert_eq!(truncate_utf8(b, 3).len(), 0, "эмодзи не режем посередине");
    assert_eq!(truncate_utf8(b, 4).len(), 4);
}
