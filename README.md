# Serial Terminal

Tauri v2 기반 네이티브 시리얼 터미널 앱. Rust 백엔드(Axum + tokio-serial)와 xterm.js 프론트엔드로 구성.

## Features

- 시리얼 포트 연결 (baud rate, data bits, stop bits, parity 설정)
- xterm.js 기반 VT100 터미널 에뮬레이터
- WebSocket을 통한 실시간 양방향 데이터 스트리밍
- 128KB 스크롤백 버퍼 (브라우저 새로고침 시에도 유지)
- 페이지 리로드 시 자동 재연결
- `/dev/cu.*` 포트 필터링 (Settings에서 설정 가능)
- 반응형 툴바 레이아웃
- 다크 테마 UI

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Tauri v2 |
| Backend | Rust, Axum 0.8, Tokio |
| Serial | tokio-serial, serialport |
| Frontend | HTML/CSS/JS, xterm.js 5.5.0 |
| Asset Embedding | rust-embed |

## Build & Run

### Prerequisites

- Rust 1.70+
- macOS 11+

### Development

```bash
cargo tauri dev
```

### Production

```bash
cargo tauri build
```

빌드 결과물: `target/release/bundle/dmg/`

## Architecture

```
Tauri WebView <──> Axum Server (localhost:3000)
                   ├── REST API
                   │   ├── GET  /api/ports       포트 목록
                   │   ├── POST /api/connect      포트 연결
                   │   ├── POST /api/disconnect   포트 해제
                   │   └── GET  /api/status       연결 상태
                   ├── WebSocket /ws              시리얼 데이터 스트림
                   └── Static files               프론트엔드 에셋
```

## Project Structure

```
serial-rs/
├── frontend/
│   ├── index.html          메인 페이지
│   ├── style.css           다크 테마 스타일
│   └── app.js              터미널 및 연결 로직
└── src-tauri/
    ├── tauri.conf.json      Tauri 앱 설정
    └── src/
        ├── main.rs          엔트리포인트
        └── lib.rs           Axum 서버, WebSocket, 시리얼 핸들러
```
