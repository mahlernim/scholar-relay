# Chrome PDF to NotebookLM

Turn a PDF, arXiv paper, or webpage into a NotebookLM notebook and generate the artifacts you want in one workflow.

[Download the latest install-ready release](https://github.com/mahlernim/chrome-pdf-to-notebooklm/releases/latest) · [한국어](#한국어) · [English](#english)

## Screenshots

| Workflow | Settings |
| --- | --- |
| ![Completed workflow with collection assignment](./docs/screenshots/workflow.png) | ![Notebook, artifact, and experience settings](./docs/screenshots/settings.png) |

---

## 한국어

### 주요 기능

- 현재 탭에서 PDF, arXiv 논문, 웹페이지를 감지해 NotebookLM 소스로 추가합니다.
- 원격 PDF와 로컬 PDF 업로드를 지원하며, PDF 메타데이터에서 신뢰할 수 있는 논문 제목을 찾습니다.
- 새 노트북을 선택한 기존 NotebookLM 컬렉션에 자동으로 추가할 수 있습니다.
- 감지한 논문 제목을 우선 사용하거나 NotebookLM의 자동 제목 생성을 선택할 수 있습니다.
- 오디오, 비디오, 보고서, 퀴즈, 플래시카드, 인포그래픽, 슬라이드, 마인드맵, 데이터 표를 원하는 조합으로 생성합니다.
- 팝업을 닫아도 백그라운드에서 진행되며 완료 알림, 차임, 노트북 자동 열기를 설정할 수 있습니다.

### 설치

1. [최신 릴리스](https://github.com/mahlernim/chrome-pdf-to-notebooklm/releases/latest)의 **Assets**에서 `chrome-pdf-to-notebooklm-v1.2.0.zip`을 다운로드합니다. GitHub가 자동으로 제공하는 **Source code** ZIP은 설치용 파일이 아닙니다.
2. ZIP을 계속 사용할 폴더에 압축 해제합니다.
3. Chrome에서 `chrome://extensions`를 열고 **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램을 로드**를 클릭하고 `manifest.json`이 들어 있는 압축 해제 폴더를 선택합니다.
5. [NotebookLM](https://notebook.google.com)에 로그인합니다.

### 업데이트

새 릴리스 ZIP의 파일을 기존 확장 프로그램 폴더에 덮어쓴 다음 `chrome://extensions`에서 확장 프로그램의 **새로고침** 버튼을 클릭합니다. 같은 폴더를 사용하면 기존 설정이 유지됩니다.

### 사용 방법

1. PDF, arXiv 논문 또는 웹페이지를 열고 확장 아이콘을 클릭합니다.
2. 필요하면 **Settings**에서 노트북, 아티팩트, 사용 환경 설정을 조정합니다.
3. 감지된 소스를 사용하거나 로컬 PDF를 선택해 생성을 시작합니다.
4. 진행 상태를 확인하고 완료 후 **Open Notebook in NotebookLM**을 클릭합니다.

### 설정

| 영역 | 기능 |
| --- | --- |
| **Notebook Settings** | 새 노트북을 추가할 컬렉션과 감지한 논문 제목 사용 여부 |
| **Artifact Settings** | 생성할 아티팩트와 형식, 길이, 언어, 스타일, 사용자 지침 |
| **Experience** | 데스크톱 알림, 완료 차임, 완료된 노트북 자동 열기 |

컬렉션 추가에 실패해도 소스 처리와 아티팩트 생성은 계속됩니다. 컬렉션 목록은 현재 로그인한 NotebookLM 계정에서 불러옵니다.

### 권한 및 문제 해결

- 로컬 `file://` PDF를 읽으려면 확장 프로그램 세부정보에서 **파일 URL에 대한 액세스 허용**을 켜야 할 수 있습니다.
- 시작되지 않으면 [NotebookLM](https://notebook.google.com)의 로그인 상태를 확인하고 다시 시도합니다.
- 컬렉션이 보이지 않으면 NotebookLM에서 컬렉션을 만든 뒤 설정의 새로고침 버튼을 클릭합니다.
- URL 소스를 추가하지 못하면 **Upload Local PDF**로 파일을 직접 업로드합니다.

---

## English

### Highlights

- Detects PDFs, arXiv papers, and webpages in the current tab and adds them to NotebookLM.
- Supports remote and local PDF uploads and extracts trustworthy paper titles from PDF metadata.
- Can automatically add each new notebook to a selected existing NotebookLM collection.
- Can prefer the detected paper title or let NotebookLM choose the notebook title.
- Generates any combination of audio, video, reports, quizzes, flashcards, infographics, slide decks, mind maps, and data tables.
- Continues in the background when the popup closes, with optional notifications, a completion chime, and automatic notebook opening.

### Install

1. Under **Assets** on the [latest release](https://github.com/mahlernim/chrome-pdf-to-notebooklm/releases/latest), download `chrome-pdf-to-notebooklm-v1.2.0.zip`. GitHub's automatically generated **Source code** archives are not install-ready extensions.
2. Extract the ZIP into a folder you will keep.
3. Open `chrome://extensions` and enable **Developer mode**.
4. Click **Load unpacked** and select the extracted folder containing `manifest.json`.
5. Sign in to [NotebookLM](https://notebook.google.com).

### Update

Extract the new release over the existing extension folder, then click the extension's **Reload** button on `chrome://extensions`. Reusing the same folder preserves your settings.

### Use

1. Open a PDF, arXiv paper, or webpage and click the extension icon.
2. If needed, open **Settings** and configure notebook, artifact, and experience options.
3. Start with the detected source or choose a local PDF.
4. Follow progress and click **Open Notebook in NotebookLM** when complete.

### Settings

| Section | Controls |
| --- | --- |
| **Notebook Settings** | Destination collection and whether to prefer the detected paper title |
| **Artifact Settings** | Artifact selection, format, length, language, style, and custom instructions |
| **Experience** | Desktop notifications, completion chime, and automatic notebook opening |

Source processing and artifact generation continue if collection assignment fails. Collections are loaded from the currently signed-in NotebookLM account.

### Permissions and troubleshooting

- To read local `file://` PDFs, enable **Allow access to file URLs** in the extension's details.
- If a run does not start, confirm that you are signed in at [NotebookLM](https://notebook.google.com) and retry.
- If a collection is missing, create it in NotebookLM and use the refresh button in Settings.
- If a URL source cannot be added, use **Upload Local PDF** to upload the file directly.

## Credits

The NotebookLM protocol implementation was heavily informed by [`teng-lin/notebooklm-py`](https://github.com/teng-lin/notebooklm-py).

## License

MIT. See [LICENSE](./LICENSE).
