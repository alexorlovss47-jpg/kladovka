//! Менеджер файловых операций: очередь, воркеры, пауза/возобновление/отмена.
//!
//! Операции выполняются не более `MAX_CONCURRENT` одновременно. Прогресс
//! публикуется через событие `op-progress` и читается командой `list_ops`.
//!
//! Пауза — кооперативная: воркер ждёт в коротком цикле; отмена проверяется
//! при каждой записи блока данных.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

use crate::{
    count_bytes, ensure_not_inside_source, expand, resolve_target, ConflictPolicy, CopyCtx,
    OpProgress, Resolved,
};

pub const MAX_CONCURRENT: usize = 2;
const PAUSE_POLL: Duration = Duration::from_millis(120);
const EMIT_INTERVAL: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpStatus {
    Queued,
    Running,
    Paused,
    Finished,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpInfo {
    pub id: u64,
    pub kind: String,
    pub sources: Vec<String>,
    pub dest_dir: String,
    pub status: OpStatus,
    pub done: u64,
    pub total: u64,
    pub current: String,
    pub error: Option<String>,
    pub bytes_per_sec: f64,
    pub eta_secs: Option<u64>,
    pub files_done: u64,
    pub files_total: u64,
    pub created_at: i64,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Run,
    Pause,
    Cancel,
}

#[derive(Debug, Clone)]
pub struct Job {
    pub id: u64,
    pub kind: String,
    pub sources: Vec<String>,
    pub dest_dir: String,
    pub policy: ConflictPolicy,
}

#[derive(Default)]
pub struct OpsState {
    next_id: AtomicU64,
    queue: Mutex<VecDeque<u64>>,
    infos: Mutex<HashMap<u64, OpInfo>>,
    signals: Mutex<HashMap<u64, Arc<Mutex<Signal>>>>,
    active: Mutex<usize>,
}

impl OpsState {
    pub fn new() -> Self {
        Self::default()
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn set_status(infos: &Mutex<HashMap<u64, OpInfo>>, id: u64, status: OpStatus) {
    if let Some(info) = infos.lock().unwrap().get_mut(&id) {
        info.status = status;
    }
}

/// Поставить операцию в очередь. Возвращает id.
pub fn enqueue(
    state: &OpsState,
    kind: &str,
    sources: Vec<String>,
    dest_dir: String,
    policy: ConflictPolicy,
) -> u64 {
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let info = OpInfo {
        id,
        kind: kind.to_string(),
        sources,
        dest_dir,
        status: OpStatus::Queued,
        done: 0,
        total: 0,
        current: String::new(),
        error: None,
        bytes_per_sec: 0.0,
        eta_secs: None,
        files_done: 0,
        files_total: 0,
        created_at: now_secs(),
        finished_at: None,
    };
    state.infos.lock().unwrap().insert(id, info);
    state.queue.lock().unwrap().push_back(id);
    // Политика нужна воркеру: сохраняем её в отдельной карте.
    policies().lock().unwrap().insert(id, policy);
    id
}

/// Политики операций (id -> policy). Отдельная карта, потому что `OpInfo`
/// сериализуется фронту, а политика — внутренняя деталь.
fn policies() -> &'static Mutex<HashMap<u64, ConflictPolicy>> {
    static POLICIES: std::sync::OnceLock<Mutex<HashMap<u64, ConflictPolicy>>> = std::sync::OnceLock::new();
    POLICIES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Забрать задачу из очереди, если есть свободный слот.
pub fn try_start(state: &OpsState) -> Option<Job> {
    let mut active = state.active.lock().unwrap();
    if *active >= MAX_CONCURRENT {
        return None;
    }
    let id = state.queue.lock().unwrap().pop_front()?;
    let infos = state.infos.lock().unwrap();
    let info = infos.get(&id)?.clone();
    drop(infos);
    *active += 1;
    let policy = policies().lock().unwrap().get(&id).copied().unwrap_or_default();
    Some(Job {
        id,
        kind: info.kind,
        sources: info.sources,
        dest_dir: info.dest_dir,
        policy,
    })
}

/// Завершить операцию: освободить слот, записать статус, убрать сигнал.
pub fn finish(state: &OpsState, id: u64, status: OpStatus, error: Option<String>, done: u64) {
    {
        let mut infos = state.infos.lock().unwrap();
        if let Some(info) = infos.get_mut(&id) {
            info.status = status;
            info.error = error;
            info.done = done;
            info.current = String::new();
            info.finished_at = Some(now_secs());
        }
    }
    state.signals.lock().unwrap().remove(&id);
    policies().lock().unwrap().remove(&id);
    // saturating_sub: операцию могли отменить до старта воркера, и тогда
    // слот не занимался — обычное вычитание дало бы underflow.
    let mut active = state.active.lock().unwrap();
    *active = active.saturating_sub(1);
}

pub fn get_info(state: &OpsState, id: u64) -> Option<OpInfo> {
    state.infos.lock().unwrap().get(&id).cloned()
}

pub fn list_infos(state: &OpsState) -> Vec<OpInfo> {
    let mut v: Vec<OpInfo> = state.infos.lock().unwrap().values().cloned().collect();
    v.sort_by_key(|i| i.id);
    v
}

/// Послать сигнал операции. Работает и для стоящих в очереди.
pub fn signal(state: &OpsState, id: u64, sig: Signal) -> bool {
    if let Some(s) = state.signals.lock().unwrap().get(&id) {
        *s.lock().unwrap() = sig;
        return true;
    }
    // Воркер ещё не взял операцию: изменить прямо в очереди.
    let mut infos = state.infos.lock().unwrap();
    let Some(info) = infos.get_mut(&id) else { return false };
    // Завершённую операцию трогать нельзя: иначе «продолжить» на Finished
    // воскресил бы её в Queued и она никогда бы не выполнилась заново.
    if matches!(
        info.status,
        OpStatus::Finished | OpStatus::Failed | OpStatus::Cancelled
    ) {
        return false;
    }
    match sig {
        Signal::Cancel => {
            info.status = OpStatus::Cancelled;
            info.error = Some("отменено".to_string());
            info.finished_at = Some(now_secs());
            state.queue.lock().unwrap().retain(|&x| x != id);
            policies().lock().unwrap().remove(&id);
        }
        Signal::Pause => {
            info.status = OpStatus::Paused;
        }
        Signal::Run => {
            // Если операция на паузе до старта воркера — вернуть в очередь.
            info.status = OpStatus::Queued;
        }
    }
    true
}

/// Удалить завершённую операцию из памяти.
pub fn remove(state: &OpsState, id: u64) -> bool {
    let mut infos = state.infos.lock().unwrap();
    if let Some(info) = infos.get(&id) {
        if matches!(
            info.status,
            OpStatus::Finished | OpStatus::Failed | OpStatus::Cancelled
        ) {
            infos.remove(&id);
            drop(infos);
            state.signals.lock().unwrap().remove(&id);
            policies().lock().unwrap().remove(&id);
            return true;
        }
    }
    false
}

/// Держим не больше `max` завершённых операций (старейшие удаляем).
pub fn prune_finished(state: &OpsState, max: usize) {
    let mut infos = state.infos.lock().unwrap();
    let mut finished: Vec<(u64, i64)> = infos
        .values()
        .filter(|i| matches!(i.status, OpStatus::Finished | OpStatus::Failed | OpStatus::Cancelled))
        .map(|i| (i.id, i.finished_at.unwrap_or(i.created_at)))
        .collect();
    if finished.len() <= max {
        return;
    }
    // finished_at в секундах: несколько операций завершаются в одну секунду,
    // и без второго ключа порядок «кто старейший» был бы произвольным
    // (HashMap не сохраняет порядок). Сортируем по (время, id).
    finished.sort_by_key(|&(id, ts)| (ts, id));
    let excess = finished.len() - max;
    let ids: Vec<u64> = finished.into_iter().take(excess).map(|(id, _)| id).collect();
    for id in &ids {
        infos.remove(id);
    }
    drop(infos);
    state.signals.lock().unwrap().retain(|k, _| !ids.contains(k));
    policies().lock().unwrap().retain(|k, _| !ids.contains(k));
}

pub fn update_progress(
    state: &OpsState,
    id: u64,
    done: u64,
    total: u64,
    current: &str,
    files_done: u64,
    started: Instant,
) {
    let mut infos = state.infos.lock().unwrap();
    if let Some(info) = infos.get_mut(&id) {
        info.done = done;
        info.total = total;
        info.current = current.to_string();
        info.files_done = files_done;
        let elapsed = started.elapsed().as_secs_f64();
        if elapsed > 0.0 && done > 0 {
            info.bytes_per_sec = done as f64 / elapsed;
            if total > done {
                info.eta_secs = Some(((total - done) as f64 / info.bytes_per_sec).ceil() as u64);
            } else {
                info.eta_secs = None;
            }
        }
    }
}

fn emit_progress<R: Runtime>(app: &AppHandle<R>, id: u64, kind: &str, done: u64, total: u64, current: &str) {
    let _ = app.emit(
        "op-progress",
        OpProgress {
            op_id: id,
            kind: kind.to_string(),
            done,
            total,
            current: current.to_string(),
            finished: false,
            error: None,
        },
    );
}

fn count_files(path: &std::path::Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.file_type().is_symlink() {
        return 1;
    }
    if meta.is_dir() {
        fs::read_dir(path)
            .map(|rd| rd.flatten().map(|i| count_files(&i.path())).sum())
            .unwrap_or(0)
    } else {
        1
    }
}

/// Выполнить операцию (вызывается в `spawn_blocking`).
pub fn execute<R: Runtime>(app: &AppHandle<R>, state: &OpsState, job: Job) {
    let id = job.id;
    let kind = job.kind.clone();
    let dest = expand(&job.dest_dir);
    let srcs: Vec<PathBuf> = job.sources.iter().map(|s| expand(s)).collect();
    let started = Instant::now();

    let signal = Arc::new(Mutex::new(Signal::Run));
    let cancel = Arc::new(AtomicBool::new(false));
    let progress = Arc::new(AtomicU64::new(0));
    let files_done = Arc::new(AtomicU64::new(0));

    state.signals.lock().unwrap().insert(id, signal.clone());

    let result = (|| -> Result<(), String> {
        for src in &srcs {
            ensure_not_inside_source(src, &dest)?;
        }
        let total: u64 = srcs.iter().map(|p| count_bytes(p)).sum();
        let files_total: u64 = srcs.iter().map(|p| count_files(p)).sum();
        {
            let mut infos = state.infos.lock().unwrap();
            if let Some(info) = infos.get_mut(&id) {
                info.total = total;
                info.files_total = files_total;
            }
        }
        emit_progress(app, id, &kind, 0, total, "");

        // Сторож паузы/отмены/прогресса. `CopyCtx` вызывает его на каждой
        // записи блока (256 KiB).
        let sig = signal.clone();
        let cancel2 = cancel.clone();
        let progress2 = progress.clone();
        let files_done2 = files_done.clone();
        let state2: &OpsState = state;
        let app2: &AppHandle<R> = app;
        let kind2 = kind.clone();
        let mut last_emit = Instant::now();
        let mut paused = false;
        let mut last_file = String::new();

        let mut ctx = CopyCtx {
            app: Some(app),
            op_id: id,
            kind: &kind,
            total,
            cancel: &cancel,
            created: Vec::new(),
            done: 0,
            progress_hook: Some(&mut |done, current| {
                loop {
                    match *sig.lock().unwrap() {
                        Signal::Run => {
                            if paused {
                                paused = false;
                                set_status(&state2.infos, id, OpStatus::Running);
                            }
                            break;
                        }
                        Signal::Pause => {
                            if !paused {
                                paused = true;
                                set_status(&state2.infos, id, OpStatus::Paused);
                            }
                            std::thread::sleep(PAUSE_POLL);
                        }
                        Signal::Cancel => {
                            cancel2.store(true, Ordering::Relaxed);
                            return Err("отменено".to_string());
                        }
                    }
                }
                progress2.store(done, Ordering::Relaxed);
                if !current.is_empty() && current != last_file {
                    last_file = current.to_string();
                    files_done2.fetch_add(1, Ordering::Relaxed);
                }
                if last_emit.elapsed() >= EMIT_INTERVAL {
                    last_emit = Instant::now();
                    let files = files_done2.load(Ordering::Relaxed);
                    update_progress(state2, id, done, total, current, files, started);
                    emit_progress(app2, id, &kind2, done, total, current);
                }
                Ok(())
            }),
        };

        let mut final_err = None;
        for src in &srcs {
            let Some(name) = src.file_name() else {
                final_err = Some("неверный путь".to_string());
                break;
            };
            let target = match resolve_target(dest.join(name), job.policy) {
                Resolved::Use(t) => t,
                Resolved::Skip => continue,
            };
            if let Err(e) = crate::copy_tree(src, &target, &mut ctx) {
                final_err = Some(e);
                break;
            }
            // files_done считает хук по смене имени файла; здесь инкремент
            // не нужен — иначе каждый файл считался бы дважды.
        }
        if final_err.is_some() {
            ctx.rollback();
        }
        match final_err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    })();

    let done = progress.load(Ordering::Relaxed);
    let files_done_final = files_done.load(Ordering::Relaxed);
    let total = get_info(state, id).map(|i| i.total).unwrap_or(0);
    // Финальный снимок прогресса: при быстром копировании (меньше EMIT_INTERVAL)
    // ни один тик не успевает записать счётчики, и операция завершалась бы
    // с files_done = 0 и нулевой скоростью.
    update_progress(state, id, done, total, "", files_done_final, started);
    let status = match &result {
        Ok(()) => OpStatus::Finished,
        Err(e) if e == "отменено" => OpStatus::Cancelled,
        Err(_) => OpStatus::Failed,
    };
    let error = result.err();
    finish(state, id, status, error.clone(), done);
    let _ = app.emit(
        "op-progress",
        OpProgress {
            op_id: id,
            kind,
            done,
            total,
            current: String::new(),
            finished: true,
            error,
        },
    );
    prune_finished(state, 50);
}

// ==================== тесты менеджера ====================

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> OpsState {
        OpsState::new()
    }

    #[test]
    fn enqueue_assigns_incrementing_ids_and_queued_status() {
        let st = state();
        let a = enqueue(&st, "copy", vec!["/a".into()], "/dest".into(), ConflictPolicy::Rename);
        let b = enqueue(&st, "copy", vec!["/b".into()], "/dest".into(), ConflictPolicy::Rename);
        assert_eq!(a + 1, b);
        assert_eq!(get_info(&st, a).unwrap().status, OpStatus::Queued);
        assert_eq!(get_info(&st, b).unwrap().status, OpStatus::Queued);
    }

    #[test]
    fn try_start_returns_jobs_up_to_concurrency_limit() {
        let st = state();
        for i in 0..5 {
            enqueue(&st, "copy", vec![format!("/f{i}")], "/dest".into(), ConflictPolicy::Rename);
        }
        let mut started = 0;
        while try_start(&st).is_some() {
            started += 1;
            assert!(started <= MAX_CONCURRENT, "превышен лимит параллельности");
            if started >= MAX_CONCURRENT {
                break;
            }
        }
        assert_eq!(started, MAX_CONCURRENT);
        // Очередь не опустела — остальные ждут свободного слота.
        assert!(!st.queue.lock().unwrap().is_empty());
    }

    #[test]
    fn cancel_queued_op_removes_it_from_queue() {
        let st = state();
        for i in 0..5 {
            enqueue(&st, "copy", vec![format!("/f{i}")], "/dest".into(), ConflictPolicy::Rename);
        }
        // Занимаем все слоты, чтобы 5-я осталась в очереди.
        while try_start(&st).is_some() {}
        let queued = *st.queue.lock().unwrap().front().unwrap();
        assert!(signal(&st, queued, Signal::Cancel));
        assert!(!st.queue.lock().unwrap().contains(&queued));
        let info = get_info(&st, queued).unwrap();
        assert_eq!(info.status, OpStatus::Cancelled);
        assert!(info.error.is_some());
    }

    #[test]
    fn pause_marks_queued_op_as_paused() {
        let st = state();
        let id = enqueue(&st, "copy", vec!["/a".into()], "/d".into(), ConflictPolicy::Rename);
        assert!(signal(&st, id, Signal::Pause));
        assert_eq!(get_info(&st, id).unwrap().status, OpStatus::Paused);
        assert!(signal(&st, id, Signal::Run));
        assert_eq!(get_info(&st, id).unwrap().status, OpStatus::Queued);
    }

    #[test]
    fn signal_unknown_id_returns_false() {
        let st = state();
        assert!(!signal(&st, 999, Signal::Cancel));
        assert!(get_info(&st, 999).is_none());
    }

    #[test]
    fn remove_only_touches_finished_ops() {
        let st = state();
        let queued = enqueue(&st, "copy", vec!["/a".into()], "/d".into(), ConflictPolicy::Rename);
        assert!(!remove(&st, queued), "операцию в очереди удалять нельзя");
        // Завершаем вручную (слот не занимался — finish обязан это пережить).
        finish(&st, queued, OpStatus::Finished, None, 100);
        assert!(remove(&st, queued));
        assert!(get_info(&st, queued).is_none());
    }

    #[test]
    fn prune_keeps_only_latest_finished() {
        let st = state();
        st.active.lock().unwrap().clone_from(&0);
        let mut ids = Vec::new();
        for i in 0..8 {
            let id = enqueue(&st, "copy", vec![format!("/f{i}")], "/d".into(), ConflictPolicy::Rename);
            *st.active.lock().unwrap() = 1;
            finish(&st, id, OpStatus::Finished, None, 0);
            ids.push(id);
        }
        // finished_at в секундах может совпасть — тогда порядок по id сохранит prune
        prune_finished(&st, 3);
        let left = list_infos(&st);
        assert_eq!(left.len(), 3, "должно остаться ровно max завершённых");
        // Самые новые (по id/времени) должны выжить.
        assert!(left.iter().any(|i| i.id == *ids.last().unwrap()));
    }

    #[test]
    fn list_infos_is_sorted_by_id() {
        let st = state();
        for i in 0..4 {
            enqueue(&st, "copy", vec![format!("/f{i}")], "/d".into(), ConflictPolicy::Rename);
        }
        let ids: Vec<u64> = list_infos(&st).iter().map(|i| i.id).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted);
    }

    #[test]
    fn eta_and_speed_are_computed_from_elapsed_time() {
        let st = state();
        let id = enqueue(&st, "copy", vec!["/a".into()], "/d".into(), ConflictPolicy::Rename);
        let started = Instant::now() - Duration::from_secs(2);
        update_progress(&st, id, 1000, 4000, "file.bin", 1, started);
        let info = get_info(&st, id).unwrap();
        assert!(info.bytes_per_sec > 400.0 && info.bytes_per_sec < 600.0, "скорость: {}", info.bytes_per_sec);
        // Осталось 3000 из ~500 Б/с => ~6 с.
        assert!(matches!(info.eta_secs, Some(e) if e >= 5 && e <= 7), "eta: {:?}", info.eta_secs);
    }

    #[test]
    fn eta_is_none_when_complete() {
        let st = state();
        let id = enqueue(&st, "copy", vec!["/a".into()], "/d".into(), ConflictPolicy::Rename);
        let started = Instant::now() - Duration::from_secs(1);
        update_progress(&st, id, 500, 500, "", 1, started);
        assert!(get_info(&st, id).unwrap().eta_secs.is_none());
    }

    #[test]
    fn count_files_counts_leaf_entries() {
        use std::fs;
        let mut dir = std::env::temp_dir();
        dir.push(format!("kladovka-countfiles-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.txt"), b"1").unwrap();
        fs::write(dir.join("sub/b.txt"), b"2").unwrap();
        std::os::unix::fs::symlink(dir.join("a.txt"), dir.join("link")).unwrap();

        // 2 файла + 1 симлинк (считается как одна запись).
        assert_eq!(count_files(&dir), 3);
        let _ = fs::remove_dir_all(&dir);
    }
}
