# Serial Terminal (serial-rs) - Agent Instructions

## Project Overview

Rust + Web UI 기반 시리얼/SSH 터미널 데스크톱 앱 (Tauri v2).

## Architecture

```
Browser (xterm.js) <──WebSocket(binary)──> Axum Backend <──tokio-serial──> Serial Port
                   <──REST(JSON)────────>              <──russh──────────> SSH Server
```

- **Backend**: `src-tauri/src/lib.rs` (메인), `src-tauri/src/ssh.rs` (SSH 모듈)
- **Frontend**: `frontend/index.html`, `frontend/app.js`, `frontend/style.css`
- **Desktop**: Tauri v2 (`src-tauri/tauri.conf.json`)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Shell | Tauri v2 |
| Backend | Rust, Axum 0.8, tokio |
| Serial | tokio-serial, serialport |
| SSH | russh 0.49, ssh-key 0.6 |
| Frontend | Vanilla JS, xterm.js 5.5.0 |
| Communication | WebSocket (binary) + REST API |

## Key Files

| File | Description |
|------|-------------|
| `src-tauri/Cargo.toml` | Rust 의존성 |
| `src-tauri/src/lib.rs` | Axum 서버, REST API, WebSocket, Tauri 진입점 (약 613줄) |
| `src-tauri/src/ssh.rs` | SSH 클라이언트 (russh 기반, SshConnection, SshConfig) |
| `src-tauri/src/main.rs` | main() → lib::run() |
| `frontend/index.html` | UI 레이아웃 (toolbar, terminal, statusbar, settings modal) |
| `frontend/app.js` | 프론트엔드 로직 (시리얼 연결/해제, WebSocket, xterm.js) |
| `frontend/style.css` | 네이비 다크 테마 스타일 |

## Backend Architecture

### AppState (lib.rs)

```rust
enum ConnectionKind {
    Serial(SerialConnection),
    Ssh(ssh::SshConnection),
}

struct AppState {
    connection: Mutex<Option<ConnectionKind>>,  // 현재 연결 (Serial 또는 SSH)
    broadcast_tx: broadcast::Sender<Vec<u8>>,   // 수신 데이터 브로드캐스트
    scrollback: Arc<Mutex<VecDeque<u8>>>,       // 128KB 스크롤백 버퍼
}
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ports` | 시리얼 포트 목록 |
| POST | `/api/connect` | 시리얼 포트 연결 |
| POST | `/api/ssh/connect` | SSH 연결 |
| POST | `/api/disconnect` | 연결 해제 (Serial/SSH 공용) |
| GET | `/api/status` | 연결 상태 |
| GET | `/ws` | WebSocket (binary, xterm.js attach) |

### Data Flow

1. **수신** (Serial/SSH → Client): 데이터 → `broadcast_tx` → WebSocket → xterm.js
2. **송신** (Client → Serial/SSH): xterm.js → WebSocket → `mpsc::Sender` → Serial/SSH write
3. **스크롤백**: 수신 데이터가 `scrollback` 버퍼에 누적 (128KB). 새 WebSocket 연결 시 전송.

### SSH Module (ssh.rs)

```rust
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
}

pub struct SshConnection {
    pub config: SshConfig,
    pub tx_to_ssh: mpsc::Sender<Vec<u8>>,   // WebSocket → SSH 쓰기 채널
    pub reader_handle: JoinHandle<()>,
    pub writer_handle: JoinHandle<()>,
    handle: Arc<Mutex<client::Handle<SshClientHandler>>>,
}
```

- `SshClientHandler`가 `client::Handler` 구현하여 수신 데이터를 `broadcast_tx`로 전달
- PTY (xterm-256color, 80x24) + shell 요청
- password 인증만 구현됨 (key auth는 TODO)

## Frontend Architecture

- IIFE 패턴 (`(function() { ... })()`)
- CDN에서 xterm.js, addon-attach, addon-fit 로드
- `localStorage`에 설정 저장 (`serial-rs-settings`)
- 현재 시리얼 전용 UI (SSH UI 미구현)

## Code Conventions

- Rust: 기본 `rustfmt` 스타일, 모듈당 파일 분리
- Frontend: Vanilla JS (프레임워크 없음), ES5 호환 (`var`, `function`)
- CSS: BEM 없이 ID/class 직접 사용, CSS Variables 미사용
- 에러 처리: `tracing::error!` (백엔드), `console.error` + `term.writeln` (프론트엔드)
- 한 번에 하나의 연결만 허용 (Serial 또는 SSH)

## Build & Run

```bash
# 개발 모드
cargo tauri dev

# 빌드 확인 (컴파일만)
cargo check --manifest-path src-tauri/Cargo.toml

# 프로덕션 빌드
cargo tauri build
```

## Important Rules

1. **기존 패턴 따르기**: 새 코드는 기존 코드와 동일한 스타일/패턴 사용
2. **프론트엔드는 Vanilla JS**: 프레임워크나 빌드 도구 추가 금지
3. **단일 연결 모델**: Serial과 SSH 중 하나만 활성화 가능
4. **WebSocket 공유**: Serial/SSH 모두 동일한 `/ws` 엔드포인트로 데이터 중계
5. **cargo check 통과 필수**: 코드 변경 후 반드시 `cargo check --manifest-path src-tauri/Cargo.toml` 확인
6. **불필요한 의존성 추가 금지**: 꼭 필요한 경우에만 새 crate 추가
