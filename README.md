# RuninqVic

사진 여러 장(그리고 짧은 동영상 클립)과 배경음악만 넣으면 재생시간을 자동으로 배분해 **MP4 동영상**을 만들어 주는 프로그램입니다.
서비스가 종료된 **알씨 동영상 만들기**의 워크플로(간편만들기 → 상세꾸미기 → 만들기)를 그대로 계승하고,
비트 싱크·세로 영상·4K·자동 저장 같은 기능을 더했습니다.

## 바로 사용하기
- 웹: **https://runinqvic.vercel.app** (Edge/Chrome, 설치 불필요) · 스마트폰(안드로이드 Chrome, iOS Safari 16.4+)에서도 같은 주소로 사용, 홈 화면에 추가하면 앱처럼 실행
- 소스: https://github.com/SamulChung/RuninqVic
- 사용설명서: https://runinqvic.vercel.app/manual (Word 버전: `docs/manual/RuninqVic_사용설명서.docx`)

## PC에서 실행
1. `RuninqVic.bat` 을 더블클릭합니다. (Edge 또는 Chrome 이 앱 창으로 열립니다)
2. 또는 `index.html` 을 Edge/Chrome 으로 엽니다.

설치, 인터넷 연결, 계정이 필요 없습니다. 사진과 음악은 PC 밖으로 나가지 않습니다.

## 사용법
| 단계 | 할 일 |
|---|---|
| 1 | **사진·동영상 추가** 또는 화면에 끌어다 놓기 (JPG/PNG/WEBP, MP4/WEBM/MOV, EXIF 회전 자동) |
| 2 | **배경음악** 넣기 (MP3/M4A/WAV/OGG, 여러 곡 가능) |
| 3 | 장당 재생시간 입력, 또는 *음악 재생시간에 균등하게 맞춤* / *비트에 맞춰 자동 전환* |
| 4 | 오프닝·엔딩 제목 확인 |
| 꾸미기 | 자막 · 디자인(배경 20종, 액자 10종) · 효과(전환 12종, 시네마틱 7종) · 동영상 구간 자르기/소리 조절 |
| 만들기 | **동영상 만들기** → 크기(720p~4K)·프레임(24/30/60)·품질 선택 → MP4 저장 |

작업 내용은 브라우저 안에 자동 저장되어 다시 열면 이어서 할 수 있고, **저장** 버튼으로 `.rvproj` 파일을 만들어 다른 PC로 옮길 수 있습니다.

## 기술
- 순수 HTML/CSS/JS, 빌드 도구 없음. `js/` 아래 모듈:
  `state`(모델) · `timeline`(시간 배분) · `designs`(프리셋) · `render`(캔버스 렌더러) · `audio`(믹스/비트 검출) · `exporter`(WebCodecs) · `store`(IndexedDB/.rvproj) · `app`(UI)
- 인코딩: WebCodecs `VideoEncoder`(H.264, GPU 가속) + `AudioEncoder`(AAC) → `mp4-muxer`. H.264 를 못 쓰는 환경은 VP9/Opus WebM 으로 자동 대체.
- 미리보기와 결과물이 같은 렌더러를 쓰므로 화면에서 본 그대로 저장됩니다.
- 모바일: 900px 이하에서 세로 레이아웃(미리보기 → 타임라인 → 작업 패널), `navigator.share`로 갤러리·카톡 저장, `manifest.json` + `sw.js`(네트워크 우선, 오프라인 폴백)로 PWA 설치.
- 동영상 클립: `<video>` 요소를 내보내기 전용 복제본으로 실시간 재생하며 프레임을 캡처(`Renderer.prepare` export 모드). 클립 소리는 `decodeAudioData`로 디코딩해 오프라인 믹스에 합치고, 재생 중 배경음악을 자동으로 낮춥니다(더킹).

## 사용설명서 다시 만들기
스크린샷은 `docs/manual/img/`, 본문은 `docs/manual/content.js` 에 있습니다.
```
NODE_PATH=<docx 패키지가 설치된 node_modules> node docs/manual/build-manual.js
```

## 테스트
```
node tests/timeline.test.js
```
