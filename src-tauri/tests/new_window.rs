//! Тесты создания окна (Этап 3: несколько окон).
//!
//! Часть проверок идёт через mock-рантайм Tauri (реальный AppHandle, окна
//! действительно регистрируются), часть — через чистую функцию генерации
//! скрипта: mock подменяет URL на `tauri://localhost`, поэтому путь в окне
//! там не проверить.

use file_manager_lib::{new_window_impl, start_path_script};
use tauri::test::mock_app;
use tauri::Manager;

#[test]
fn создаёт_окно_и_возвращает_метку() {
    let app = mock_app();
    let label = tauri::async_runtime::block_on(new_window_impl(&app.handle(), None))
        .expect("окно должно создаться");
    assert!(label.starts_with("win-"), "неожиданная метка: {label}");
}

#[test]
fn метки_уникальны_между_окнами() {
    let app = mock_app();
    let a = tauri::async_runtime::block_on(new_window_impl(&app.handle(), None)).unwrap();
    let b = tauri::async_runtime::block_on(new_window_impl(&app.handle(), None)).unwrap();
    assert_ne!(a, b, "метки окон должны различаться");

    // Обе метки действительно заняты в приложении.
    let windows = app.webview_windows();
    assert!(windows.contains_key(&a), "окно {a} не зарегистрировано");
    assert!(windows.contains_key(&b), "окно {b} не зарегистрировано");
}

#[test]
fn окно_регистрируется_по_метке() {
    let app = mock_app();
    let label = tauri::async_runtime::block_on(new_window_impl(
        &app.handle(),
        Some("/Users/test/Documents".to_string()),
    ))
    .expect("окно должно создаться");
    assert!(
        app.get_webview_window(&label).is_some(),
        "окно {label} должно находиться по метке"
    );
}

#[test]
fn без_пути_скрипт_не_генерируется() {
    assert_eq!(start_path_script(None), None);
}

#[test]
fn скрипт_содержит_путь_как_js_литерал() {
    let script = start_path_script(Some("/Users/alex/Documents")).unwrap();
    assert_eq!(
        script,
        r#"window.__KLADOVKA_START_PATH__ = "/Users/alex/Documents";"#
    );
}

#[test]
fn кавычки_и_слэши_экранируются() {
    // Windows-путь с обратными слэшами и кавычкой не должен ломать литерал.
    let tricky = r#"C:\Users\"test"\new"#;
    let script = start_path_script(Some(tricky)).unwrap();

    // Обратный слэш и кавычка экранированы — значит JSON валиден.
    assert!(script.contains(r#"\\"#), "нет экранированного слэша: {script}");
    assert!(script.contains(r#"\""#), "нет экранированной кавычки: {script}");

    // Значение должно разбираться обратно без потерь.
    let value = script
        .trim_start_matches("window.__KLADOVKA_START_PATH__ = ")
        .trim_end_matches(';');
    let parsed: String = serde_json::from_str(value).expect("JSON должен разбираться");
    assert_eq!(parsed, tricky, "путь должен восстановиться без потерь");
}

#[test]
fn юникод_в_пути_сохраняется() {
    let path = "/Users/Саня/Документы";
    let script = start_path_script(Some(path)).unwrap();
    let value = script
        .trim_start_matches("window.__KLADOVKA_START_PATH__ = ")
        .trim_end_matches(';');
    let parsed: String = serde_json::from_str(value).unwrap();
    assert_eq!(parsed, path);
}

#[test]
fn каждая_следующая_метка_отличается_от_предыдущей() {
    // Метка формируется из счётчика — под нагрузкой не должно быть повторов.
    let app = mock_app();
    let mut seen = std::collections::HashSet::new();
    for _ in 0..5 {
        let label = tauri::async_runtime::block_on(new_window_impl(&app.handle(), None)).unwrap();
        assert!(seen.insert(label), "повтор метки окна");
    }
}
