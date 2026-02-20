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
- **[Leader]** UI 개선 및 버그 수정:
  - xterm 터미널 오버플로우 수정 (min-height:0, overflow:hidden)
  - 네이비 다크 컬러 스킴 (#1a1a2e, #16213e, #0f3460, #e94560)
  - 툴바 그룹화 (Port / Baud / Config) + 라벨 + 구분선
  - 상태 LED 점 + 연결 시 glow 효과
  - 브라우저 새로고침 시 자동 재연결 (GET /api/status 확인 후 WebSocket 복원)
  - 하단 상태바 추가 (macOS Tahoe 둥근 모서리 클리핑 대응)
  - 스크롤백 링 버퍼 128KB (새로고침 시 이전 터미널 출력 복원)
  - rust-embed로 프론트엔드를 바이너리에 임베드 (2.5MB standalone)
- **[Team]** Tauri v2 데스크톱 앱 전환 완료 (방법 A: Axum+WebSocket 유지):
  - `src-tauri/` 디렉토리 구조 생성 (Cargo.toml, build.rs, tauri.conf.json, capabilities)
  - 기존 `src/main.rs` 코드를 `src-tauri/src/lib.rs`로 이전
  - Axum 서버를 Tauri `.setup()` hook에서 background task로 실행
  - Tauri WebView가 `http://localhost:3000`을 로드하여 기존 프론트엔드 표시
  - rust-embed 경로를 `../frontend/`로 조정
  - 서버 바인딩을 `127.0.0.1:3000`으로 변경 (localhost only)
  - 워크스페이스 구조로 전환 (root Cargo.toml → workspace)
  - `cargo tauri dev` 실행 검증 완료 (네이티브 창에서 시리얼 터미널 정상 동작)
  - placeholder 아이콘 생성 (32x32, 128x128, 128x128@2x, icns, ico)
- **[Team]** Phase 5 마무리:
  - 앱 아이콘 생성 (네이비 라운드 사각형 + ">_" 터미널 프롬프트 + coral 악센트, 모든 필수 사이즈)
  - macOS 네이티브 메뉴바 추가 (App: About/Quit, Edit: Copy/Paste/Select All, Window: Minimize/Close)
  - `cargo tauri build` 성공 → Serial Terminal.app (9.6MB), DMG (3.3MB)
  - Bundle identifier: `com.serialrs.terminal`
