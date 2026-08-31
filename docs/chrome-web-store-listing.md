# Chrome Web Store Listing Package

Prepared for ScholarRelay 1.2.2. Confirm every field against the final uploaded ZIP before submission.

## Product identity

- **Name:** ScholarRelay
- **Category:** Productivity
- **Primary language:** English
- **Additional localization:** Korean
- **Support URL:** https://github.com/mahlernim/scholar-relay/issues
- **Privacy policy URL:** https://github.com/mahlernim/scholar-relay/blob/main/PRIVACY.md
- **Official relationship:** Independent extension; not affiliated with, authorized by, or endorsed by Google.

## English listing

### Single purpose

Send a PDF, research paper, or webpage selected by the user to the user's signed-in Gemini Notebook account, optionally organize the resulting notebook, and request the selected artifacts.

### Short description

Send papers and webpages to Gemini Notebook, organize them, and generate the artifacts you choose.

### Detailed description

Turn the source in your current tab into an organized Gemini Notebook workflow without repeating the setup by hand.

ScholarRelay detects direct PDFs, arXiv papers, PDFs linked from webpages, and ordinary webpages. It adds the selected source to your signed-in Gemini Notebook account, can place the new notebook in an existing collection, and can prefer a trustworthy detected paper title instead of the service's automatic title.

Choose any supported combination of Audio Overview, Video Overview, report, quiz, flashcards, infographic, slide deck, mind map, and data table. Generation continues after the popup closes. Optional notifications, a completion chime, and automatic notebook opening let you know when the result is ready.

ScholarRelay uses the Gemini Notebook session already established in Chrome. It never asks for or stores your Google password or verification codes. A PDF hosted on a different website may require a one-time Chrome permission prompt for that specific website. If access is declined, ScholarRelay tries URL import and keeps manual PDF upload available.

Direct PDF downloads and local uploads are limited to 32 MiB to keep Chrome memory use safe. Larger remote PDFs use URL import, while larger local files can be uploaded directly in Gemini Notebook.

ScholarRelay is an independent, open-source extension and is not affiliated with, authorized by, or endorsed by Google. Gemini Notebook was formerly named NotebookLM. ScholarRelay integrates with the consumer web application rather than an official consumer API, so service changes can affect compatibility.

## 한국어 스토어 등록 문구

### 단일 목적

사용자가 선택한 PDF, 연구 논문 또는 웹페이지를 로그인된 Gemini Notebook 계정으로 보내고, 필요하면 생성된 노트북을 정리한 뒤 선택한 아티팩트 생성을 요청합니다.

### 짧은 설명

논문과 웹페이지를 Gemini Notebook으로 보내 정리하고 원하는 아티팩트를 생성합니다.

### 자세한 설명

현재 탭의 자료를 반복 작업 없이 정리된 Gemini Notebook 워크플로로 전환하세요.

ScholarRelay는 직접 열린 PDF, arXiv 논문, 웹페이지에 연결된 PDF 및 일반 웹페이지를 감지합니다. 선택한 자료를 로그인된 Gemini Notebook 계정에 추가하고, 새 노트북을 기존 컬렉션에 넣을 수 있으며, 신뢰할 수 있는 논문 제목이 감지되면 서비스의 자동 제목 대신 사용할 수 있습니다.

오디오 오버뷰, 비디오 오버뷰, 보고서, 퀴즈, 플래시카드, 인포그래픽, 슬라이드, 마인드맵, 데이터 표를 원하는 조합으로 선택할 수 있습니다. 팝업을 닫은 뒤에도 생성 상태를 확인하며, 선택 사항인 알림, 완료 차임 및 노트북 자동 열기로 결과가 준비되었는지 확인할 수 있습니다.

ScholarRelay는 Chrome에 이미 로그인된 Gemini Notebook 세션을 사용합니다. Google 비밀번호나 인증 코드를 요청하거나 저장하지 않습니다. PDF가 현재 페이지와 다른 사이트에 있으면 해당 사이트에 한정된 일회성 Chrome 권한 요청이 표시될 수 있습니다. 권한을 거부하면 URL 가져오기를 시도하고, 직접 PDF를 업로드할 수 있는 방법도 유지합니다.

Chrome 메모리를 안전하게 유지하기 위해 직접 PDF 다운로드와 로컬 업로드는 32 MiB로 제한됩니다. 더 큰 원격 PDF는 URL 가져오기를 사용하고, 더 큰 로컬 파일은 Gemini Notebook에서 직접 업로드할 수 있습니다.

ScholarRelay는 독립적인 오픈 소스 확장 프로그램이며 Google과 제휴하거나 Google의 승인 또는 보증을 받지 않았습니다. Gemini Notebook의 이전 명칭은 NotebookLM입니다. 공식 소비자용 API가 아닌 소비자 웹 애플리케이션과 연동하므로 서비스 변경에 따라 호환성 업데이트가 필요할 수 있습니다.

## Permission justifications

- **activeTab:** Inspect only the tab on which the user invokes ScholarRelay and read a same-origin PDF selected by the user.
- **scripting:** Detect PDF links and paper-title metadata in the active tab after the user opens the popup.
- **storage:** Save settings and resilient pipeline status so monitoring can continue after the popup closes.
- **notifications:** Show an optional completion or failure notification.
- **offscreen:** Play the optional local completion chime; it is not used for browsing or remote execution.
- **alarms:** Wake the Manifest V3 service worker every 30 seconds while source or artifact generation is being monitored.
- **notebook.google.com / notebooklm.google.com:** Use the user's existing signed-in Gemini Notebook session to create notebooks, add sources, organize collections, request artifacts, and check status.
- **file://:** Read a local PDF only when the user enables Chrome's separate **Allow access to file URLs** control and invokes ScholarRelay on that file.
- **Optional HTTP/S site access:** Download a user-selected PDF hosted on a different origin. ScholarRelay requests only the detected origin and only from the generation action.

## Privacy dashboard declarations

Declare handling of the following categories because ScholarRelay processes them locally or transmits them as part of its single purpose:

- **Authentication information:** The existing Gemini Notebook browser session and temporary CSRF/session values.
- **Web history/browsing activity:** The URL and title of the active tab on which the user invokes ScholarRelay.
- **Website content:** Detected page metadata, PDF links, and user-selected PDF content.
- **User-generated content:** Custom artifact instructions and extension settings, if the dashboard presents this category.

Certify that data is used only for the disclosed single purpose; is not sold; is not used for advertising, creditworthiness, or unrelated purposes; is not transferred except to Gemini Notebook or the selected source host as necessary; and is not read by the developer. ScholarRelay has no developer-operated backend, analytics, or telemetry.

## Remote code declaration

Select **No, I am not using remote code**. All executable JavaScript is included in the uploaded package. Network responses provide user data and service results, not executable logic.

## Reviewer instructions

1. Install ScholarRelay in Chrome 120 or newer.
2. Sign in through https://notebook.google.com in a normal browser tab. ScholarRelay has no separate account and does not collect login credentials.
3. Open a public PDF or arXiv abstract and invoke ScholarRelay from the toolbar.
4. Leave Audio enabled, start generation, and close the popup. Reopen it to observe persisted progress.
5. Open Settings to test collection selection, preferred paper title, artifact choices, and experience controls.
6. For optional-origin behavior, test a page whose PDF link points to another host. Granting access permits direct download; declining uses URL import or manual upload fallback.
7. Artifact generation can take more than ten minutes. ScholarRelay wakes briefly every 30 seconds rather than keeping a persistent background page running.

No developer-provided credentials are required or available. Reviewers sign in through Gemini Notebook using an account they are authorized to test.

## Required assets

- `docs/store-assets/screenshot-workflow-1280x800.png`
- `docs/store-assets/screenshot-settings-1280x800.png`
- `docs/store-assets/small-promo-440x280.png`
- `icons/icon128.png`
