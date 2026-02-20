use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
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
use tokio_serial::SerialPortBuilderExt;
use tower_http::services::ServeDir;

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
struct StatusResponse {
    connected: bool,
    port: Option<String>,
    config: Option<PortConfig>,
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

struct AppState {
    serial_connection: Mutex<Option<SerialConnection>>,
    // Keep a persistent broadcast sender so WebSocket clients can subscribe
    // even before a serial connection exists. Data only flows when connected.
    broadcast_tx: broadcast::Sender<Vec<u8>>,
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
    let mut conn = state.serial_connection.lock().await;

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

    // Reader task: serial -> broadcast
    let bc_tx = broadcast_tx.clone();
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
                    // Ignore send error (no receivers is okay)
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
    *conn = Some(SerialConnection {
        port_name: port_name.clone(),
        config,
        tx_to_serial,
        reader_handle,
        writer_handle,
    });

    (
        StatusCode::OK,
        Json(ApiResponse {
            ok: true,
            message: format!("Connected to {}", port_name),
        }),
    )
}

async fn disconnect(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let mut conn = state.serial_connection.lock().await;

    match conn.take() {
        Some(c) => {
            tracing::info!("Disconnecting from {}", c.port_name);
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
        None => (
            StatusCode::OK,
            Json(ApiResponse {
                ok: true,
                message: "Not connected".to_string(),
            }),
        ),
    }
}

async fn status(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let conn = state.serial_connection.lock().await;
    match conn.as_ref() {
        Some(c) => Json(StatusResponse {
            connected: true,
            port: Some(c.port_name.clone()),
            config: Some(c.config.clone()),
        }),
        None => Json(StatusResponse {
            connected: false,
            port: None,
            config: None,
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

    // Subscribe to broadcast for serial RX data
    let mut broadcast_rx = state.broadcast_tx.subscribe();

    // Get a clone of the mpsc sender for writing to serial (if connected)
    let get_serial_tx = |state: &Arc<AppState>| {
        let state = state.clone();
        async move {
            let conn = state.serial_connection.lock().await;
            conn.as_ref().map(|c| c.tx_to_serial.clone())
        }
    };

    // Task A: broadcast (serial RX) -> WebSocket
    let mut send_task = tokio::spawn(async move {
        loop {
            match broadcast_rx.recv().await {
                Ok(data) => {
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

    // Task B: WebSocket -> serial TX (via mpsc)
    let state_clone = state.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_rx.next().await {
            match msg {
                Message::Binary(data) => {
                    if let Some(tx) = get_serial_tx(&state_clone).await {
                        if tx.send(data.to_vec()).await.is_err() {
                            tracing::error!("Failed to send data to serial writer");
                            break;
                        }
                    }
                }
                Message::Text(text) => {
                    // Also support text frames (terminal may send text)
                    if let Some(tx) = get_serial_tx(&state_clone).await {
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
// Main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let (broadcast_tx, _) = broadcast::channel::<Vec<u8>>(1024);

    let state = Arc::new(AppState {
        serial_connection: Mutex::new(None),
        broadcast_tx,
    });

    let app = Router::new()
        .route("/api/ports", get(list_ports))
        .route("/api/connect", post(connect))
        .route("/api/disconnect", post(disconnect))
        .route("/api/status", get(status))
        .route("/ws", get(ws_handler))
        .with_state(state)
        .fallback_service(ServeDir::new("frontend"));

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
        .await
        .expect("Failed to bind to 0.0.0.0:3000");

    tracing::info!("Server listening on http://0.0.0.0:3000");

    axum::serve(listener, app)
        .await
        .expect("Server error");
}
