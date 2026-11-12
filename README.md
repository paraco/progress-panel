# progress-panel

Claude Code 작업의 진행 경과를 보여 주는 mod 입니다.

- **진행 패널** (Claude 데스크톱 앱 옆 패널): 단계 타임라인, 완료 비율, **경과 시간**(30초마다 갱신, 끝나면 멈춤), **단계별 모델·토큰**.
- **Progress Widget** (macOS 떠 있는 창, 선택): 이 컴퓨터에서 도는 **모든 세션**을 카드로 모아 보여 줍니다 — 작업 중 세션 수, 백그라운드 작업 수, 조치가 필요한 단계(노랗게 깜박임), 세션별 경과 시간·토큰·모델·컨텍스트·비용, 계정 사용 한도(5시간·7일).

## 설치

Claude Code 세션의 프롬프트에서:

```
/plugin install progress-panel --marketplace paraco/progress-panel
```

마켓플레이스를 추가할지 물으면 `y`, 그다음 설치 범위를 고릅니다.

셸에서는:

```bash
claude plugin install progress-panel --marketplace paraco/progress-panel
```

## 쓰는 법

- `/progress` — 진행 패널을 엽니다.
- Claude 는 함께 들어 있는 skill(`progress-panel`) 에 따라 여러 단계 작업에서 `progress_update` 도구로 패널을 채웁니다. 단계를 `running` 으로 바꿀 때마다 그 뒤 응답의 토큰이 그 단계에 모델별로 쌓입니다(서브에이전트 포함).
- 앱 작업 목록(task list)도 자동으로 위젯에 옮겨 적습니다.

## Progress Widget (macOS, 선택)

Swift 로 빌드합니다(Xcode 또는 Command Line Tools 필요).

```bash
bash widget/build.sh            # ~/Applications/Progress Widget.app 을 만듭니다
```

그다음 `/progress-widget` 으로 엽니다. 세션 기록은 `~/.claude/progress-panel/sessions/<세션ID>.json` 에 쓰이고, 위젯은 이 폴더만 읽습니다(네트워크를 쓰지 않습니다).

## 개발

```bash
claude plugin validate .
claude plugin test .
```

## 라이선스

MIT
