#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, State};

const DEFAULT_REPO: &str = "/Users/planarcat/Documents/Projects/@planarcat/agent-depot/WorkTrees/main";
const CONSOLE_URL: &str = "http://127.0.0.1:8317";
const PORT: u16 = 8317;
const BASE_NAME: &str = "Agent Depot";
const TRAY_ID: &str = "agent-depot-tray";
const AUTOSTART_LABEL: &str = "local.planarcat.agent-depot";

/// 构建身份：debug 构建、或 bundle id 以 `.dev` 结尾（make-app-dev.sh）= 开发版。
/// dev 与 release 的设置文件、开机启动项、默认值、服务库全部隔离。
/// 运行时以 bundle id 为准，避免「同一个 target 目录先后构建 release/dev」时
/// 编译期环境变量未触发重编导致两版写同一份设置。
static DEV_BUILD: OnceLock<bool> = OnceLock::new();

fn init_profile(app: &tauri::AppHandle) {
    let dev = app.config().identifier.ends_with(".dev") || cfg!(debug_assertions);
    let _ = DEV_BUILD.set(dev);
}

fn is_dev_build() -> bool {
    *DEV_BUILD.get().unwrap_or(&cfg!(debug_assertions))
}

fn profile() -> &'static str {
    if is_dev_build() {
        "dev"
    } else {
        "release"
    }
}

/// 显示名：开发版带 Dev 后缀（窗口标题 / 托盘 / Dock 名称），两版同开时一眼可分。
fn display_name() -> String {
    if is_dev_build() {
        format!("{BASE_NAME} Dev")
    } else {
        BASE_NAME.to_string()
    }
}

fn settings_file_name() -> &'static str {
    if is_dev_build() {
        "desktop-dev.json"
    } else {
        "desktop.json"
    }
}

/// dev 用独立 LaunchAgent label，避免覆盖正式版的开机启动。
fn autostart_label() -> String {
    if is_dev_build() {
        format!("{AUTOSTART_LABEL}-dev")
    } else {
        AUTOSTART_LABEL.to_string()
    }
}

/* ==================== 桌面设置（持久化到 App Config） ==================== */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct DesktopSettings {
    /// 登录时自动启动（写入 ~/Library/LaunchAgents 的 LaunchAgent）
    launch_at_login: bool,
    /// 菜单栏挂载（托盘图标 + 关窗隐藏）
    menu_bar: bool,
    /// 静默启动：启动后只挂菜单栏，不弹窗口（依赖菜单栏挂载）
    silent_start: bool,
    /// 是否在 Dock 显示图标
    show_dock_icon: bool,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            launch_at_login: false,
            // 开发版默认不挂菜单栏，避免调试时与正式版出现两个托盘图标
            menu_bar: !is_dev_build(),
            silent_start: false,
            show_dock_icon: true,
        }
    }
}

impl DesktopSettings {
    /// 静默启动必须有菜单栏入口，否则用户无法再打开窗口。
    fn normalized(mut self) -> Self {
        if !self.menu_bar {
            self.silent_start = false;
        }
        self
    }
}

struct DesktopState {
    settings: Mutex<DesktopSettings>,
}

fn settings_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .map(|d| d.join(settings_file_name()))
        .unwrap_or_else(|_| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default()
                .join(".agent-depot-desktop.json")
        })
}

fn read_settings_file(path: &Path) -> DesktopSettings {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<DesktopSettings>(&s).ok())
        .unwrap_or_default()
        .normalized()
}

fn write_settings_file(path: &Path, settings: &DesktopSettings) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let body = serde_json::to_string_pretty(settings).map_err(|e| format!("序列化设置失败：{e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|e| format!("写入设置失败：{e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("保存设置失败：{e}"))?;
    Ok(())
}

fn load_settings(app: &tauri::AppHandle) -> DesktopSettings {
    read_settings_file(&settings_path(app))
}

fn save_settings(app: &tauri::AppHandle, settings: &DesktopSettings) -> Result<(), String> {
    write_settings_file(&settings_path(app), settings)
}

/* ==================== 开机启动（macOS LaunchAgent） ==================== */

#[cfg(target_os = "macos")]
fn autostart_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| {
        PathBuf::from(home)
            .join("Library/LaunchAgents")
            .join(format!("{}.plist", autostart_label()))
    })
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(target_os = "macos")]
fn autostart_plist(exe: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
    <string>--silent</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict>
</plist>
"#,
        autostart_label(),
        xml_escape(exe)
    )
}

#[cfg(target_os = "macos")]
fn sync_autostart(enabled: bool) {
    let Some(path) = autostart_path() else { return };
    if enabled {
        let Ok(exe) = std::env::current_exe() else { return };
        let plist = autostart_plist(&exe.to_string_lossy());
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        // 只写 plist，不立即 launchctl load：否则已运行的实例旁会再起一个 --silent 副本。
        // 开机启动语义本来就是「下次登录生效」。
        let _ = fs::write(&path, plist);
    } else if path.exists() {
        let _ = Command::new("launchctl")
            .arg("unload")
            .arg("-w")
            .arg(&path)
            .output();
        let _ = fs::remove_file(&path);
    }
}

#[cfg(not(target_os = "macos"))]
fn sync_autostart(_enabled: bool) {}

/* ==================== 窗口 / 菜单栏 ==================== */

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
    let script = format!(
        "cd '{}' && AGENT_DEPOT_PROFILE='{}' ./run.sh",
        repo_dir(),
        profile()
    );
    let _ = Command::new("bash").arg("-c").arg(&script).status();
    for _ in 0..24 {
        if service_up() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    service_up()
}

fn show_main(app: &tauri::AppHandle) {
    // 窗口打开时 Dock 图标始终显示（即使设置是「关窗后隐藏」）
    set_dock_visible(app, true);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Dock 图标策略：
/// - 窗口打开 → 始终显示；
/// - 窗口关闭/隐藏 → 只有「显示 Dock 图标」开启才保留；
/// - 菜单栏未挂载时不能隐藏 Dock，否则用户无法再打开窗口。
fn dock_visible(window_visible: bool, show_dock_icon: bool, menu_bar: bool) -> bool {
    window_visible || show_dock_icon || !menu_bar
}

fn is_main_visible(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

fn apply_dock_policy_for(app: &tauri::AppHandle, settings: &DesktopSettings, window_visible: bool) {
    set_dock_visible(
        app,
        dock_visible(window_visible, settings.show_dock_icon, settings.menu_bar),
    );
}

fn apply_dock_policy(app: &tauri::AppHandle, settings: &DesktopSettings) {
    apply_dock_policy_for(app, settings, is_main_visible(app));
}

#[cfg(target_os = "macos")]
fn set_dock_visible(app: &tauri::AppHandle, visible: bool) {
    if let Err(e) = app.set_dock_visibility(visible) {
        eprintln!("[desktop] set_dock_visibility({visible}): {e}");
    }
}

#[cfg(not(target_os = "macos"))]
fn set_dock_visible(_app: &tauri::AppHandle, _visible: bool) {}

fn ensure_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let name = display_name();
    let show = MenuItem::with_id(app, "show", &format!("显示{name}"), true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "打开设置…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", &format!("退出{name}"), true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(display_name())
        // macOS：图标旁常驻文字——两版同开时菜单栏上一眼可分
        .title(if is_dev_build() { "Dev".to_string() } else { String::new() })
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "settings" => {
                show_main(app);
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.eval("window.dispatchEvent(new CustomEvent('depot:open-settings'))");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone()).icon_as_template(true);
    }
    builder.build(app)?;
    Ok(())
}

fn set_tray(app: &tauri::AppHandle, enabled: bool) {
    if enabled {
        if let Err(e) = ensure_tray(app) {
            eprintln!("[desktop] tray setup failed: {e}");
        }
    } else {
        let _ = app.remove_tray_by_id(TRAY_ID);
    }
}

/* ==================== IPC 命令（web 设置页调用） ==================== */

#[derive(Debug, Serialize)]
struct RuntimeInfo {
    profile: &'static str,
    instance: String,
    version: &'static str,
    pid: u32,
    service_url: &'static str,
    data_dir: String,
    config_dir: String,
}

#[tauri::command]
fn desktop_profile() -> &'static str {
    profile()
}

/// 开发版「监控」页用的运行时信息（端口/实例/数据目录/PID）。
#[tauri::command]
fn desktop_runtime_info(app: tauri::AppHandle) -> RuntimeInfo {
    let instance = std::env::var("APP_INSTANCE").unwrap_or_default();
    let data_dir = std::env::var("APP_DATA_DIR")
        .ok()
        .or_else(|| {
            app.path()
                .app_data_dir()
                .ok()
                .map(|p| p.to_string_lossy().to_string())
        })
        .unwrap_or_default();
    let config_dir = settings_path(&app)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    RuntimeInfo {
        profile: profile(),
        instance,
        version: env!("CARGO_PKG_VERSION"),
        pid: std::process::id(),
        service_url: CONSOLE_URL,
        data_dir,
        config_dir,
    }
}

#[tauri::command]
fn desktop_get_settings(state: State<'_, DesktopState>) -> DesktopSettings {
    state
        .settings
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default()
}

#[tauri::command]
fn desktop_set_settings(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    settings: DesktopSettings,
) -> Result<DesktopSettings, String> {
    let next = settings.normalized();
    save_settings(&app, &next)?;
    apply_dock_policy(&app, &next);
    set_tray(&app, next.menu_bar);
    sync_autostart(next.launch_at_login);
    if let Ok(mut guard) = state.settings.lock() {
        *guard = next.clone();
    }
    Ok(next)
}

/* ==================== 入口 ==================== */

fn main() {
    let up = ensure_service();
    let cli_silent = std::env::args().any(|a| a == "--silent");

    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            desktop_profile,
            desktop_runtime_info,
            desktop_get_settings,
            desktop_set_settings
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                let menu_bar = window
                    .app_handle()
                    .try_state::<DesktopState>()
                    .map(|s| s.settings.lock().map(|g| g.menu_bar).unwrap_or(false))
                    .unwrap_or(false);
                if menu_bar {
                    // 菜单栏常驻：关窗 = 隐藏，托盘可再打开
                    api.prevent_close();
                    let _ = window.hide();
                    if let Some(state) = window.app_handle().try_state::<DesktopState>() {
                        if let Ok(s) = state.settings.lock() {
                            // 窗口已隐藏：按「关窗后是否保留 Dock 图标」刷新
                            apply_dock_policy_for(window.app_handle(), &s, false);
                        }
                    }
                }
            }
        })
        .setup(move |app| {
            init_profile(app.handle());
            let settings = load_settings(app.handle());
            app.manage(DesktopState {
                settings: Mutex::new(settings.clone()),
            });

            let silent = (cli_silent || settings.silent_start) && settings.menu_bar;
            let url = if up {
                tauri::WebviewUrl::External(CONSOLE_URL.parse().expect("valid console url"))
            } else {
                tauri::WebviewUrl::App("index.html".into())
            };
            let _window = tauri::WebviewWindowBuilder::new(app, "main", url)
                .title(display_name())
                .inner_size(1480.0, 960.0)
                .min_inner_size(960.0, 640.0)
                // 静默启动：窗口先建好但不显示，托盘/菜单可随时唤起
                .visible(!silent)
                // Tauri 2 内建：macOS 注入 ⌘+ / ⌘- / ⌘0 缩放 polyfill（WKWebView 无原生热键）
                .zoom_hotkeys_enabled(true)
                .build()?;

            apply_dock_policy_for(app.handle(), &settings, !silent);
            set_tray(app.handle(), settings.menu_bar);
            sync_autostart(settings.launch_at_login);

            // 应用菜单：Tauri 2 macOS 默认菜单不含 Reload（v1 才有），⌘R 因此无效。
            // 注意 set_menu 会整体替换默认菜单——必须补回「编辑」子菜单（Predefined
            // 带系统标准快捷键），否则 ⌘C/⌘V/⌘X/⌘A/⌘Z 全部失效（macOS 上这些热键
            // 由应用菜单驱动 WKWebView 的 responder chain，缺菜单即无粘贴/全选）。
            // 应用子菜单：set_menu 整体替换默认菜单后，⌘Q（退出）随之消失
            // （2026-11-11 用户实测无法 Cmd+Q）——必须显式补回 Quit 项。
            let app_menu = Submenu::with_items(
                app,
                "Agent Depot",
                true,
                &[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;
            let file_menu = Submenu::with_items(
                app,
                "文件",
                true,
                &[&PredefinedMenuItem::close_window(app, None)?],
            )?;
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
            app.set_menu(Menu::with_items(
                app,
                &[&app_menu, &file_menu, &edit_menu, &view_menu],
            )?)?;

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
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // 点 Dock 图标（窗口被隐藏时）→ 重新显示主窗口
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows,
            ..
        } = event
        {
            if !has_visible_windows {
                show_main(app_handle);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agent-depot-desktop-test-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn silent_start_requires_menu_bar() {
        let s = DesktopSettings {
            menu_bar: false,
            silent_start: true,
            ..Default::default()
        }
        .normalized();
        assert!(!s.silent_start);
        let ok = DesktopSettings {
            menu_bar: true,
            silent_start: true,
            ..Default::default()
        }
        .normalized();
        assert!(ok.silent_start);
    }

    #[test]
    fn settings_roundtrip() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("desktop.json");
        let s = DesktopSettings {
            launch_at_login: true,
            menu_bar: false,
            silent_start: true, // 会被归一化为 false
            show_dock_icon: false,
        };
        write_settings_file(&path, &s).unwrap();
        let back = read_settings_file(&path);
        assert!(back.launch_at_login);
        assert!(!back.menu_bar);
        assert!(!back.silent_start);
        assert!(!back.show_dock_icon);
        assert!(!path.with_extension("json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bad_json_falls_back_to_default() {
        let dir = temp_dir("badjson");
        let path = dir.join("desktop.json");
        fs::write(&path, "{not json").unwrap();
        let d = DesktopSettings::default();
        let back = read_settings_file(&path);
        assert_eq!(back.menu_bar, d.menu_bar);
        assert_eq!(back.show_dock_icon, d.show_dock_icon);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn xml_escape_covers_specials() {
        assert_eq!(xml_escape("a&b<c>d\"e'f"), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn plist_contains_silent_flag_and_label() {
        let plist = autostart_plist("/Applications/Agent Depot.app/Contents/MacOS/agent");
        assert!(plist.contains(&format!("<string>{}</string>", autostart_label())));
        assert!(plist.contains("<string>--silent</string>"));
        assert!(plist.contains("RunAtLoad"));
    }

    #[test]
    fn display_name_distinguishes_profiles() {
        // 测试进程是 debug 构建 → 开发版
        assert_eq!(display_name(), "Agent Depot Dev");
    }

    #[test]
    fn dock_icon_only_hidden_when_window_closed() {
        // 窗口打开：任何设置都显示
        assert!(dock_visible(true, true, true));
        assert!(dock_visible(true, false, true));
        // 窗口关闭 + 显示 Dock 图标：保留
        assert!(dock_visible(false, true, true));
        // 窗口关闭 + 不显示 + 菜单栏已挂载：隐藏
        assert!(!dock_visible(false, false, true));
        // 窗口关闭 + 不显示 + 没有菜单栏入口：必须保留 Dock
        assert!(dock_visible(false, false, false));
    }

    #[test]
    fn dev_profile_isolated_names() {
        assert_eq!(profile(), "dev");
        assert_eq!(settings_file_name(), "desktop-dev.json");
        assert_eq!(autostart_label(), "local.planarcat.agent-depot-dev");
        // 开发版默认不挂菜单栏，正式版默认挂
        assert!(!DesktopSettings::default().menu_bar);
    }
}
