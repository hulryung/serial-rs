# Serial Terminal (Rust + Web UI) - Development Plan

## Overview
Rust 백엔드와 Web UI를 이용한 시리얼 터미널 애플리케이션

## Architecture
```
Browser (xterm.js) <--WebSocket(binary)--> Axum Backend <--tokio-serial--> Serial Port
                   <--REST(JSON)-------->
```

## Tech Stack
- **Backend**: Rust (Axum + tokio-serial + serialport)
- **Frontend**: HTML/JS (xterm.js + addon-attach + addon-fit)
- **Communication**: WebSocket (binary frames) + REST API

## Development Phases

### Phase 1: Project Scaffolding
- [x] Git 초기화
- [x] Cargo 프로젝트 생성
- [x] 기본 의존성 설정
- [x] .gitignore 설정

### Phase 2: Rust Backend Core
- [x] Axum HTTP 서버 기본 구조
- [x] 시리얼 포트 매니저 (열거, 연결, 해제)
- [x] REST API 엔드포인트
  - `GET /api/ports` - 포트 목록
  - `POST /api/connect` - 포트 연결
  - `POST /api/disconnect` - 포트 해제
  - `GET /api/status` - 연결 상태
- [x] WebSocket 핸들러 (바이너리 데이터 중계)
- [x] 에러 처리 및 로깅

### Phase 3: Frontend Web UI
- [x] HTML 레이아웃 (터미널 + 설정 패널)
- [x] xterm.js 터미널 통합
- [x] WebSocket 연결 (addon-attach)
- [x] 설정 UI (포트 선택, 보레이트, 데이터 비트 등)
- [x] 연결/해제 버튼
- [x] 상태 표시

### Phase 4: Standalone & Polish
- [x] 빌드 검증 (cargo build 성공)
- [x] 실제 시리얼 포트 연결 테스트
- [x] 브라우저 새로고침 시 자동 재연결
- [x] 스크롤백 버퍼 (128KB, 새로고침 시 이전 출력 복원)
- [x] rust-embed로 프론트엔드 바이너리 임베드 (2.5MB 단일 실행 파일)
- [x] UI 개선 (네이비 다크 테마, 상태바, macOS Tahoe 둥근 모서리 대응)

### Phase 5: Tauri 데스크톱 앱 전환
브라우저 없이 독립 실행 가능한 네이티브 앱으로 전환 (방법 A: Axum+WebSocket 유지)

- [x] Tauri v2 프로젝트 초기화 (src-tauri/ 디렉토리 구조)
- [x] 기존 프론트엔드(HTML/CSS/JS)를 Tauri WebView에서 로드
- [x] Axum 서버를 Tauri 백엔드로 통합 (setup hook에서 background task로 실행)
- [x] 방법 A 채택: 기존 Axum+WebSocket 구조 유지, Tauri가 WebView만 제공
- [x] 앱 아이콘, 윈도우 설정 (960x640, "Serial Terminal")
- [x] `cargo tauri dev` 실행 검증 완료
- [x] macOS .app 번들 빌드 (`cargo tauri build`) - 9.6MB .app / 3.3MB DMG
- [x] 앱 아이콘 (네이비 배경 + ">_" 터미널 심볼 + coral 악센트)
- [x] macOS 네이티브 메뉴바 (App/Edit/Window 메뉴, Copy/Paste/Select All 지원)

## API Specification

### REST Endpoints
| Method | Path | Description | Request Body | Response |
|--------|------|-------------|--------------|----------|
| GET | `/api/ports` | 사용 가능한 시리얼 포트 목록 | - | `[{name, port_type}]` |
| POST | `/api/connect` | 시리얼 포트 연결 | `{port, baud_rate, data_bits, stop_bits, parity}` | `{ok, message}` |
| POST | `/api/disconnect` | 시리얼 포트 해제 | - | `{ok, message}` |
| GET | `/api/status` | 현재 연결 상태 | - | `{connected, port, config}` |

### WebSocket Endpoint
| Path | Description |
|------|-------------|
| `GET /ws` | 시리얼 데이터 바이너리 중계 (upgrade) |

## Team Structure
- **backend**: Rust 백엔드 (Axum 서버, 시리얼 포트 매니저, API, WebSocket)
- **frontend**: Web UI (HTML/CSS/JS, xterm.js, 설정 패널)
