mod ssh;
#[allow(dead_code)]
mod zmodem;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path as AxumPath, State, WebSocketUpgrade,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{broadcast, mpsc, Mutex},
    task::JoinHandle,
};
use rust_embed::Embed;
use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
use tokio_serial::SerialPortBuilderExt;
use tower_http::cors::CorsLayer;

// ---------------------------------------------------------------------------
// Embedded frontend assets
// ---------------------------------------------------------------------------

#[derive(Embed)]
#[folder = "../frontend/"]
struct Assets;

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
struct PortConfig {
    port: String,
    baud_rate: u32,
    data_bits: u8,
    stop_bits: u8,
    parity: String,
}

#[derive(Serialize)]
struct PortInfo {
    name: String,
    port_type: String,
}

#[derive(Serialize)]
struct ApiResponse {
    ok: bool,
    message: String,
}

#[derive(Serialize)]
struct SshStatusConfig {
    host: String,
    port: u16,
    username: String,
}

#[derive(Serialize)]
struct StatusResponse {
    connected: bool,
    connection_type: Option<String>,
    port: Option<String>,
    config: Option<PortConfig>,
    ssh_config: Option<SshStatusConfig>,
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

struct SerialConnection {
    port_name: String,
    config: PortConfig,
    tx_to_serial: mpsc::Sender<Vec<u8>>,
    reader_handle: JoinHandle<()>,
    writer_handle: JoinHandle<()>,
}

const SCROLLBACK_MAX: usize = 128 * 1024; // 128KB

enum ConnectionKind {
    Serial(SerialConnection),
    Ssh(ssh::SshConnection),
}

struct AppState {
    connection: Mutex<Option<ConnectionKind>>,
    broadcast_tx: broadcast::Sender<Vec<u8>>,
    scrollback: Arc<Mutex<VecDeque<u8>>>,
    zmodem_active: Arc<AtomicBool>,
    zmodem_data_tx_shared: Arc<Mutex<Option<mpsc::Sender<Vec<u8>>>>>,
    zmodem_files: Mutex<Vec<PathBuf>>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn to_data_bits(bits: u8) -> tokio_serial::DataBits {
    match bits {
        5 => tokio_serial::DataBits::Five,
        6 => tokio_serial::DataBits::Six,
        7 => tokio_serial::DataBits::Seven,
        _ => tokio_serial::DataBits::Eight,
    }
}

fn to_stop_bits(bits: u8) -> tokio_serial::StopBits {
    match bits {
        2 => tokio_serial::StopBits::Two,
        _ => tokio_serial::StopBits::One,
    }
}

fn to_parity(p: &str) -> tokio_serial::Parity {
    match p {
        "odd" => tokio_serial::Parity::Odd,
        "even" => tokio_serial::Parity::Even,
        _ => tokio_serial::Parity::None,
    }
}

fn port_type_string(pt: &serialport::SerialPortType) -> String {
    match pt {
        serialport::SerialPortType::UsbPort(info) => {
            format!(
                "USB (VID:{:04x} PID:{:04x})",
                info.vid, info.pid
            )
        }
        serialport::SerialPortType::BluetoothPort => "Bluetooth".to_string(),
        serialport::SerialPortType::PciPort => "PCI".to_string(),
        serialport::SerialPortType::Unknown => "Unknown".to_string(),
    }
}

// ---------------------------------------------------------------------------
// REST handlers
// ---------------------------------------------------------------------------

async fn list_ports() -> impl IntoResponse {
    match serialport::available_ports() {
        Ok(ports) => {
            let infos: Vec<PortInfo> = ports
                .into_iter()
                .map(|p| PortInfo {
                    name: p.port_name,
                    port_type: port_type_string(&p.port_type),
                })
                .collect();
            (StatusCode::OK, Json(serde_json::json!(infos))).into_response()
        }
        Err(e) => {
            tracing::error!("Failed to list ports: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse {
                    ok: false,
                    message: format!("Failed to list ports: {}", e),
                }),
            )
                .into_response()
        }
    }
}

async fn connect(
    State(state): State<Arc<AppState>>,
    Json(config): Json<PortConfig>,
) -> impl IntoResponse {
    // Clear scrollback for new connection
    state.scrollback.lock().await.clear();

    let mut conn = state.connection.lock().await;

    if conn.is_some() {
        return (
            StatusCode::CONFLICT,
            Json(ApiResponse {
                ok: false,
                message: "Already connected. Disconnect first.".to_string(),
            }),
        );
    }

    let builder = tokio_serial::new(&config.port, config.baud_rate)
        .data_bits(to_data_bits(config.data_bits))
        .stop_bits(to_stop_bits(config.stop_bits))
        .parity(to_parity(&config.parity));

    let serial_port = match builder.open_native_async() {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("Failed to open serial port {}: {}", config.port, e);
            return (
                StatusCode::BAD_REQUEST,
                Json(ApiResponse {
                    ok: false,
                    message: format!("Failed to open port: {}", e),
                }),
            );
        }
    };

    tracing::info!("Opened serial port {} at {} baud", config.port, config.baud_rate);

    let (mut reader, mut writer) = tokio::io::split(serial_port);

    // Channel: WebSocket clients -> serial writer
    let (tx_to_serial, mut rx_from_ws) = mpsc::channel::<Vec<u8>>(256);

    // Use the shared broadcast sender
    let broadcast_tx = state.broadcast_tx.clone();

    // Reader task: serial -> broadcast + scrollback (with ZMODEM intercept)
    let bc_tx = broadcast_tx.clone();
    let state_for_reader = state.clone();
    let reader_handle = tokio::spawn(async move {
        let mut buf = [0u8; 1024];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) => {
                    tracing::info!("Serial port reader: EOF");
                    break;
                }
                Ok(n) => {
                    let data = buf[..n].to_vec();

                    // If ZMODEM is active, route data to the ZMODEM handler
                    if state_for_reader.zmodem_active.load(Ordering::Relaxed) {
                        let tx = state_for_reader.zmodem_data_tx_shared.lock().await;
                        if let Some(ref zmodem_tx) = *tx {
                            let _ = zmodem_tx.send(data).await;
                        }
                        continue;
                    }

                    // Normal path: append to scrollback and broadcast
                    {
                        let mut sb = state_for_reader.scrollback.lock().await;
                        sb.extend(&data);
                        while sb.len() > SCROLLBACK_MAX {
                            sb.pop_front();
                        }
                    }
                    let _ = bc_tx.send(data);
                }
                Err(e) => {
                    tracing::error!("Serial read error: {}", e);
                    break;
                }
            }
        }
    });

    // Writer task: mpsc -> serial
    let writer_handle = tokio::spawn(async move {
        while let Some(data) = rx_from_ws.recv().await {
            if let Err(e) = writer.write_all(&data).await {
                tracing::error!("Serial write error: {}", e);
                break;
            }
        }
        tracing::info!("Serial writer task ended");
    });

    let port_name = config.port.clone();
    *conn = Some(ConnectionKind::Serial(SerialConnection {
        port_name: port_name.clone(),
        config,
        tx_to_serial,
        reader_handle,
        writer_handle,
    }));

    (
        StatusCode::OK,
        Json(ApiResponse {
            ok: true,
            message: format!("Connected to {}", port_name),
        }),
    )
}

async fn disconnect(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let mut conn = state.connection.lock().await;

    match conn.take() {
        Some(ConnectionKind::Serial(c)) => {
            tracing::info!("Disconnecting from serial {}", c.port_name);
            c.reader_handle.abort();
            c.writer_handle.abort();
            state.scrollback.lock().await.clear();
            (
                StatusCode::OK,
                Json(ApiResponse {
                    ok: true,
                    message: format!("Disconnected from {}", c.port_name),
                }),
            )
        }
        Some(ConnectionKind::Ssh(c)) => {
            let host = c.config.host.clone();
            tracing::info!("Disconnecting from SSH {}", host);
            c.disconnect().await;
            state.scrollback.lock().await.clear();
            (
                StatusCode::OK,
                Json(ApiResponse {
                    ok: true,
                    message: format!("Disconnected from SSH {}", host),
                }),
            )
        }
        None => (
            StatusCode::OK,
            Json(ApiResponse {
                ok: true,
                message: "Not connected".to_string(),
            }),
        ),
    }
}

async fn ssh_connect(
    State(state): State<Arc<AppState>>,
    Json(config): Json<ssh::SshConfig>,
) -> impl IntoResponse {
    state.scrollback.lock().await.clear();

    let mut conn = state.connection.lock().await;

    if conn.is_some() {
        return (
            StatusCode::CONFLICT,
            Json(ApiResponse {
                ok: false,
                message: "Already connected. Disconnect first.".to_string(),
            }),
        );
    }

    let host = format!("{}:{}", config.host, config.port);

    match ssh::SshConnection::connect(
        config,
        state.broadcast_tx.clone(),
        state.scrollback.clone(),
        SCROLLBACK_MAX,
        state.zmodem_active.clone(),
        state.zmodem_data_tx_shared.clone(),
    )
    .await
    {
        Ok(ssh_conn) => {
            *conn = Some(ConnectionKind::Ssh(ssh_conn));
            (
                StatusCode::OK,
                Json(ApiResponse {
                    ok: true,
                    message: format!("Connected to SSH {}", host),
                }),
            )
        }
        Err(e) => {
            tracing::error!("SSH connection failed: {}", e);
            (
                StatusCode::BAD_REQUEST,
                Json(ApiResponse {
                    ok: false,
                    message: e,
                }),
            )
        }
    }
}

async fn status(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let conn = state.connection.lock().await;
    match conn.as_ref() {
        Some(ConnectionKind::Serial(c)) => Json(StatusResponse {
            connected: true,
            connection_type: Some("serial".to_string()),
            port: Some(c.port_name.clone()),
            config: Some(c.config.clone()),
            ssh_config: None,
        }),
        Some(ConnectionKind::Ssh(c)) => Json(StatusResponse {
            connected: true,
            connection_type: Some("ssh".to_string()),
            port: Some(format!("ssh://{}:{}", c.config.host, c.config.port)),
            config: None,
            ssh_config: Some(SshStatusConfig {
                host: c.config.host.clone(),
                port: c.config.port,
                username: c.config.username.clone(),
            }),
        }),
        None => Json(StatusResponse {
            connected: false,
            connection_type: None,
            port: None,
            config: None,
            ssh_config: None,
        }),
    }
}

// ---------------------------------------------------------------------------
// WebSocket handler
// ---------------------------------------------------------------------------

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(socket: WebSocket, state: Arc<AppState>) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Send scrollback buffer first so client sees previous output
    {
        let sb = state.scrollback.lock().await;
        if !sb.is_empty() {
            let data: Vec<u8> = sb.iter().copied().collect();
            if ws_tx.send(Message::Binary(data.into())).await.is_err() {
                return;
            }
        }
    }

    // Subscribe to broadcast for serial RX data
    let mut broadcast_rx = state.broadcast_tx.subscribe();

    // Get a clone of the mpsc sender for writing (serial or SSH)
    let get_write_tx = |state: &Arc<AppState>| {
        let state = state.clone();
        async move {
            let conn = state.connection.lock().await;
            match conn.as_ref() {
                Some(ConnectionKind::Serial(c)) => Some(c.tx_to_serial.clone()),
                Some(ConnectionKind::Ssh(c)) => Some(c.tx_to_ssh.clone()),
                None => None,
            }
        }
    };

    // Get the resize sender for SSH connections
    let get_resize_tx = |state: &Arc<AppState>| {
        let state = state.clone();
        async move {
            let conn = state.connection.lock().await;
            match conn.as_ref() {
                Some(ConnectionKind::Ssh(c)) => Some(c.resize_tx.clone()),
                _ => None,
            }
        }
    };

    // Task A: broadcast (serial RX) -> WebSocket (with ZMODEM filtering)
    let zmodem_active_for_send = state.zmodem_active.clone();
    let mut send_task = tokio::spawn(async move {
        loop {
            match broadcast_rx.recv().await {
                Ok(data) => {
                    // Always intercept ZMODEM notifications (sent as Text frames)
                    // regardless of zmodem_active state, so "completed" notifications
                    // arrive as Text frames that the frontend can parse.
                    if data.starts_with(b"\x1b]zmodem;") {
                        if ws_tx
                            .send(Message::Text(
                                String::from_utf8_lossy(&data).to_string().into(),
                            ))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        continue;
                    }
                    // During ZMODEM mode, suppress raw transfer data
                    if zmodem_active_for_send.load(Ordering::Relaxed) {
                        continue;
                    }
                    if ws_tx.send(Message::Binary(data.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("WebSocket client lagged, skipped {} messages", n);
                }
                Err(broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    });

    // Task B: WebSocket -> serial TX (via mpsc) — blocked during ZMODEM
    let state_clone = state.clone();
    let zmodem_active_for_recv = state.zmodem_active.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_rx.next().await {
            match msg {
                Message::Binary(data) => {
                    // Block user input during ZMODEM transfer
                    if zmodem_active_for_recv.load(Ordering::Relaxed) {
                        continue;
                    }
                    if let Some(tx) = get_write_tx(&state_clone).await {
                        if tx.send(data.to_vec()).await.is_err() {
                            tracing::error!("Failed to send data to serial writer");
                            break;
                        }
                    }
                }
                Message::Text(text) => {
                    // Try to parse as a resize command
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                        if val.get("type").and_then(|v| v.as_str()) == Some("resize") {
                            if let (Some(cols), Some(rows)) = (
                                val.get("cols").and_then(|v| v.as_u64()),
                                val.get("rows").and_then(|v| v.as_u64()),
                            ) {
                                if let Some(resize_tx) = get_resize_tx(&state_clone).await {
                                    let _ = resize_tx.send((cols as u32, rows as u32)).await;
                                }
                            }
                            continue;
                        }
                    }
                    // Not a resize message — forward as data
                    if let Some(tx) = get_write_tx(&state_clone).await {
                        if tx.send(text.as_bytes().to_vec()).await.is_err() {
                            tracing::error!("Failed to send data to serial writer");
                            break;
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    // Wait for either task to finish, then abort the other
    tokio::select! {
        _ = &mut send_task => {
            recv_task.abort();
        }
        _ = &mut recv_task => {
            send_task.abort();
        }
    }

    tracing::info!("WebSocket connection closed");
}

// ---------------------------------------------------------------------------
// ZMODEM REST handlers
// ---------------------------------------------------------------------------

async fn zmodem_list_files(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let files = state.zmodem_files.lock().await;
    let names: Vec<String> = files
        .iter()
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
        .collect();
    Json(serde_json::json!({ "files": names }))
}

async fn zmodem_download_file(
    State(state): State<Arc<AppState>>,
    AxumPath(filename): AxumPath<String>,
) -> impl IntoResponse {
    let files = state.zmodem_files.lock().await;
    let found = files.iter().find(|p| {
        p.file_name()
            .map(|n| n.to_string_lossy() == filename)
            .unwrap_or(false)
    });
    match found {
        Some(path) => match tokio::fs::read(path).await {
            Ok(data) => (
                StatusCode::OK,
                [
                    (
                        axum::http::header::CONTENT_TYPE,
                        "application/octet-stream".to_string(),
                    ),
                    (
                        axum::http::header::CONTENT_DISPOSITION,
                        format!("attachment; filename=\"{}\"", filename),
                    ),
                ],
                data,
            )
                .into_response(),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse {
                    ok: false,
                    message: format!("Failed to read file: {}", e),
                }),
            )
                .into_response(),
        },
        None => (
            StatusCode::NOT_FOUND,
            Json(ApiResponse {
                ok: false,
                message: "File not found".to_string(),
            }),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// ZMODEM interceptor task
// ---------------------------------------------------------------------------

/// Spawn a task that subscribes to the broadcast channel, detects ZMODEM
/// init sequences, and handles the transfer using a pure Rust ZMODEM receiver.
/// During ZMODEM mode, data is routed to the receiver instead of WebSocket clients.
/// Receiver responses are sent back through the write channel.
fn spawn_zmodem_interceptor(state: Arc<AppState>) {
    let mut broadcast_rx = state.broadcast_tx.subscribe();
    let state = state.clone();

    tokio::spawn(async move {
        loop {
            let data = match broadcast_rx.recv().await {
                Ok(data) => data,
                Err(broadcast::error::RecvError::Closed) => break,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
            };

            // Only scan when not already in ZMODEM mode
            if state.zmodem_active.load(Ordering::Relaxed) {
                continue;
            }

            if !zmodem::detect_zmodem(&data) {
                continue;
            }

            tracing::info!("ZMODEM init sequence detected, starting receive");

            // Save to ~/Downloads
            let download_dir = dirs::download_dir()
                .unwrap_or_else(|| PathBuf::from("/tmp"));
            // Create the pure Rust ZMODEM receiver
            let mut receiver = zmodem::ZmodemReceiver::new(download_dir);

            // Set up an mpsc channel for routing data to the ZMODEM handler
            let (zmodem_tx, mut zmodem_rx) = mpsc::channel::<Vec<u8>>(256);

            // Activate ZMODEM mode
            state.zmodem_active.store(true, Ordering::SeqCst);
            *state.zmodem_data_tx_shared.lock().await = Some(zmodem_tx);

            // Notify clients that ZMODEM started
            let _ = state.broadcast_tx.send(
                format!(
                    "\x1b]zmodem;{}\x07",
                    serde_json::json!({"type":"zmodem","state":"started"})
                )
                .into_bytes(),
            );

            // Get write channel for sending responses back to serial/SSH
            let write_tx = {
                let conn = state.connection.lock().await;
                match conn.as_ref() {
                    Some(ConnectionKind::Serial(c)) => Some(c.tx_to_serial.clone()),
                    Some(ConnectionKind::Ssh(c)) => Some(c.tx_to_ssh.clone()),
                    None => None,
                }
            };

            // Feed initial ZMODEM data to the receiver
            tracing::info!("ZMODEM: feeding initial {} bytes to receiver", data.len());
            let response = receiver.process(&data);
            tracing::info!("ZMODEM: initial response {} bytes", response.len());
            if !response.is_empty() {
                if let Some(ref tx) = write_tx {
                    match tx.send(response).await {
                        Ok(_) => tracing::info!("ZMODEM: initial response sent to write channel"),
                        Err(e) => tracing::error!("ZMODEM: failed to send initial response: {}", e),
                    }
                } else {
                    tracing::error!("ZMODEM: no write_tx available!");
                }
            }

            tracing::info!("ZMODEM: entering receive loop, waiting for data on zmodem_rx");

            // Process incoming data through the receiver
            let mut last_progress_time = std::time::Instant::now();
            while let Some(incoming) = zmodem_rx.recv().await {
                let response = receiver.process(&incoming);
                if !response.is_empty() {
                    if let Some(ref tx) = write_tx {
                        if let Err(e) = tx.send(response).await {
                            tracing::error!("ZMODEM: write_tx send failed: {}", e);
                            break;
                        }
                    }
                }

                // Send progress update every 200ms
                if last_progress_time.elapsed() >= std::time::Duration::from_millis(200) {
                    last_progress_time = std::time::Instant::now();
                    if let Some(filename) = receiver.current_filename() {
                        let _ = state.broadcast_tx.send(
                            format!(
                                "\x1b]zmodem;{}\x07",
                                serde_json::json!({
                                    "type": "zmodem",
                                    "state": "progress",
                                    "filename": filename,
                                    "received": receiver.bytes_received(),
                                    "total": receiver.current_file_size()
                                })
                            )
                            .into_bytes(),
                        );
                    }
                }

                if receiver.is_done() {
                    break;
                }
            }

            // Collect received files
            let files: Vec<PathBuf> = receiver.received_files().to_vec();

            let file_names: Vec<String> = files
                .iter()
                .filter_map(|p| {
                    p.file_name().map(|n| n.to_string_lossy().to_string())
                })
                .collect();

            tracing::info!(
                "ZMODEM transfer complete, received {} files: {:?}",
                files.len(),
                file_names
            );

            // Store files
            *state.zmodem_files.lock().await = files;

            // Deactivate ZMODEM mode
            *state.zmodem_data_tx_shared.lock().await = None;
            state.zmodem_active.store(false, Ordering::SeqCst);

            // Notify clients
            let _ = state.broadcast_tx.send(
                format!(
                    "\x1b]zmodem;{}\x07",
                    serde_json::json!({
                        "type": "zmodem",
                        "state": "completed",
                        "files": file_names
                    })
                )
                .into_bytes(),
            );
        }
    });
}

// ---------------------------------------------------------------------------
// Embedded static file handler
// ---------------------------------------------------------------------------

async fn static_handler(uri: axum::http::Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match Assets::get(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            (
                StatusCode::OK,
                [(axum::http::header::CONTENT_TYPE, mime.as_ref())],
                file.data,
            )
                .into_response()
        }
        None => {
            // Fallback to index.html for SPA-like behavior
            match Assets::get("index.html") {
                Some(file) => (
                    StatusCode::OK,
                    [(axum::http::header::CONTENT_TYPE, "text/html")],
                    file.data,
                )
                    .into_response(),
                None => (StatusCode::NOT_FOUND, "Not Found").into_response(),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Axum server
// ---------------------------------------------------------------------------

async fn start_axum_server() {
    let (broadcast_tx, _) = broadcast::channel::<Vec<u8>>(1024);

    let state = Arc::new(AppState {
        connection: Mutex::new(None),
        broadcast_tx,
        scrollback: Arc::new(Mutex::new(VecDeque::new())),
        zmodem_active: Arc::new(AtomicBool::new(false)),
        zmodem_data_tx_shared: Arc::new(Mutex::new(None)),
        zmodem_files: Mutex::new(Vec::new()),
    });

    // Spawn ZMODEM interceptor that monitors broadcast for ZMODEM init sequences
    spawn_zmodem_interceptor(state.clone());

    let cors = CorsLayer::very_permissive();

    let app = Router::new()
        .route("/api/ports", get(list_ports))
        .route("/api/connect", post(connect))
        .route("/api/disconnect", post(disconnect))
        .route("/api/ssh/connect", post(ssh_connect))
        .route("/api/status", get(status))
        .route("/ws", get(ws_handler))
        .route("/api/zmodem/files", get(zmodem_list_files))
        .route("/api/zmodem/download/{filename}", get(zmodem_download_file))
        .with_state(state.clone())
        .fallback(static_handler)
        .layer(cors);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000")
        .await
        .expect("Failed to bind to 127.0.0.1:3000");

    tracing::info!("Axum server listening on http://127.0.0.1:3000");

    axum::serve(listener, app)
        .await
        .expect("Server error");
}

// ---------------------------------------------------------------------------
// Tauri entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter("serial_rs_lib=debug,info")
        .init();

    // Disable macOS "press and hold" accent menu so held keys repeat instead
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSString, NSUserDefaults};
        let defaults = NSUserDefaults::standardUserDefaults();
        let key = NSString::from_str("ApplePressAndHoldEnabled");
        defaults.setBool_forKey(false, &key);
    }

    tauri::Builder::default()
        .setup(|app| {
            // Native macOS menu bar
            let app_menu = Submenu::with_items(
                app,
                "Serial Terminal",
                true,
                &[
                    &PredefinedMenuItem::about(app, Some("About Serial Terminal"), None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, Some("Quit Serial Terminal"))?,
                ],
            )?;

            let edit_menu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;

            let window_menu = Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?;

            let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])?;
            app.set_menu(menu)?;

            // Spawn the Axum server as a background task
            tauri::async_runtime::spawn(async move {
                start_axum_server().await;
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
