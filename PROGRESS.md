# Development Progress

## Timeline

### 2026-02-20
- **[Leader]** 프로젝트 초기화, Git init, PLAN.md 작성
- **[Frontend]** Created frontend/ directory with three files:
  - `frontend/index.html` - Main HTML page with xterm.js CDN imports, toolbar with port/baud/databits/stopbits/parity selectors, connect button, status indicator, terminal container
  - `frontend/style.css` - Dark theme styling (background #1e1e1e), flexbox layout, toolbar with gap spacing, styled selects/buttons, terminal fills remaining viewport
  - `frontend/app.js` - Self-contained IIFE with: xterm.js Terminal + FitAddon initialization, port list fetching via /api/ports, connect/disconnect via /api/connect and /api/disconnect, WebSocket binary mode with AttachAddon for bidirectional serial data, UI state management (disable controls when connected), window resize handling
- **[Backend]** Implemented complete Rust backend in `src/main.rs`:
  - Data structures: `PortConfig`, `PortInfo`, `ApiResponse`, `StatusResponse` with serde serialization
  - App state with `Arc<AppState>` containing `tokio::sync::Mutex<Option<SerialConnection>>` and a `broadcast::Sender` for serial RX data
  - REST API endpoints: `GET /api/ports` (list serial ports via `serialport::available_ports()`), `POST /api/connect` (open serial port with tokio-serial, spawn reader/writer tasks), `POST /api/disconnect` (abort tasks, clean up), `GET /api/status` (connection status)
  - WebSocket handler at `/ws`: splits socket into sender/receiver, subscribes to broadcast channel for serial RX, sends WS data to serial via mpsc channel, uses `tokio::select!` for concurrent task management
  - Serial data flow architecture: broadcast channel for serial RX -> all WS clients, mpsc channel for WS TX -> serial writer
  - Static file serving from `frontend/` via `tower_http::services::ServeDir` as fallback
  - Server listens on `0.0.0.0:3000`
  - Builds successfully with zero warnings
