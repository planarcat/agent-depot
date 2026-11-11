#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::process::Command;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::Manager;

const DEFAULT_REPO: &str = "/Users/planarcat/Documents/Projects/@planarcat/agent-depot/WorkTrees/main";
const CONSOLE_URL: &str = "http://127.0.0.1:8317";
const PORT: u16 = 8317;

fn repo_dir() -> String {
    std::env::var("AGENT_DEPOT_REPO").unwrap_or_else(|_| DEFAULT_REPO.to_string())
}

fn service_up() -> bool {
    match format!("127.0.0.1:{PORT}").parse() {
        Ok(addr) => TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok(),
        Err(_) => false,
    }
}

/// 与薄壳一致的语义：双击 = 确保本地服务在跑，然后打开控制台窗口。
fn ensure_service() -> bool {
    if service_up() {
        return true;
    }
    let script = format!("cd '{}' && ./run.sh", repo_dir());
    let _ = Command::new("bash").arg("-c").arg(&script).status();
    for _ in 0..24 {
        if service_up() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    service_up()
}

fn main() {
    let up = ensure_service();
    tauri::Builder::default()
        .setup(move |app| {
            let url = if up {
                tauri::WebviewUrl::External(CONSOLE_URL.parse().expect("valid console url"))
            } else {
                tauri::WebviewUrl::App("index.html".into())
            };
            let _window = tauri::WebviewWindowBuilder::new(app, "main", url)
                .title("Agent Depot")
                .inner_size(1480.0, 960.0)
                .min_inner_size(960.0, 640.0)
                // Tauri 2 内建：macOS 注入 ⌘+ / ⌘- / ⌘0 缩放 polyfill（WKWebView 无原生热键）
                .zoom_hotkeys_enabled(true)
                .build()?;

            // 应用菜单：Tauri 2 macOS 默认菜单不含 Reload（v1 才有），⌘R 因此无效。
            // 注意 set_menu 会整体替换默认菜单——必须补回「编辑」子菜单（Predefined
            // 带系统标准快捷键），否则 ⌘C/⌘V/⌘X/⌘A/⌘Z 全部失效（macOS 上这些热键
            // 由应用菜单驱动 WKWebView 的 responder chain，缺菜单即无粘贴/全选）。
            let edit_menu = Submenu::with_items(
                app,
                "编辑",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;
            let reload = MenuItem::with_id(app, "reload", "重新加载", true, Some("CmdOrCtrl+R"))?;
            let view_menu = Submenu::with_items(app, "视图", true, &[&reload])?;
            app.set_menu(Menu::with_items(app, &[&edit_menu, &view_menu])?)?;

            let handle = app.handle().clone();
            app.on_menu_event(move |_window, event| {
                if event.id().as_ref() == "reload" {
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.eval("window.location.reload()");
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
