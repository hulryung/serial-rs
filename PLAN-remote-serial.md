# Remote Serial Server — Development Plan

## Overview
serial-rs 앱을 **시리얼 서버**로 확장하여, 네트워크를 통해 원격 클라이언트가 시리얼 포트에 접근할 수 있도록 한다.

### 사용 시나리오
1. **서버 모드** — 로컬 시리얼 포트를 네트워크에 노출 (0.0.0.0 바인딩)
2. **클라이언트 모드 (앱)** — 같은 serial-rs 앱으로 원격 서버에 연결
3. **클라이언트 모드 (CLI)** — 전용 CLI 도구로 원격 서버에 연결
4. **클라이언트 모드 (브라우저)** — 웹 브라우저에서 원격 서버의 프론트엔드 접속

## Prior Art & Design Rationale

| 솔루션 | 프로토콜 | 장점 | 단점 |
|--------|---------|------|------|
| RFC 2217 | Telnet 확장 | 표준, 호환성 | 복잡, 암호화 없음, 레거시 |
| ser2net | Raw TCP/Telnet | 성숙, 안정적 | WebSocket 미지원, CLI 전용 |
| remote-serial-port-server | HTTP+WS+REST | WebSocket, REST API | Node.js, 인증 없음 |

**결정**: 기존 Axum WebSocket + REST API 인프라를 확장한다.
- 이미 바이너리 WebSocket 프레임 기반 시리얼 데이터 중계가 동작 중
- REST API로 포트 관리 API가 존재
- 인증 레이어와 네트워크 바인딩만 추가하면 서버 모드 완성
- 클라이언트 모드는 로컬 시리얼 대신 원격 WebSocket을 데이터 소스로 사용

## Architecture

### 현재 구조 (Local Only)
```
Tauri WebView ←→ Axum (127.0.0.1:3000)
                  ├── REST API (/api/*)
                  ├── WebSocket (/ws)
                  └── Serial Port (local)
```

### 확장 구조

```
┌─────────────────────────────────────────────────────────┐
│  Server (serial-rs 앱, 서버 모드)                         │
│                                                         │
│  Tauri WebView ←→ Axum (0.0.0.0:3000)                  │
│                    ├── REST API (/api/*)                 │
│                    ├── WebSocket (/ws)      ← 인증 필요   │
│                    ├── Remote API (/api/remote/*)        │
│                    └── Serial Port (local)               │
│                         ↑                                │
└─────────────────────────│────────────────────────────────┘
                          │ Network (WS binary frames)
          ┌───────────────┼───────────────┐
          │               │               │
   ┌──────┴──────┐ ┌──────┴──────┐ ┌──────┴──────┐
   │ serial-rs   │ │ CLI client  │ │ Browser     │
   │ (client)    │ │ (serial-cli)│ │ (직접 접속)  │
   └─────────────┘ └─────────────┘ └─────────────┘
```

## API Design

### Server 설정 API (새로 추가)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/server/start` | 서버 모드 시작 (포트 + 인증 설정) |
| POST | `/api/server/stop` | 서버 모드 중지 |
| GET | `/api/server/status` | 서버 상태 (활성 클라이언트 수 등) |

### 인증

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth` | 토큰으로 인증, 세션 쿠키 발급 |

### WebSocket 인증 흐름
```
1. Client → POST /api/auth { "token": "shared-secret" }
2. Server → 200 OK + Set-Cookie: session=xxx
3. Client → GET /ws (Cookie: session=xxx 또는 ?token=xxx)
4. Server → WebSocket Upgrade (인증 확인)
5. Binary frames 양방향 전송
```

### 클라이언트 모드 API (앱 내)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/remote/connect` | 원격 서버에 연결 |
| POST | `/api/remote/disconnect` | 원격 서버 연결 해제 |
| GET | `/api/remote/status` | 원격 연결 상태 |

## Implementation Phases

### Phase 1: 서버 모드 기반 — 네트워크 바인딩 + 인증
**목표**: 로컬 시리얼 포트를 네트워크에 안전하게 노출

- [ ] **서버 설정 구조체** — `ServerConfig { enabled, bind_addr, port, auth_token }`
- [ ] **네트워크 바인딩 변경** — `127.0.0.1` → 설정에 따라 `0.0.0.0` 또는 특정 IP
- [ ] **인증 미들웨어** — Bearer token 또는 query param 기반 인증
  - 서버 모드 OFF: 기존처럼 인증 없이 localhost만 허용
  - 서버 모드 ON: 모든 요청에 인증 필요 (로컬 WebView 제외)
- [ ] **WebSocket 인증** — 연결 시 token 검증 (query param `?token=xxx`)
- [ ] **서버 설정 UI** — Settings 모달에 Server 섹션 추가
  - 서버 모드 ON/OFF 토글
  - 바인딩 포트 설정
  - 인증 토큰 생성/표시
  - 접속 중인 클라이언트 수 표시

### Phase 2: 클라이언트 모드 — 앱에서 원격 서버 연결
**목표**: serial-rs 앱이 원격 서버의 시리얼 포트에 접근

- [ ] **Remote Connection 모드** — 로컬 시리얼 대신 원격 WebSocket을 데이터 소스로 사용
- [ ] **프론트엔드 UI** — 연결 대상 선택 (Local Serial / Remote Server)
  - Remote 선택 시: Host, Port, Token 입력 필드
  - 연결 시 원격 서버의 `/api/ports` 조회 → 포트 선택
  - 원격 서버에 `/api/connect` → `/ws` 연결
- [ ] **원격 포트 설정** — 원격 서버의 시리얼 포트 baud rate 등 설정
- [ ] **연결 상태 관리** — 네트워크 끊김 감지, 자동 재연결

### Phase 3: CLI 클라이언트
**목표**: 터미널에서 원격 시리얼 포트에 접근

- [ ] **별도 바이너리** — `serial-cli` (같은 workspace 내)
- [ ] **기본 사용법**: `serial-cli connect <host>:<port> --token <token>`
- [ ] **기능**:
  - 원격 포트 목록 조회
  - 시리얼 연결/해제
  - stdin/stdout ↔ WebSocket 바이너리 데이터 중계
  - raw 모드 (터미널 에뮬레이션 없이 데이터만 전달)
- [ ] **의존성**: clap (CLI), tokio-tungstenite (WebSocket client), crossterm (raw terminal)

### Phase 4: 안정화 및 보안 강화
- [ ] TLS 지원 (HTTPS + WSS)
- [ ] 접속 로그 및 감사
- [ ] 다중 시리얼 포트 동시 서빙
- [ ] 클라이언트별 권한 (read-only / read-write)
- [ ] 연결 제한 (max clients)

## File Changes (Phase 1-2 예상)

### Backend (src-tauri/src/)
| File | Change |
|------|--------|
| `lib.rs` | ServerConfig 추가, 바인딩 로직 변경, 인증 미들웨어 |
| `auth.rs` (신규) | 토큰 인증, 세션 관리 |
| `remote.rs` (신규) | 클라이언트 모드 — 원격 WebSocket 연결 관리 |

### Frontend (frontend/)
| File | Change |
|------|--------|
| `index.html` | Settings 모달에 Server 섹션, 연결 모드 선택 UI |
| `style.css` | 새 UI 요소 스타일 |
| `app.js` | 서버 설정 로직, 원격 연결 모드, 연결 대상 전환 |

### CLI (serial-cli/) — Phase 3
| File | Description |
|------|-------------|
| `Cargo.toml` | CLI 패키지 설정 |
| `src/main.rs` | CLI 엔트리포인트 + 명령어 처리 |

## Security Considerations
- 서버 모드 OFF가 기본값 (사용자가 명시적으로 활성화해야 함)
- 토큰은 충분한 엔트로피 (최소 32바이트, base64)
- localhost 요청은 인증 bypass 가능 (Tauri WebView 호환성)
- Phase 4에서 TLS 추가 전까지는 LAN 내 사용 권장
