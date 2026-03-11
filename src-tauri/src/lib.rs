mod ssh;
#[allow(dead_code)]
mod zmodem;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path as AxumPath, Query, State, WebSocketUpgrade,
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
use tower_http::services::ServeDir;

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
    flow_control: Option<String>,
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

#[derive(Serialize)]
struct TabStatusEntry {
    tab_id: String,
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

/// Per-tab connection state
struct ConnectionState {
    connection: ConnectionKind,
    broadcast_tx: broadcast::Sender<Vec<u8>>,
    scrollback: Arc<Mutex<VecDeque<u8>>>,
    zmodem_active: Arc<AtomicBool>,
    zmodem_data_tx_shared: Arc<Mutex<Option<mpsc::Sender<Vec<u8>>>>>,
    zmodem_files: Vec<PathBuf>,
    log_file: Option<(String, tokio::fs::File)>,
}

struct AppState {
    connections: Mutex<HashMap<String, ConnectionState>>,
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

fn to_flow_control(fc: &str) -> tokio_serial::FlowControl {
    match fc {
        "software" => tokio_serial::FlowControl::Software,
        "hardware" => tokio_serial::FlowControl::Hardware,
        _ => tokio_serial::FlowControl::None,
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

#[derive(Deserialize)]
struct ConnectRequest {
    tab_id: String,
    #[serde(flatten)]
    config: PortConfig,
}

async fn connect(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ConnectRequest>,
) -> impl IntoResponse {
    let tab_id = req.tab_id;
    let config = req.config;

    let mut connections = state.connections.lock().await;

    if connections.contains_key(&tab_id) {
        return (
            StatusCode::CONFLICT,
            Json(ApiResponse {
                ok: false,
                message: "Tab already has an active connection. Disconnect first.".to_string(),
            }),
        );
    }

    let flow_control_str = config.flow_control.as_deref().unwrap_or("none");
    let builder = tokio_serial::new(&config.port, config.baud_rate)
        .data_bits(to_data_bits(config.data_bits))
        .stop_bits(to_stop_bits(config.stop_bits))
        .parity(to_parity(&config.parity))
        .flow_control(to_flow_control(flow_control_str));

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

    tracing::info!("Opened serial port {} at {} baud (tab {})", config.port, config.baud_rate, tab_id);

    let (mut reader, mut writer) = tokio::io::split(serial_port);

    // Channel: WebSocket clients -> serial writer
    let (tx_to_serial, mut rx_from_ws) = mpsc::channel::<Vec<u8>>(256);

    // Per-tab broadcast channel
    let (broadcast_tx, _) = broadcast::channel::<Vec<u8>>(1024);
    let scrollback = Arc::new(Mutex::new(VecDeque::new()));
    let zmodem_active = Arc::new(AtomicBool::new(false));
    let zmodem_data_tx_shared: Arc<Mutex<Option<mpsc::Sender<Vec<u8>>>>> =
        Arc::new(Mutex::new(None));

    // Reader task: serial -> broadcast + scrollback (with ZMODEM intercept)
    let bc_tx = broadcast_tx.clone();
    let scrollback_clone = scrollback.clone();
    let zmodem_active_clone = zmodem_active.clone();
    let zmodem_data_tx_clone = zmodem_data_tx_shared.clone();
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
                    if zmodem_active_clone.load(Ordering::Relaxed) {
                        let tx = zmodem_data_tx_clone.lock().await;
                        if let Some(ref zmodem_tx) = *tx {
                            let _ = zmodem_tx.send(data).await;
                        }
                        continue;
                    }

                    // Normal path: append to scrollback and broadcast
                    {
                        let mut sb = scrollback_clone.lock().await;
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

    // Spawn ZMODEM interceptor for this tab
    spawn_zmodem_interceptor_for_tab(
        tab_id.clone(),
        broadcast_tx.clone(),
        zmodem_active.clone(),
        zmodem_data_tx_shared.clone(),
        state.clone(),
    );

    connections.insert(tab_id.clone(), ConnectionState {
        connection: ConnectionKind::Serial(SerialConnection {
            port_name: port_name.clone(),
            config,
            tx_to_serial,
            reader_handle,
            writer_handle,
        }),
        broadcast_tx,
        scrollback,
        zmodem_active,
        zmodem_data_tx_shared,
        zmodem_files: Vec::new(),
        log_file: None,
    });

    (
        StatusCode::OK,
        Json(ApiResponse {
            ok: true,
            message: format!("Connected to {}", port_name),
        }),
    )
}

#[derive(Deserialize)]
struct DisconnectRequest {
    tab_id: String,
}

async fn disconnect(
    State(state): State<Arc<AppState>>,
    Json(req): Json<DisconnectRequest>,
) -> impl IntoResponse {
    let mut connections = state.connections.lock().await;

    match connections.remove(&req.tab_id) {
        Some(conn_state) => {
            match conn_state.connection {
                ConnectionKind::Serial(c) => {
                    tracing::info!("Disconnecting from serial {} (tab {})", c.port_name, req.tab_id);
                    c.reader_handle.abort();
                    c.writer_handle.abort();
                    (
                        StatusCode::OK,
                        Json(ApiResponse {
                            ok: true,
                            message: format!("Disconnected from {}", c.port_name),
                        }),
                    )
                }
                ConnectionKind::Ssh(c) => {
                    let host = c.config.host.clone();
                    tracing::info!("Disconnecting from SSH {} (tab {})", host, req.tab_id);
                    c.disconnect().await;
                    (
                        StatusCode::OK,
                        Json(ApiResponse {
                            ok: true,
                            message: format!("Disconnected from SSH {}", host),
                        }),
                    )
                }
            }
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

#[derive(Deserialize)]
struct SshConnectRequest {
    tab_id: String,
    #[serde(flatten)]
    config: ssh::SshConfig,
}

async fn ssh_connect(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SshConnectRequest>,
) -> impl IntoResponse {
    let tab_id = req.tab_id;
    let config = req.config;

    let mut connections = state.connections.lock().await;

    if connections.contains_key(&tab_id) {
        return (
            StatusCode::CONFLICT,
            Json(ApiResponse {
                ok: false,
                message: "Tab already has an active connection. Disconnect first.".to_string(),
            }),
        );
    }

    let host = format!("{}:{}", config.host, config.port);

    // Per-tab broadcast channel
    let (broadcast_tx, _) = broadcast::channel::<Vec<u8>>(1024);
    let scrollback = Arc::new(Mutex::new(VecDeque::new()));
    let zmodem_active = Arc::new(AtomicBool::new(false));
    let zmodem_data_tx_shared: Arc<Mutex<Option<mpsc::Sender<Vec<u8>>>>> =
        Arc::new(Mutex::new(None));

    match ssh::SshConnection::connect(
        config,
        broadcast_tx.clone(),
        scrollback.clone(),
        SCROLLBACK_MAX,
        zmodem_active.clone(),
        zmodem_data_tx_shared.clone(),
    )
    .await
    {
        Ok(ssh_conn) => {
            // Spawn ZMODEM interceptor for this tab
            spawn_zmodem_interceptor_for_tab(
                tab_id.clone(),
                broadcast_tx.clone(),
                zmodem_active.clone(),
                zmodem_data_tx_shared.clone(),
                state.clone(),
            );

            connections.insert(tab_id.clone(), ConnectionState {
                connection: ConnectionKind::Ssh(ssh_conn),
                broadcast_tx,
                scrollback,
                zmodem_active,
                zmodem_data_tx_shared,
                zmodem_files: Vec::new(),
                log_file: None,
            });
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

#[derive(Deserialize)]
struct TabIdQuery {
    tab_id: Option<String>,
}

async fn status(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TabIdQuery>,
) -> impl IntoResponse {
    let connections = state.connections.lock().await;

    if let Some(tab_id) = query.tab_id {
        // Return status for a specific tab
        match connections.get(&tab_id) {
            Some(conn_state) => {
                match &conn_state.connection {
                    ConnectionKind::Serial(c) => Json(StatusResponse {
                        connected: true,
                        connection_type: Some("serial".to_string()),
                        port: Some(c.port_name.clone()),
                        config: Some(c.config.clone()),
                        ssh_config: None,
                    }).into_response(),
                    ConnectionKind::Ssh(c) => Json(StatusResponse {
                        connected: true,
                        connection_type: Some("ssh".to_string()),
                        port: Some(format!("ssh://{}:{}", c.config.host, c.config.port)),
                        config: None,
                        ssh_config: Some(SshStatusConfig {
                            host: c.config.host.clone(),
                            port: c.config.port,
                            username: c.config.username.clone(),
                        }),
                    }).into_response(),
                }
            }
            None => Json(StatusResponse {
                connected: false,
                connection_type: None,
                port: None,
                config: None,
                ssh_config: None,
            }).into_response(),
        }
    } else {
        // Return status for all tabs
        let mut entries: Vec<TabStatusEntry> = Vec::new();
        for (tab_id, conn_state) in connections.iter() {
            match &conn_state.connection {
                ConnectionKind::Serial(c) => entries.push(TabStatusEntry {
                    tab_id: tab_id.clone(),
                    connected: true,
                    connection_type: Some("serial".to_string()),
                    port: Some(c.port_name.clone()),
                    config: Some(c.config.clone()),
                    ssh_config: None,
                }),
                ConnectionKind::Ssh(c) => entries.push(TabStatusEntry {
                    tab_id: tab_id.clone(),
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
            }
        }
        Json(entries).into_response()
    }
}

// ---------------------------------------------------------------------------
// WebSocket handler
// ---------------------------------------------------------------------------

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(query): Query<TabIdQuery>,
) -> impl IntoResponse {
    let tab_id = query.tab_id.unwrap_or_default();
    ws.on_upgrade(move |socket| handle_ws(socket, state, tab_id))
}

async fn handle_ws(socket: WebSocket, state: Arc<AppState>, tab_id: String) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Get broadcast_tx and scrollback for this tab
    let (broadcast_tx, scrollback, zmodem_active, log_file_for_send) = {
        let connections = state.connections.lock().await;
        match connections.get(&tab_id) {
            Some(conn_state) => (
                conn_state.broadcast_tx.clone(),
                conn_state.scrollback.clone(),
                conn_state.zmodem_active.clone(),
                // We cannot hold a reference to log_file across await, so we skip it here
                // and handle logging via state lookup in the send task
                (),
            ),
            None => {
                tracing::warn!("WebSocket connected for unknown tab_id: {}", tab_id);
                let _ = ws_tx.send(Message::Close(None)).await;
                return;
            }
        }
    };

    // Send scrollback buffer first so client sees previous output
    {
        let sb = scrollback.lock().await;
        if !sb.is_empty() {
            let data: Vec<u8> = sb.iter().copied().collect();
            if ws_tx.send(Message::Binary(data.into())).await.is_err() {
                return;
            }
        }
    }

    // Subscribe to broadcast for serial RX data
    let mut broadcast_rx = broadcast_tx.subscribe();

    // Get a clone of the mpsc sender for writing (serial or SSH)
    let get_write_tx = |state: &Arc<AppState>, tab_id: &str| {
        let state = state.clone();
        let tab_id = tab_id.to_string();
        async move {
            let connections = state.connections.lock().await;
            match connections.get(&tab_id) {
                Some(conn_state) => match &conn_state.connection {
                    ConnectionKind::Serial(c) => Some(c.tx_to_serial.clone()),
                    ConnectionKind::Ssh(c) => Some(c.tx_to_ssh.clone()),
                },
                None => None,
            }
        }
    };

    // Get the resize sender for SSH connections
    let get_resize_tx = |state: &Arc<AppState>, tab_id: &str| {
        let state = state.clone();
        let tab_id = tab_id.to_string();
        async move {
            let connections = state.connections.lock().await;
            match connections.get(&tab_id) {
                Some(conn_state) => match &conn_state.connection {
                    ConnectionKind::Ssh(c) => Some(c.resize_tx.clone()),
                    _ => None,
                },
                None => None,
            }
        }
    };

    let _ = log_file_for_send;

    // Task A: broadcast (serial RX) -> WebSocket (with ZMODEM filtering)
    let zmodem_active_for_send = zmodem_active.clone();
    let state_for_log = state.clone();
    let tab_id_for_log = tab_id.clone();
    let mut send_task = tokio::spawn(async move {
        loop {
            match broadcast_rx.recv().await {
                Ok(data) => {
                    // Always intercept ZMODEM notifications (sent as Text frames)
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
                    // Write raw data to log file if logging is active
                    {
                        let mut connections = state_for_log.connections.lock().await;
                        if let Some(conn_state) = connections.get_mut(&tab_id_for_log) {
                            if let Some((_, ref mut file)) = conn_state.log_file {
                                let _ = file.write_all(&data).await;
                            }
                        }
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
    let tab_id_clone = tab_id.clone();
    let zmodem_active_for_recv = zmodem_active.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_rx.next().await {
            match msg {
                Message::Binary(data) => {
                    // Block user input during ZMODEM transfer
                    if zmodem_active_for_recv.load(Ordering::Relaxed) {
                        continue;
                    }
                    if let Some(tx) = get_write_tx(&state_clone, &tab_id_clone).await {
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
                                if let Some(resize_tx) = get_resize_tx(&state_clone, &tab_id_clone).await {
                                    let _ = resize_tx.send((cols as u32, rows as u32)).await;
                                }
                            }
                            continue;
                        }
                    }
                    // Not a resize message — forward as data
                    if let Some(tx) = get_write_tx(&state_clone, &tab_id_clone).await {
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

    tracing::info!("WebSocket connection closed (tab {})", tab_id);
}

// ---------------------------------------------------------------------------
// ZMODEM REST handlers
// ---------------------------------------------------------------------------

async fn zmodem_list_files(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TabIdQuery>,
) -> impl IntoResponse {
    let connections = state.connections.lock().await;
    let tab_id = query.tab_id.unwrap_or_default();
    let names: Vec<String> = match connections.get(&tab_id) {
        Some(conn_state) => conn_state.zmodem_files
            .iter()
            .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
            .collect(),
        None => Vec::new(),
    };
    Json(serde_json::json!({ "files": names }))
}

async fn zmodem_download_file(
    State(state): State<Arc<AppState>>,
    AxumPath(filename): AxumPath<String>,
    Query(query): Query<TabIdQuery>,
) -> impl IntoResponse {
    let connections = state.connections.lock().await;
    let tab_id = query.tab_id.unwrap_or_default();
    let found_path = connections.get(&tab_id).and_then(|conn_state| {
        conn_state.zmodem_files.iter().find(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy() == filename)
                .unwrap_or(false)
        }).cloned()
    });
    drop(connections);

    match found_path {
        Some(path) => match tokio::fs::read(&path).await {
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
// Log REST handlers
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct LogStartRequest {
    tab_id: String,
    path: String,
}

#[derive(Serialize)]
struct LogStatusResponse {
    active: bool,
    path: Option<String>,
}

async fn log_start(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LogStartRequest>,
) -> impl IntoResponse {
    let mut connections = state.connections.lock().await;

    let conn_state = match connections.get_mut(&req.tab_id) {
        Some(cs) => cs,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ApiResponse {
                    ok: false,
                    message: "No connection for this tab".to_string(),
                }),
            );
        }
    };

    if conn_state.log_file.is_some() {
        return (
            StatusCode::CONFLICT,
            Json(ApiResponse {
                ok: false,
                message: "Logging already active".to_string(),
            }),
        );
    }

    // Expand ~ to home directory
    let path = if req.path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            home.join(&req.path[2..]).to_string_lossy().to_string()
        } else {
            req.path.clone()
        }
    } else {
        req.path.clone()
    };

    match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await
    {
        Ok(file) => {
            tracing::info!("Started logging to {} (tab {})", path, req.tab_id);
            conn_state.log_file = Some((path.clone(), file));
            (
                StatusCode::OK,
                Json(ApiResponse {
                    ok: true,
                    message: format!("Logging to {}", path),
                }),
            )
        }
        Err(e) => {
            tracing::error!("Failed to open log file {}: {}", path, e);
            (
                StatusCode::BAD_REQUEST,
                Json(ApiResponse {
                    ok: false,
                    message: format!("Failed to open file: {}", e),
                }),
            )
        }
    }
}

#[derive(Deserialize)]
struct LogStopRequest {
    tab_id: String,
}

async fn log_stop(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LogStopRequest>,
) -> impl IntoResponse {
    let mut connections = state.connections.lock().await;

    let conn_state = match connections.get_mut(&req.tab_id) {
        Some(cs) => cs,
        None => {
            return (
                StatusCode::OK,
                Json(ApiResponse {
                    ok: true,
                    message: "Not logging".to_string(),
                }),
            );
        }
    };

    match conn_state.log_file.take() {
        Some((path, _file)) => {
            tracing::info!("Stopped logging to {} (tab {})", path, req.tab_id);
            (
                StatusCode::OK,
                Json(ApiResponse {
                    ok: true,
                    message: format!("Stopped logging to {}", path),
                }),
            )
        }
        None => (
            StatusCode::OK,
            Json(ApiResponse {
                ok: true,
                message: "Not logging".to_string(),
            }),
        ),
    }
}

async fn log_status(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TabIdQuery>,
) -> impl IntoResponse {
    let connections = state.connections.lock().await;
    let tab_id = query.tab_id.unwrap_or_default();

    match connections.get(&tab_id) {
        Some(conn_state) => match &conn_state.log_file {
            Some((path, _)) => Json(LogStatusResponse {
                active: true,
                path: Some(path.clone()),
            }),
            None => Json(LogStatusResponse {
                active: false,
                path: None,
            }),
        },
        None => Json(LogStatusResponse {
            active: false,
            path: None,
        }),
    }
}

// ---------------------------------------------------------------------------
// ZMODEM interceptor task (per-tab)
// ---------------------------------------------------------------------------

/// Spawn a task that subscribes to the tab's broadcast channel, detects ZMODEM
/// init sequences, and handles the transfer using a pure Rust ZMODEM receiver.
fn spawn_zmodem_interceptor_for_tab(
    tab_id: String,
    broadcast_tx: broadcast::Sender<Vec<u8>>,
    zmodem_active: Arc<AtomicBool>,
    zmodem_data_tx_shared: Arc<Mutex<Option<mpsc::Sender<Vec<u8>>>>>,
    state: Arc<AppState>,
) {
    let mut broadcast_rx = broadcast_tx.subscribe();

    tokio::spawn(async move {
        loop {
            let data = match broadcast_rx.recv().await {
                Ok(data) => data,
                Err(broadcast::error::RecvError::Closed) => break,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
            };

            // Only scan when not already in ZMODEM mode
            if zmodem_active.load(Ordering::Relaxed) {
                continue;
            }

            if !zmodem::detect_zmodem(&data) {
                continue;
            }

            tracing::info!("ZMODEM init sequence detected (tab {}), starting receive", tab_id);

            // Save to ~/Downloads
            let download_dir = dirs::download_dir()
                .unwrap_or_else(|| PathBuf::from("/tmp"));
            let mut receiver = zmodem::ZmodemReceiver::new(download_dir);

            // Set up an mpsc channel for routing data to the ZMODEM handler
            let (zmodem_tx, mut zmodem_rx) = mpsc::channel::<Vec<u8>>(256);

            // Activate ZMODEM mode
            zmodem_active.store(true, Ordering::SeqCst);
            *zmodem_data_tx_shared.lock().await = Some(zmodem_tx);

            // Notify clients that ZMODEM started
            let _ = broadcast_tx.send(
                format!(
                    "\x1b]zmodem;{}\x07",
                    serde_json::json!({"type":"zmodem","state":"started"})
                )
                .into_bytes(),
            );

            // Get write channel for sending responses back to serial/SSH
            let write_tx = {
                let connections = state.connections.lock().await;
                match connections.get(&tab_id) {
                    Some(conn_state) => match &conn_state.connection {
                        ConnectionKind::Serial(c) => Some(c.tx_to_serial.clone()),
                        ConnectionKind::Ssh(c) => Some(c.tx_to_ssh.clone()),
                    },
                    None => None,
                }
            };

            // Feed initial ZMODEM data to the receiver
            tracing::info!("ZMODEM: feeding initial {} bytes to receiver (tab {})", data.len(), tab_id);
            let response = receiver.process(&data);
            tracing::info!("ZMODEM: initial response {} bytes (tab {})", response.len(), tab_id);
            if !response.is_empty() {
                if let Some(ref tx) = write_tx {
                    match tx.send(response).await {
                        Ok(_) => tracing::info!("ZMODEM: initial response sent to write channel (tab {})", tab_id),
                        Err(e) => tracing::error!("ZMODEM: failed to send initial response (tab {}): {}", tab_id, e),
                    }
                } else {
                    tracing::error!("ZMODEM: no write_tx available (tab {})!", tab_id);
                }
            }

            tracing::info!("ZMODEM: entering receive loop (tab {})", tab_id);

            // Process incoming data through the receiver
            let transfer_start = std::time::Instant::now();
            let mut file_start = std::time::Instant::now();
            let mut last_progress_time = std::time::Instant::now();
            while let Some(incoming) = zmodem_rx.recv().await {
                let response = receiver.process(&incoming);
                if !response.is_empty() {
                    if let Some(ref tx) = write_tx {
                        if let Err(e) = tx.send(response).await {
                            tracing::error!("ZMODEM: write_tx send failed (tab {}): {}", tab_id, e);
                            break;
                        }
                    }
                }

                // Check if a file just completed
                if let Some(completed) = receiver.take_completed() {
                    let file_elapsed = file_start.elapsed().as_millis() as u64;
                    let _ = broadcast_tx.send(
                        format!(
                            "\x1b]zmodem;{}\x07",
                            serde_json::json!({
                                "type": "zmodem",
                                "state": "file_complete",
                                "filename": completed.filename,
                                "size": completed.size,
                                "elapsedMs": file_elapsed
                            })
                        )
                        .into_bytes(),
                    );
                    file_start = std::time::Instant::now();
                }

                // Send progress update every 200ms
                if last_progress_time.elapsed() >= std::time::Duration::from_millis(200) {
                    last_progress_time = std::time::Instant::now();
                    if let Some(filename) = receiver.current_filename() {
                        let _ = broadcast_tx.send(
                            format!(
                                "\x1b]zmodem;{}\x07",
                                serde_json::json!({
                                    "type": "zmodem",
                                    "state": "progress",
                                    "filename": filename,
                                    "received": receiver.current_bytes(),
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
                "ZMODEM transfer complete (tab {}), received {} files: {:?}",
                tab_id,
                files.len(),
                file_names
            );

            // Store files in the tab's connection state
            {
                let mut connections = state.connections.lock().await;
                if let Some(conn_state) = connections.get_mut(&tab_id) {
                    conn_state.zmodem_files = files;
                }
            }

            // Deactivate ZMODEM mode
            *zmodem_data_tx_shared.lock().await = None;
            zmodem_active.store(false, Ordering::SeqCst);

            // Compute transfer stats
            let elapsed_ms = transfer_start.elapsed().as_millis() as u64;
            let total_bytes: u64 = receiver.total_bytes();

            // Notify clients
            let _ = broadcast_tx.send(
                format!(
                    "\x1b]zmodem;{}\x07",
                    serde_json::json!({
                        "type": "zmodem",
                        "state": "completed",
                        "files": file_names,
                        "totalBytes": total_bytes,
                        "elapsedMs": elapsed_ms
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
    let state = Arc::new(AppState {
        connections: Mutex::new(HashMap::new()),
    });

    let cors = CorsLayer::very_permissive();

    let api = Router::new()
        .route("/api/ports", get(list_ports))
        .route("/api/connect", post(connect))
        .route("/api/disconnect", post(disconnect))
        .route("/api/ssh/connect", post(ssh_connect))
        .route("/api/status", get(status))
        .route("/ws", get(ws_handler))
        .route("/api/zmodem/files", get(zmodem_list_files))
        .route("/api/zmodem/download/{filename}", get(zmodem_download_file))
        .route("/api/log/start", post(log_start))
        .route("/api/log/stop", post(log_stop))
        .route("/api/log/status", get(log_status))
        .with_state(state.clone());

    // In debug mode, serve frontend files from disk (no restart needed for UI changes).
    // In release mode, use embedded assets.
    let app = if cfg!(debug_assertions) {
        let frontend_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../frontend");
        tracing::info!("Serving frontend from disk: {}", frontend_dir.display());
        api.fallback_service(ServeDir::new(frontend_dir))
    } else {
        api.fallback(static_handler)
    }
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
