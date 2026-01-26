use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter, State};

// State to track running ping processes
pub struct PingManager {
    processes: Arc<Mutex<HashMap<String, PingProcess>>>,
}

struct PingProcess {
    child: Child,
    stop_flag: Arc<Mutex<bool>>,
}

impl Default for PingManager {
    fn default() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Clone, Serialize)]
struct PingResult {
    server_id: String,
    time_ms: f64,
}

#[derive(Clone, Serialize)]
struct PingTimeout {
    server_id: String,
}

#[derive(Clone, Serialize)]
struct PingEvent {
    server_id: String,
}

#[derive(Deserialize)]
pub struct TogglePingArgs {
    server_id: String,
    address: String,
    count: u32,
}

// Parse ping output to extract latency
fn parse_ping_line(line: &str) -> Option<f64> {
    // Linux/macOS format: "64 bytes from x.x.x.x: icmp_seq=1 ttl=64 time=12.3 ms"
    // Windows format: "Reply from x.x.x.x: bytes=32 time=12ms TTL=64"

    let re_unix = Regex::new(r"time[=<](\d+\.?\d*)\s*ms").ok()?;
    let re_windows = Regex::new(r"time[=<](\d+)\s*ms").ok()?;

    if let Some(caps) = re_unix.captures(line) {
        return caps.get(1)?.as_str().parse().ok();
    }

    if let Some(caps) = re_windows.captures(line) {
        return caps.get(1)?.as_str().parse().ok();
    }

    None
}

// Check if line indicates a timeout
fn is_timeout_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("request timed out")
        || lower.contains("request timeout")
        || lower.contains("100% packet loss")
        || lower.contains("destination host unreachable")
        || lower.contains("network is unreachable")
}

#[tauri::command]
fn toggle_ping(
    app: AppHandle,
    state: State<'_, PingManager>,
    args: TogglePingArgs,
) -> Result<bool, String> {
    let server_id = args.server_id.clone();

    // Check if already running
    {
        let mut processes = state.processes.lock();
        if let Some(mut process) = processes.remove(&server_id) {
            // Stop the running process
            *process.stop_flag.lock() = true;
            let _ = process.child.kill();

            // Emit stopped event
            let _ = app.emit("ping-stopped", PingEvent {
                server_id: server_id.clone(),
            });

            return Ok(false); // Returning false means we stopped
        }
    }

    // Validate the address - only allow alphanumeric, dots, hyphens
    let address = &args.address;
    if !address.chars().all(|c| c.is_alphanumeric() || c == '.' || c == '-' || c == ':') {
        return Err("Invalid address format".to_string());
    }

    // Build ping command based on platform
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("ping");
        c.args(["-n", &args.count.to_string(), address]);
        c
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new("ping");
        c.args(["-c", &args.count.to_string(), address]);
        c
    };

    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Prevent window creation on Windows
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn ping: {}", e))?;
    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;

    let stop_flag = Arc::new(Mutex::new(false));
    let process = PingProcess {
        child,
        stop_flag: stop_flag.clone(),
    };

    // Store the process
    {
        let mut processes = state.processes.lock();
        processes.insert(server_id.clone(), process);
    }

    // Spawn a thread to read stdout and emit events
    let app_clone = app.clone();
    let server_id_clone = server_id.clone();
    let processes_clone = state.processes.clone();

    thread::spawn(move || {
        let reader = BufReader::new(stdout);

        for line in reader.lines() {
            // Check stop flag
            if *stop_flag.lock() {
                break;
            }

            if let Ok(line) = line {
                // Try to parse ping result
                if let Some(time_ms) = parse_ping_line(&line) {
                    let _ = app_clone.emit("ping-result", PingResult {
                        server_id: server_id_clone.clone(),
                        time_ms,
                    });
                } else if is_timeout_line(&line) {
                    let _ = app_clone.emit("ping-timeout", PingTimeout {
                        server_id: server_id_clone.clone(),
                    });
                }
            }
        }

        // Remove from processes map and emit complete
        {
            let mut processes = processes_clone.lock();
            processes.remove(&server_id_clone);
        }

        // Only emit complete if we weren't stopped
        if !*stop_flag.lock() {
            let _ = app_clone.emit("ping-complete", PingEvent {
                server_id: server_id_clone,
            });
        }
    });

    Ok(true) // Returning true means we started
}

#[tauri::command]
fn stop_all_pings(state: State<'_, PingManager>) {
    let mut processes = state.processes.lock();
    for (_, mut process) in processes.drain() {
        *process.stop_flag.lock() = true;
        let _ = process.child.kill();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(PingManager::default())
        .invoke_handler(tauri::generate_handler![toggle_ping, stop_all_pings])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
