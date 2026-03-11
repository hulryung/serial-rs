# Remote Serial Server — Development Progress

## Timeline

### 2026-02-20
- **[Planning]** 기능 기획 시작
  - 브랜치: `feature/remote-serial-server`
  - 기존 아키텍처 분석 (Axum + WebSocket + REST API)
  - Prior art 조사: RFC 2217, ser2net, remote-serial-port-server
  - WebSocket 기반 확장 방식 채택 (기존 인프라 재활용)
  - 4단계 구현 계획 수립 (서버 모드 → 클라이언트 모드 → CLI → 보안 강화)
  - PLAN-remote-serial.md, PROGRESS-remote-serial.md 작성
