# SSH Feature - Task Instructions

## Current Status

백엔드 SSH 모듈 기본 구조 완성 (`src-tauri/src/ssh.rs`).
프론트엔드 SSH UI 미구현. `cargo check` 통과 완료.

---

## Task 1: Frontend - SSH 연결 UI 추가

**파일**: `frontend/index.html`, `frontend/app.js`, `frontend/style.css`

### 요구사항

1. 툴바에 연결 모드 선택 탭 추가 (Serial / SSH)
   - 탭 전환 시 해당 모드의 설정 필드만 표시
   - 기존 시리얼 설정 (Port, Baud, Config)은 Serial 탭에
   - SSH 설정 (Host, Port, Username, Password)은 SSH 탭에

2. SSH 탭 UI 요소:
   - Host 입력 (text input, placeholder: "hostname or IP")
   - Port 입력 (number input, default: 22)
   - Username 입력 (text input)
   - Password 입력 (password input)
   - Connect 버튼은 공용 (모드에 따라 다른 API 호출)

3. Connect 버튼 동작:
   - Serial 모드: 기존과 동일 (`POST /api/connect`)
   - SSH 모드: `POST /api/ssh/connect` 호출
     ```json
     {
       "host": "192.168.1.1",
       "port": 22,
       "username": "root",
       "password": "password"
     }
     ```
   - 연결 후 WebSocket 열기는 동일 (`openWebSocket`)

4. 상태바에 연결 유형 표시:
   - Serial: 기존과 동일 (포트명 @ 보레이트)
   - SSH: "SSH root@192.168.1.1:22"

5. Settings 모달에 SSH 관련 설정 추가:
   - "Remember last SSH connection" 체크박스
   - SSH 연결 정보 localStorage 저장/복원

### 디자인 가이드

- 기존 네이비 다크 테마 유지
- 탭은 toolbar 상단에 작은 토글/탭 형태
- 기존 CSS 패턴 따르기 (색상: #1a1a2e, #16213e, #0f3460, #e94560)

---

## Task 2: Backend - SSH PTY 리사이즈 지원

**파일**: `src-tauri/src/ssh.rs`, `src-tauri/src/lib.rs`

### 요구사항

1. 프론트엔드에서 터미널 크기 변경 시 SSH PTY 리사이즈
2. WebSocket으로 리사이즈 메시지 전달 (JSON text frame):
   ```json
   {"type": "resize", "cols": 120, "rows": 40}
   ```
3. `lib.rs`의 WebSocket 핸들러에서 resize 메시지 감지 후 SSH channel에 `window_change` 요청
4. `ssh.rs`에 `resize(cols, rows)` 메서드 추가

### 구현 힌트

- `handle_ws`에서 Text frame 수신 시 JSON 파싱하여 resize 여부 확인
- russh의 `channel.window_change(cols, rows, 0, 0)` 사용
- SshConnection에 channel_id를 저장하여 resize 시 사용

---

## Task 3: Backend - SSH 연결 에러 처리 강화

**파일**: `src-tauri/src/ssh.rs`

### 요구사항

1. 연결 타임아웃 설정 (10초)
2. SSH 서버 연결 끊김 감지 후 프론트엔드에 알림
   - `SshClientHandler`에서 `disconnected` 콜백 구현
   - broadcast로 disconnect 이벤트 전달
3. 재연결 로직 (프론트엔드에서 disconnect 감지 시 자동 정리)

---

## Task 4: Frontend - SSH 연결 기록 및 빠른 연결

**파일**: `frontend/index.html`, `frontend/app.js`

### 요구사항

1. 최근 SSH 연결 기록을 localStorage에 저장 (최대 10개)
2. SSH 탭에 "Recent Connections" 드롭다운
3. 선택 시 Host/Port/Username 자동 입력 (password는 저장하지 않음)
4. 기록 삭제 기능

---

## Task 5: Backend - SSH Key Authentication

**파일**: `src-tauri/src/ssh.rs`

### 요구사항

1. `SshConfig`에 key 기반 인증 필드 추가:
   ```rust
   pub struct SshConfig {
       pub host: String,
       pub port: u16,
       pub username: String,
       pub auth: SshAuth,
   }

   pub enum SshAuth {
       Password(String),
       Key { private_key_path: String, passphrase: Option<String> },
   }
   ```
2. `~/.ssh/id_rsa`, `~/.ssh/id_ed25519` 등 기본 키 자동 감지
3. 프론트엔드에서 인증 방식 선택 (Password / Key)

---

## Execution Order

**권장 순서**: Task 1 → Task 2 → Task 3 → Task 4 → Task 5

각 Task는 독립적으로 완료 가능하지만, Task 1 (프론트엔드 UI)이 나머지를 테스트하기 위해 먼저 필요.

## Validation

각 Task 완료 후 반드시:
1. `cargo check --manifest-path src-tauri/Cargo.toml` 통과
2. 프론트엔드 변경 시 브라우저에서 UI 깨짐 없는지 확인
3. 기존 시리얼 연결 기능이 깨지지 않는지 확인
