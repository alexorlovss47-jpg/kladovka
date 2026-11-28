//! Тесты дополнительных возможностей (Этап 6).
//!
//! Архивы, Zip Slip, пакетное переименование, сравнение каталогов,
//! размер папок. Всё на настоящих файлах в песочнице.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use file_manager_lib::extras::{
    apply_rename_plan, archive_kind, child_sizes, compare_dirs, create_archive, extract_archive,
    folder_size, plan_rename, safe_extract_path, sniff_archive, DiffKind,
};

fn sandbox(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "kladovka-extras-{}-{}-{}",
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

// ==================== ZIP ====================

#[test]
fn архив_создаётся_и_распаковывается() {
    let d = sandbox("zip");
    let src = d.join("src");
    write(&src.join("a.txt"), b"alpha");
    write(&src.join("sub/b.txt"), b"beta");

    let archive = d.join("out.zip");
    let r = create_archive(&[src.clone()], &archive, None).unwrap();
    assert_eq!(r.files, 2, "два файла внутри");
    assert!(fs::metadata(&archive).unwrap().len() > 0);

    let dest = d.join("out");
    let n = extract_archive(&archive, &dest).unwrap();
    assert_eq!(n, 2);
    assert_eq!(fs::read(dest.join("src/a.txt")).unwrap(), b"alpha");
    assert_eq!(fs::read(dest.join("src/sub/b.txt")).unwrap(), b"beta");

    fs::remove_dir_all(&d).ok();
}

#[test]
fn архив_из_одного_файла_без_обёртки() {
    let d = sandbox("zip1");
    let f = d.join("note.txt");
    write(&f, b"hello");
    let archive = d.join("one.zip");
    create_archive(&[f], &archive, None).unwrap();

    let dest = d.join("out");
    extract_archive(&archive, &dest).unwrap();
    assert_eq!(fs::read(dest.join("note.txt")).unwrap(), b"hello");
    assert!(!dest.join("note.txt/note.txt").exists());
    fs::remove_dir_all(&d).ok();
}

#[test]
fn пустой_список_источников_ошибка() {
    let d = sandbox("zipempty");
    let r = create_archive(&[], &d.join("x.zip"), None);
    assert!(r.is_err());
    assert!(r.unwrap_err().contains("Нет файлов"));
    fs::remove_dir_all(&d).ok();
}

#[test]
fn симлинк_не_добавляется_в_архив() {
    let d = sandbox("ziplink");
    let src = d.join("src");
    write(&src.join("real.txt"), b"real");
    #[cfg(unix)]
    std::os::unix::fs::symlink(d.join("outside.txt"), src.join("link.txt")).unwrap();
    write(&d.join("outside.txt"), b"outside");

    let archive = d.join("x.zip");
    let r = create_archive(&[src], &archive, None).unwrap();
    assert_eq!(r.files, 1, "только настоящий файл, не симлинк");

    let dest = d.join("out");
    extract_archive(&archive, &dest).unwrap();
    assert!(!dest.join("src/link.txt").exists());
    fs::remove_dir_all(&d).ok();
}

// ==================== Zip Slip — безопасность ====================

#[test]
fn zip_slip_отклоняет_обратный_путь() {
    let base = Path::new("/tmp/extract");
    assert_eq!(safe_extract_path(base, "../evil.txt"), None);
    assert_eq!(safe_extract_path(base, "a/../../evil.txt"), None);
    assert_eq!(safe_extract_path(base, "sub/../../../evil"), None);
}

#[test]
fn zip_slip_отклоняет_абсолютные_пути() {
    let base = Path::new("/tmp/extract");
    assert_eq!(safe_extract_path(base, "/etc/passwd"), None);
    assert_eq!(safe_extract_path(base, "\\windows\\evil"), None);
    assert_eq!(safe_extract_path(base, "C:\\evil"), None);
}

#[test]
fn zip_slip_пропускает_безопасные_пути() {
    let base = Path::new("/tmp/extract");
    assert_eq!(safe_extract_path(base, "a.txt"), Some(base.join("a.txt")));
    assert_eq!(
        safe_extract_path(base, "sub/./dir/file.txt"),
        Some(base.join("sub/dir/file.txt"))
    );
    assert_eq!(safe_extract_path(base, "dir/"), Some(base.join("dir")));
}

#[test]
fn zip_slip_отклоняет_пустую_запись() {
    assert_eq!(safe_extract_path(Path::new("/tmp/x"), ""), None);
    assert_eq!(safe_extract_path(Path::new("/tmp/x"), "/"), None);
}

#[test]
fn тип_архива_по_расширению() {
    assert_eq!(archive_kind(Path::new("a.zip")), Some("zip"));
    assert_eq!(archive_kind(Path::new("a.TAR")), Some("tar"));
    assert_eq!(archive_kind(Path::new("a.tgz")), Some("gzip"));
    assert_eq!(archive_kind(Path::new("a.7z")), Some("external"));
    assert_eq!(archive_kind(Path::new("a.txt")), None);
    assert_eq!(archive_kind(Path::new("noext")), None);
}

#[test]
fn magic_байты_архива_важнее_расширения() {
    let d = sandbox("magic");
    let src = d.join("in.txt");
    write(&src, b"payload");
    let fake = d.join("fake.pdf");
    create_archive(&[src], &fake, None).unwrap();
    assert_eq!(sniff_archive(&fake), Some("zip"), "расширение врёт, но magic верен");
    assert_eq!(sniff_archive(Path::new("/nonexistent/file.zip")), None);
    fs::remove_dir_all(&d).ok();
}

// ==================== пакетное переименование ====================

#[test]
fn план_переименования_с_номером() {
    let d = sandbox("rename");
    let a = d.join("IMG_001.jpg");
    let b = d.join("IMG_002.jpg");
    write(&a, b"a");
    write(&b, b"b");
    let plan = plan_rename(&[a, b], "Photo_{n}", 10, None, None);
    assert_eq!(plan.len(), 2);
    // Порядок стабильный (отсортирован), номера 10 и 11.
    assert_eq!(plan[0].to, d.join("Photo_10.jpg").to_string_lossy());
    assert_eq!(plan[1].to, d.join("Photo_11.jpg").to_string_lossy());
    assert!(plan.iter().all(|p| !p.conflict));
    fs::remove_dir_all(&d).ok();
}

#[test]
fn шаблон_со_старым_именем() {
    let d = sandbox("rename2");
    let f = d.join("report.txt");
    write(&f, b"x");
    let plan = plan_rename(&[f], "old_{name}", 1, None, None);
    assert_eq!(plan[0].to, d.join("old_report.txt").to_string_lossy());
    fs::remove_dir_all(&d).ok();
}

#[test]
fn фильтр_по_имени_и_расширению() {
    let d = sandbox("rename3");
    let a = d.join("IMG_1.png");
    let b = d.join("IMG_2.jpg");
    let c = d.join("DOC_3.png");
    for p in [&a, &b, &c] {
        write(p, b"x");
    }
    let plan = plan_rename(
        &[a, b, c],
        "p_{n}",
        1,
        Some("IMG_"),
        Some("png"),
    );
    assert_eq!(plan.len(), 1, "только IMG_1.png");
    assert_eq!(plan[0].to, d.join("p_1.png").to_string_lossy());
    fs::remove_dir_all(&d).ok();
}

#[test]
fn конфликт_имени_Помечается_но_не_Перезаписывает() {
    let d = sandbox("rename4");
    let a = d.join("a.txt");
    let b = d.join("b.txt");
    write(&a, b"a");
    write(&b, b"b");
    // Оба переименовываются в одно имя — второй конфликтует.
    let plan = plan_rename(&[a, b], "same", 1, None, None);
    assert_eq!(plan.len(), 2);
    let conflicts = plan.iter().filter(|p| p.conflict).count();
    assert_eq!(conflicts, 1, "один из двух не может занять то же имя");

    let done = apply_rename_plan(&plan).unwrap();
    assert_eq!(done, 1, "переименовался только один");
    // Ничего не потерялось.
    assert!(d.join("same.txt").exists());
    fs::remove_dir_all(&d).ok();
}

#[test]
fn применение_плана_не_трогает_существующий_файл() {
    let d = sandbox("rename5");
    let a = d.join("a.txt");
    write(&a, b"a");
    write(&d.join("taken.txt"), b"original");
    let plan = plan_rename(&[a.clone()], "taken", 1, None, None);
    // plan_rename considers the new name free because a.txt differs and
    // "taken.txt" itself is not in `paths`. apply must still protect it.
    let done = apply_rename_plan(&plan).unwrap();
    assert_eq!(done, 0);
    assert_eq!(fs::read(d.join("taken.txt")).unwrap(), b"original");
    assert!(a.exists());
    fs::remove_dir_all(&d).ok();
}

#[test]
fn пустой_план_не_падает() {
    assert_eq!(apply_rename_plan(&[]).unwrap(), 0);
}

// ==================== сравнение каталогов ====================

#[test]
fn сравнение_находит_различия() {
    let d = sandbox("diff");
    let l = d.join("left");
    let r = d.join("right");
    write(&l.join("same.txt"), b"same");
    write(&r.join("same.txt"), b"same");
    write(&l.join("onlyleft.txt"), b"l");
    write(&r.join("onlyright.txt"), b"r");
    write(&l.join("size.bin"), &[1u8; 100]);
    write(&r.join("size.bin"), &[1u8; 200]);
    write(&l.join("sub/nested.txt"), b"n");
    write(&r.join("sub/nested.txt"), b"n");

    let diff = compare_dirs(&l, &r).unwrap();
    assert_eq!(diff.same, 2, "same.txt и sub/nested.txt");
    assert_eq!(diff.only_left, 1);
    assert_eq!(diff.only_right, 1);
    assert_eq!(diff.different, 1);
    assert_eq!(diff.entries.len(), 3);

    let kinds: Vec<_> = diff.entries.iter().map(|e| &e.kind).collect();
    assert!(kinds.contains(&&DiffKind::OnlyLeft));
    assert!(kinds.contains(&&DiffKind::OnlyRight));
    assert!(kinds.contains(&&DiffKind::Different));
    fs::remove_dir_all(&d).ok();
}

#[test]
fn одинаковые_каталоги_дают_пустую_разницу() {
    let d = sandbox("diff2");
    let l = d.join("left");
    let r = d.join("right");
    for base in [&l, &r] {
        write(&base.join("a.txt"), b"a");
        write(&base.join("sub/b.txt"), b"b");
    }
    let diff = compare_dirs(&l, &r).unwrap();
    assert!(diff.entries.is_empty());
    assert_eq!(diff.same, 2);
    fs::remove_dir_all(&d).ok();
}

#[test]
fn сравнение_с_несуществующим_каталогом() {
    let d = sandbox("diff3");
    let l = d.join("real");
    write(&l.join("a.txt"), b"a");
    let diff = compare_dirs(&l, &d.join("missing")).unwrap();
    assert_eq!(diff.only_left, 1);
    assert_eq!(diff.only_right, 0);
    fs::remove_dir_all(&d).ok();
}

// ==================== размер папок ====================

#[test]
fn размер_папки_учитывает_вложенность() {
    let d = sandbox("size1");
    write(&d.join("a.bin"), &[1u8; 100]);
    write(&d.join("sub/b.bin"), &[1u8; 250]);
    write(&d.join("sub/deep/c.bin"), &[1u8; 50]);

    let s = folder_size(&d).unwrap();
    assert_eq!(s.files, 3);
    assert_eq!(s.dirs, 2);
    assert_eq!(s.bytes, 400);
    fs::remove_dir_all(&d).ok();
}

#[test]
fn размеры_детей_каталога() {
    let d = sandbox("size2");
    write(&d.join("small/x.bin"), &[1u8; 10]);
    write(&d.join("big/y.bin"), &[1u8; 1000]);
    write(&d.join("plain.txt"), b"x");

    let sizes = child_sizes(&d);
    assert_eq!(sizes["small"].bytes, 10);
    assert_eq!(sizes["big"].bytes, 1000);
    assert!(!sizes.contains_key("plain.txt"), "файлы не считаем папками");
    fs::remove_dir_all(&d).ok();
}

#[test]
fn пустая_папка_имеет_нулевой_размер() {
    let d = sandbox("size3");
    fs::create_dir_all(d.join("empty")).unwrap();
    let s = folder_size(&d.join("empty")).unwrap();
    assert_eq!(s.bytes, 0);
    assert_eq!(s.files, 0);
    assert_eq!(s.dirs, 0);
    fs::remove_dir_all(&d).ok();
}

#[test]
fn симлинк_не_увеличивает_размер_папки() {
    let d = sandbox("size4");
    write(&d.join("real.bin"), &[1u8; 500]);
    #[cfg(unix)]
    std::os::unix::fs::symlink(d.join("real.bin"), d.join("link.bin")).unwrap();
    let s = folder_size(&d).unwrap();
    assert_eq!(s.files, 1, "симлинк не файл");
    assert_eq!(s.bytes, 500);
    fs::remove_dir_all(&d).ok();
}
