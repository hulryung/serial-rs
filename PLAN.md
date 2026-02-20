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

### Phase 4: Integration & Testing
- [x] 빌드 검증 (cargo build 성공)
- [ ] 실제 시리얼 포트 연결 테스트
- [ ] 에러 케이스 처리 (포트 분리, 연결 끊김)
- [ ] 빌드 스크립트 (프론트엔드 번들링)

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
