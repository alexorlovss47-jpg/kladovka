//! Тесты поиска и фильтрации (Этап 5).
//!
//! Всё на песочнице с настоящими файлами: фильтры по имени/расширению/
//! размеру/дате/скрытым, глубина, лимит, самые большие файлы, дубликаты
//! (включая точное сравнение содержимого) и защиту от симлинк-циклов.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use file_manager_lib::search::{find_duplicates, largest_files, walk_filtered, SearchFilter};

fn sandbox(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "kladovka-search-{}-{}-{}",
        tag,
        std::process::id(),
        SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(p: &Path, bytes: &[u8]) {
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let mut f = fs::File::create(p).unwrap();
    f.write_all(bytes).unwrap();
}

fn names(entries: &[file_manager_lib::Entry]) -> Vec<String> {
    entries.iter().map(|e| e.name.clone()).collect()
}

fn sorted_names(entries: &[file_manager_lib::Entry]) -> Vec<String> {
    let mut v = names(entries);
    v.sort();
    v
}

// ---------- фильтры ----------

#[test]
fn поиск_по_имени_без_учёта_регистра() {
    let d = sandbox("name");
    write(&d.join("Report.PDF"), b"x");
    write(&d.join("photo.JPG"), b"x");
    let filter = SearchFilter {
        query: "rePoRt".into(),
        ..Default::default()
    };
    let r = walk_filtered(&d, &filter);
    assert_eq!(sorted_names(&r.entries), ["Report.PDF"]);
    assert!(!r.truncated);
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn фильтр_по_расширению() {
    let d = sandbox("ext");
    write(&d.join("a.png"), b"x");
    write(&d.join("b.PNG"), b"x");
    write(&d.join("c.jpg"), b"x");
    let filter = SearchFilter {
        extension: Some("png".into()),
        ..Default::default()
    };
    let r = walk_filtered(&d, &filter);
    assert_eq!(sorted_names(&r.entries), ["a.png", "b.PNG"]);
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn фильтр_по_размеру() {
    let d = sandbox("size");
    write(&d.join("small.bin"), &[0u8; 100]);
    write(&d.join("large.bin"), &[0u8; 5000]);
    let filter = SearchFilter {
        min_size: Some(1000),
        ..Default::default()
    };
    assert_eq!(names(&walk_filtered(&d, &filter).entries), ["large.bin"]);

    let filter = SearchFilter {
        max_size: Some(1000),
        ..Default::default()
    };
    assert_eq!(names(&walk_filtered(&d, &filter).entries), ["small.bin"]);

    let filter = SearchFilter {
        min_size: Some(100),
        max_size: Some(5000),
        ..Default::default()
    };
    assert_eq!(sorted_names(&walk_filtered(&d, &filter).entries), ["large.bin", "small.bin"]);
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn фильтр_по_дате_изменения() {
    let d = sandbox("date");
    let old = d.join("old.txt");
    let new = d.join("new.txt");
    write(&old, b"x");
    write(&new, b"x");
    // Поставим old.txt на 10 дней назад (если файловая система поддерживает).
    let past = SystemTime::now() - Duration::from_secs(10 * 24 * 3600);
    filetime::set_file_times(&old, past.into(), past.into()).unwrap();

    let cutoff = (SystemTime::now() - Duration::from_secs(5 * 24 * 3600))
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let filter = SearchFilter {
        modified_after: Some(cutoff),
        ..Default::default()
    };
    assert_eq!(names(&walk_filtered(&d, &filter).entries), ["new.txt"]);

    let filter = SearchFilter {
        modified_before: Some(cutoff),
        ..Default::default()
    };
    assert_eq!(names(&walk_filtered(&d, &filter).entries), ["old.txt"]);
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn скрытые_файлы_показываются_только_по_явному_запросу() {
    let d = sandbox("hidden");
    write(&d.join(".secret"), b"x");
    write(&d.join("visible.txt"), b"x");
    write(&d.join(".hiddendir/inner.txt"), b"x");

    let r = walk_filtered(&d, &SearchFilter::default());
    assert_eq!(sorted_names(&r.entries), ["visible.txt"], "скрытые не должны попадать в выдачу");

    let filter = SearchFilter {
        include_hidden: true,
        ..Default::default()
    };
    let r = walk_filtered(&d, &filter);
    assert!(r.entries.iter().any(|e| e.name == ".secret"));
    assert!(r.entries.iter().any(|e| e.name == "inner.txt"), "скрытый каталог должен обходиться");
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn только_файлы_или_только_папки() {
    let d = sandbox("kind");
    write(&d.join("sub/inner.txt"), b"x");
    write(&d.join("file.txt"), b"x");

    let filter = SearchFilter {
        include_files: false,
        ..Default::default()
    };
    assert_eq!(names(&walk_filtered(&d, &filter).entries), ["sub"]);

    let filter = SearchFilter {
        include_dirs: false,
        ..Default::default()
    };
    assert_eq!(sorted_names(&walk_filtered(&d, &filter).entries), ["file.txt", "inner.txt"]);
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn глубина_ограничивает_обход() {
    let d = sandbox("depth");
    write(&d.join("l1/file.txt"), b"x");
    write(&d.join("l1/l2/file.txt"), b"x");
    write(&d.join("l1/l2/l3/file.txt"), b"x");

    let filter = SearchFilter {
        max_depth: 2,
        ..Default::default()
    };
    let r = walk_filtered(&d, &filter);
    let got = sorted_names(&r.entries);
    assert!(got.contains(&"l1".to_string()));
    assert!(got.contains(&"file.txt".to_string()));
    assert!(got.contains(&"l2".to_string()));
    assert!(!got.contains(&"l3".to_string()), "глубина 3 не должна обходиться: {got:?}");
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn лимит_отмечается_как_truncated() {
    let d = sandbox("limit");
    for i in 0..50 {
        write(&d.join(format!("f{i:02}.txt")), b"x");
    }
    let filter = SearchFilter { limit: 10, ..Default::default() };
    let r = walk_filtered(&d, &filter);
    assert_eq!(r.entries.len(), 10);
    assert!(r.truncated);
    assert!(r.scanned >= 10);
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn пустой_запрос_возвращает_всё_незакрытое() {
    let d = sandbox("all");
    write(&d.join("a.txt"), b"x");
    write(&d.join("sub/b.txt"), b"x");
    let r = walk_filtered(&d, &SearchFilter::default());
    assert_eq!(sorted_names(&r.entries), ["a.txt", "b.txt", "sub"]);
    fs::remove_dir_all(&d).unwrap();
}

// ---------- самые большие файлы ----------

#[test]
fn самые_большие_файлы_отсортированы() {
    let d = sandbox("largest");
    write(&d.join("a.bin"), &[1u8; 100]);
    write(&d.join("b.bin"), &[1u8; 900]);
    write(&d.join("sub/c.bin"), &[1u8; 500]);
    write(&d.join("sub/d.bin"), &[1u8; 700]);

    let top = largest_files(&d, 3, false);
    assert_eq!(names(&top), ["b.bin", "d.bin", "c.bin"], "по убыванию размера");
    assert_eq!(top.iter().map(|e| e.size.unwrap()).collect::<Vec<_>>(), [900, 700, 500]);
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn largest_лимит_меньше_числа_файлов() {
    let d = sandbox("largest2");
    for i in 0..20 {
        write(&d.join(format!("f{i:02}.bin")), &vec![0u8; (i + 1) * 10]);
    }
    let top = largest_files(&d, 5, false);
    assert_eq!(top.len(), 5);
    let sizes: Vec<u64> = top.iter().map(|e| e.size.unwrap()).collect();
    assert_eq!(sizes, [200, 190, 180, 170, 160]);
    fs::remove_dir_all(&d).unwrap();
}

// ---------- дубликаты ----------

#[test]
fn дубликаты_находятся_по_содержимому() {
    let d = sandbox("dup");
    let content = b"same content for duplicate detection";
    write(&d.join("a.txt"), content);
    write(&d.join("sub/b.txt"), content);
    write(&d.join("c.txt"), b"different");
    write(&d.join("d.txt"), b"same content for duplicate detection but longer");

    let groups = find_duplicates(&d, 100);
    assert_eq!(groups.len(), 1, "ровно одна группа");
    assert_eq!(groups[0].size, content.len() as u64);
    assert_eq!(sorted_names(&groups[0].entries), ["a.txt", "b.txt"]);
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn файлы_разного_размера_не_дубликаты() {
    let d = sandbox("dup-size");
    write(&d.join("a.txt"), b"short");
    write(&d.join("b.txt"), b"shorter");
    let groups = find_duplicates(&d, 100);
    assert!(groups.is_empty());
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn одинаковый_размер_но_разное_содержимое_не_дубликаты() {
    let d = sandbox("dup-diff");
    write(&d.join("a.bin"), &[1u8; 200]);
    write(&d.join("b.bin"), &[2u8; 200]);
    write(&d.join("c.bin"), &[1u8; 200]);
    let groups = find_duplicates(&d, 100);
    assert_eq!(groups.len(), 1, "a и c совпадают");
    assert_eq!(sorted_names(&groups[0].entries), ["a.bin", "c.bin"]);
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn дубликаты_разное_начало_одинаковый_хвост() {
    // Первые 64 КиБ различаются, остальное совпадает — не дубликаты.
    let d = sandbox("dup-head");
    let mut a = vec![1u8; 200 * 1024];
    let mut b = vec![2u8; 200 * 1024];
    a[150 * 1024..].fill(7);
    b[150 * 1024..].fill(7);
    write(&d.join("a.bin"), &a);
    write(&d.join("b.bin"), &b);
    let groups = find_duplicates(&d, 100);
    assert!(groups.is_empty(), "разное начало = разные файлы");
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn дубликаты_короткие_файлы_меньше_буфера() {
    let d = sandbox("dup-short");
    write(&d.join("a.txt"), b"tiny");
    write(&d.join("b.txt"), b"tiny");
    write(&d.join("c.txt"), b"tiny2");
    let groups = find_duplicates(&d, 100);
    assert_eq!(groups.len(), 1);
    assert_eq!(sorted_names(&groups[0].entries), ["a.txt", "b.txt"]);
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn пустые_файлы_игнорируются() {
    // Нулевые файлы формально «одинаковы», но пользы от них нет, и в
    // группах их были бы тысячи.
    let d = sandbox("dup-empty");
    write(&d.join("a.txt"), b"");
    write(&d.join("b.txt"), b"");
    let groups = find_duplicates(&d, 100);
    assert!(groups.is_empty());
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn лимит_групп_дубликатов() {
    let d = sandbox("dup-limit");
    write(&d.join("a1.txt"), b"one");
    write(&d.join("a2.txt"), b"one");
    write(&d.join("b1.txt"), b"two");
    write(&d.join("b2.txt"), b"two");
    let groups = find_duplicates(&d, 1);
    assert_eq!(groups.len(), 1);
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn несуществующий_корень_не_паникует() {
    let filter = SearchFilter::default();
    let r = walk_filtered(Path::new("/nonexistent/kladovka-test"), &filter);
    assert!(r.entries.is_empty());
    assert!(!r.truncated);
    assert!(largest_files(Path::new("/nonexistent/kladovka-test"), 10, false).is_empty());
    assert!(find_duplicates(Path::new("/nonexistent/kladovka-test"), 10).is_empty());
}

#[test]
fn симлинк_на_родителя_не_вызывает_цикл() {
    let d = sandbox("cycle");
    write(&d.join("sub/file.txt"), b"x");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&d, d.join("sub/loop")).unwrap();

    // Симлинк — законная запись, он может быть в выдаче. Важно другое:
    // обход НЕ рекурсирует по нему, иначе file.txt повторялся бы
    // бесконечно и мы бы зависли.
    let filter = SearchFilter {
        max_depth: 12,
        limit: 5000,
        ..Default::default()
    };
    let r = walk_filtered(&d, &filter);
    let file_count = r.entries.iter().filter(|e| e.name == "file.txt").count();
    assert_eq!(file_count, 1, "file.txt должен найтись ровно один раз, а не по разу на цикл");
    assert!(!r.truncated, "обход должен завершиться сам, без упора в лимит");

    // И сам симлинк помечен как ссылка, а не как каталог для спуска.
    if let Some(link) = r.entries.iter().find(|e| e.name == "loop") {
        assert!(link.is_symlink, "loop должен быть помечен как симлинк");
    }
    fs::remove_dir_all(&d).unwrap();
}
