//! Сквозные тесты очереди операций с реальным копированием.
//!
//! Используют `tauri::test::mock_app()` — настоящий `AppHandle` без окна,
//! поэтому проходят весь путь: enqueue → try_start → execute → finish.
//! Это то, что нельзя проверить юнит-тестами: пауза и отмена работают через
//! поток воркера и реальные файлы.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use file_manager_lib::{ops, ConflictPolicy, OpsState};

/// Временный каталог, удаляемый при выходе из области видимости.
struct Sandbox(PathBuf);

impl Sandbox {
    fn new(tag: &str) -> Self {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "kladovka-it-{}-{}-{}",
            tag,
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
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

/// Создать N файлов заданного размера.
fn make_files(dir: &Path, count: usize, size: usize) {
    fs::create_dir_all(dir).unwrap();
    for i in 0..count {
        fs::write(dir.join(format!("f{i}.bin")), vec![7u8; size]).unwrap();
    }
}

fn wait_until<F: FnMut() -> bool>(mut f: F, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

#[test]
fn copy_operation_completes_and_reports_progress() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    let st = OpsState::new();
    let sb = Sandbox::new("copy-ok");
    let src = sb.join("src");
    let dst = sb.join("dst");
    make_files(&src, 3, 512 * 1024);
    fs::create_dir_all(&dst).unwrap();

    let id = ops::enqueue(
        &st,
        "copy",
        vec![src.to_string_lossy().to_string()],
        dst.to_string_lossy().to_string(),
        ConflictPolicy::Rename,
    );

    let job = ops::try_start(&st).expect("задача должна быть выдана");
    assert_eq!(job.id, id);
    ops::execute(&handle, &st, job);

    let info = ops::get_info(&st, id).expect("операция должна остаться в списке");
    assert_eq!(info.status, ops::OpStatus::Finished, "статус: {:?}, ошибка: {:?}", info.status, info.error);
    assert!(info.done > 0, "прогресс не учтён");
    assert_eq!(info.files_done, 3, "должно быть скопировано 3 файла");
    assert!(info.total >= 3 * 512 * 1024, "total занижен: {}", info.total);
    assert_eq!(info.error, None);

    // Результат на диске: копия каталога целиком.
    assert!(dst.join("src").join("f0.bin").exists());
    assert_eq!(fs::read(dst.join("src").join("f1.bin")).unwrap().len(), 512 * 1024);
    // Временных .part не осталось.
    let parts: Vec<_> = fs::read_dir(dst.join("src"))
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains(".part"))
        .collect();
    assert!(parts.is_empty(), "остались временные файлы: {parts:?}");
}

#[test]
fn operations_queue_waits_for_a_free_slot() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    let st = OpsState::new();
    let sb = Sandbox::new("queue");
    let dst = sb.join("dst");
    fs::create_dir_all(&dst).unwrap();

    // Три задачи; лимит параллельности — MAX_CONCURRENT (2).
    let mut ids = Vec::new();
    for i in 0..3 {
        let src = sb.join(&format!("src{i}"));
        make_files(&src, 1, 1024);
        ids.push(ops::enqueue(
            &st,
            "copy",
            vec![src.to_string_lossy().to_string()],
            dst.to_string_lossy().to_string(),
            ConflictPolicy::Rename,
        ));
    }

    // Выдаём задачи — больше лимита быть не должно.
    let mut jobs = Vec::new();
    while let Some(job) = ops::try_start(&st) {
        jobs.push(job);
        assert!(jobs.len() <= ops::MAX_CONCURRENT, "превышен лимит параллельности");
    }
    assert_eq!(jobs.len(), ops::MAX_CONCURRENT);

    // Третья всё ещё в очереди.
    let queued = ops::get_info(&st, ids[2]).unwrap();
    assert_eq!(queued.status, ops::OpStatus::Queued);

    // Выполняем первые две — после каждых двух слотов очередь должна идти дальше.
    for job in jobs {
        ops::execute(&handle, &st, job);
    }
    let job3 = ops::try_start(&st).expect("третья задача должна стать доступной после освобождения слотов");
    ops::execute(&handle, &st, job3);

    for id in ids {
        let info = ops::get_info(&st, id).unwrap();
        assert_eq!(info.status, ops::OpStatus::Finished, "операция {id} не завершилась: {:?}", info.error);
    }
}

#[test]
fn cancel_before_start_removes_from_queue() {
    let st = OpsState::new();
    let sb = Sandbox::new("cancel-queued");
    let src = sb.join("src");
    make_files(&src, 1, 1024);

    let id = ops::enqueue(
        &st,
        "copy",
        vec![src.to_string_lossy().to_string()],
        sb.join("dst").to_string_lossy().to_string(),
        ConflictPolicy::Rename,
    );
    assert!(ops::signal(&st, id, ops::Signal::Cancel));
    let info = ops::get_info(&st, id).unwrap();
    assert_eq!(info.status, ops::OpStatus::Cancelled);
    assert!(ops::try_start(&st).is_none(), "отменённая задача не должна выдаваться");
}

#[test]
fn pause_during_copy_holds_and_resume_completes() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    let st = Arc::new(OpsState::new());
    let sb = Sandbox::new("pause");
    let src = sb.join("src");
    let dst = sb.join("dst");
    // Достаточно данных, чтобы копирование шло не мгновенно даже на SSD.
    make_files(&src, 8, 32 * 1024 * 1024);
    fs::create_dir_all(&dst).unwrap();

    let id = ops::enqueue(
        &st,
        "copy",
        vec![src.to_string_lossy().to_string()],
        dst.to_string_lossy().to_string(),
        ConflictPolicy::Rename,
    );
    let job = ops::try_start(&st).unwrap();

    let st2 = st.clone();
    let handle2 = handle.clone();
    let worker = std::thread::spawn(move || {
        ops::execute(&handle2, &st2, job);
    });

    // Дожидаемся, пока операция реально начнётся, и ставим паузу.
    let started = wait_until(
        || !matches!(ops::get_info(&st, id).unwrap().status, ops::OpStatus::Queued),
        Duration::from_secs(5),
    );
    assert!(started, "операция не началась");
    // Операция могла успеть завершиться на быстром диске — тогда пауза
    // неприменима и проверять нечего.
    if ops::get_info(&st, id).unwrap().status == ops::OpStatus::Finished {
        worker.join().unwrap();
        return;
    }
    assert!(ops::signal(&st, id, ops::Signal::Pause), "пауза не принята");

    // На паузе прогресс должен остановиться.
    let paused_status = wait_until(
        || {
            let s = ops::get_info(&st, id).unwrap().status;
            s == ops::OpStatus::Paused || s == ops::OpStatus::Finished
        },
        Duration::from_secs(5),
    );
    assert!(paused_status, "пауза не применилась");
    if ops::get_info(&st, id).unwrap().status == ops::OpStatus::Finished {
        worker.join().unwrap();
        return;
    }
    let done_at_pause = ops::get_info(&st, id).unwrap().done;
    std::thread::sleep(Duration::from_millis(400));
    let done_later = ops::get_info(&st, id).unwrap().done;
    assert_eq!(done_at_pause, done_later, "на паузе прогресс продолжал расти");

    // Возобновляем и ждём завершения.
    assert!(ops::signal(&st, id, ops::Signal::Run));
    worker.join().unwrap();
    let info = ops::get_info(&st, id).unwrap();
    assert_eq!(info.status, ops::OpStatus::Finished, "после возобновления: {:?}", info.error);
    assert_eq!(info.files_done, 4);
}

#[test]
fn cancel_during_copy_rolls_back_and_leaves_source_intact() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    let st = Arc::new(OpsState::new());
    let sb = Sandbox::new("cancel-run");
    let src = sb.join("src");
    let dst = sb.join("dst");
    make_files(&src, 8, 32 * 1024 * 1024);
    fs::create_dir_all(&dst).unwrap();

    let id = ops::enqueue(
        &st,
        "copy",
        vec![src.to_string_lossy().to_string()],
        dst.to_string_lossy().to_string(),
        ConflictPolicy::Rename,
    );
    let job = ops::try_start(&st).unwrap();

    let st2 = st.clone();
    let handle2 = handle.clone();
    let worker = std::thread::spawn(move || {
        ops::execute(&handle2, &st2, job);
    });

    // Отменяем сразу, как только операция начала писать байты.
    let progressing = wait_until(
        || {
            let i = ops::get_info(&st, id).unwrap();
            i.done > 0 || i.status != ops::OpStatus::Queued
        },
        Duration::from_secs(5),
    );
    assert!(progressing);
    if ops::get_info(&st, id).unwrap().status == ops::OpStatus::Finished {
        worker.join().unwrap();
        return; // слишком быстрый диск — отменять нечего
    }
    assert!(ops::signal(&st, id, ops::Signal::Cancel), "отмена не принята");
    worker.join().unwrap();

    let info = ops::get_info(&st, id).unwrap();
    assert_eq!(info.status, ops::OpStatus::Cancelled, "статус: {:?}", info.status);

    // Источник не тронут.
    assert_eq!(fs::read_dir(&src).unwrap().count(), 8, "источник повреждён");
    // Частичная копия удалена.
    let leftover = dst.join("src");
    if leftover.exists() {
        let entries = fs::read_dir(&leftover).unwrap().count();
        assert_eq!(entries, 0, "остались частично скопированные файлы: {entries}");
    }
}

#[test]
fn failed_operation_reports_error_and_frees_slot() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    let st = OpsState::new();
    let sb = Sandbox::new("fail");
    let src = sb.join("src");
    let dst = sb.join("dst");
    make_files(&src, 1, 1024);
    fs::create_dir_all(&dst).unwrap();

    // Копирование каталога внутрь самого себя — гарантированная ошибка.
    let id = ops::enqueue(
        &st,
        "copy",
        vec![src.to_string_lossy().to_string()],
        src.join("nested").to_string_lossy().to_string(),
        ConflictPolicy::Rename,
    );
    let job = ops::try_start(&st).unwrap();
    ops::execute(&handle, &st, job);

    let info = ops::get_info(&st, id).unwrap();
    assert_eq!(info.status, ops::OpStatus::Failed);
    assert!(info.error.is_some(), "ошибка должна быть записана");
    // Слот освобождён — следующая задача может стартовать.
    let id2 = ops::enqueue(
        &st,
        "copy",
        vec![src.to_string_lossy().to_string()],
        dst.to_string_lossy().to_string(),
        ConflictPolicy::Rename,
    );
    assert!(ops::try_start(&st).is_some(), "слот не освободился после ошибки");
    let _ = id2;
}

#[test]
fn conflict_skip_policy_leaves_existing_file_untouched() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    let st = OpsState::new();
    let sb = Sandbox::new("skip");
    let src = sb.join("src");
    let dst = sb.join("dst");
    make_files(&src, 1, 2048);
    fs::create_dir_all(&dst).unwrap();
    // В приёмнике уже есть файл с тем же именем и другим содержимым.
    fs::write(dst.join("src"), b"original").unwrap();

    let id = ops::enqueue(
        &st,
        "copy",
        vec![src.to_string_lossy().to_string()],
        dst.to_string_lossy().to_string(),
        ConflictPolicy::Skip,
    );
    let job = ops::try_start(&st).unwrap();
    ops::execute(&handle, &st, job);

    let info = ops::get_info(&st, id).unwrap();
    assert_eq!(info.status, ops::OpStatus::Finished);
    // Файл не тронут.
    assert_eq!(fs::read(dst.join("src")).unwrap(), b"original");
}
