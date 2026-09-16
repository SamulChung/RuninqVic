# RuninqVic

사진 여러 장과 배경음악만 넣으면 재생시간을 자동으로 배분해 **MP4 동영상**을 만들어 주는 프로그램입니다.
서비스가 종료된 **알씨 동영상 만들기**의 워크플로(간편만들기 → 상세꾸미기 → 만들기)를 그대로 계승하고,
비트 싱크·세로 영상·4K·자동 저장 같은 기능을 더했습니다.

## 바로 사용하기
- 웹: **https://runinqvic.vercel.app** (Edge/Chrome, 설치 불필요)
- 소스: https://github.com/SamulChung/RuninqVic

## PC에서 실행
1. `RuninqVic.bat` 을 더블클릭합니다. (Edge 또는 Chrome 이 앱 창으로 열립니다)
2. 또는 `index.html` 을 Edge/Chrome 으로 엽니다.

설치, 인터넷 연결, 계정이 필요 없습니다. 사진과 음악은 PC 밖으로 나가지 않습니다.

## 사용법
| 단계 | 할 일 |
|---|---|
| 1 | **사진추가** 또는 화면에 사진을 끌어다 놓기 (JPG/PNG/WEBP, EXIF 회전 자동) |
| 2 | **배경음악** 넣기 (MP3/M4A/WAV/OGG, 여러 곡 가능) |
| 3 | 장당 재생시간 입력, 또는 *음악 재생시간에 균등하게 맞춤* / *비트에 맞춰 자동 전환* |
| 4 | 오프닝·엔딩 제목 확인 |
| 꾸미기 | 자막 · 디자인(배경 20종, 액자 10종) · 효과(전환 12종, 시네마틱 7종) |
| 만들기 | **동영상 만들기** → 크기(720p~4K)·프레임(24/30/60)·품질 선택 → MP4 저장 |

작업 내용은 브라우저 안에 자동 저장되어 다시 열면 이어서 할 수 있고, **저장** 버튼으로 `.rvproj` 파일을 만들어 다른 PC로 옮길 수 있습니다.

## 기술
- 순수 HTML/CSS/JS, 빌드 도구 없음. `js/` 아래 모듈:
  `state`(모델) · `timeline`(시간 배분) · `designs`(프리셋) · `render`(캔버스 렌더러) · `audio`(믹스/비트 검출) · `exporter`(WebCodecs) · `store`(IndexedDB/.rvproj) · `app`(UI)
- 인코딩: WebCodecs `VideoEncoder`(H.264, GPU 가속) + `AudioEncoder`(AAC) → `mp4-muxer`. H.264 를 못 쓰는 환경은 VP9/Opus WebM 으로 자동 대체.
- 미리보기와 결과물이 같은 렌더러를 쓰므로 화면에서 본 그대로 저장됩니다.

## 테스트
```
node tests/timeline.test.js
```
