<!-- Candidate only. Apply with the feature release, not to the current published listing. -->
# Usage and page-text recovery candidate store descriptions

Prepared for the existing item `epopghhfmpokhbalmnfcopmplffphdbb`. These descriptions replace older detailed listings when publication is authorized. Titles and short descriptions are in `docs/localization/metadata.json`. Nothing in this document records a submission.

Regenerate UI evidence with `npm run smoke:chrome`, then run `npm run capture:assets`. The latter uses the selector captures from the former. Each locale has a new `screenshot-papers-1280x800.png` under `docs/store-assets/`, plus workflow and settings captures. English workflow and settings images retain their existing top-level paths. Check the submitted version and ZIP digest separately at release time.

## English

After a confirmed webpage import failure, optionally send the original tab’s article text to Google as a text source in the same notebook. Confirm before extraction and grant access to that site. Text may include sign-in-only content. Text is limited to 200 kB. Forms, hidden content and embedded frames are excluded. Article text stays in memory locally. Delete the Google copy in Gemini Notebook. Available compute usage is advisory and expired snapshots are hidden. Server retry waits do not cause uncertain uploads to be repeated.

Scholar Relay imports PDFs, arXiv papers, and webpages into Gemini Notebook (NotebookLM) and generates audio overviews and study materials with your saved preferences.

Select the papers you want. Create separate notebooks or combine up to 20 sources in one notebook, optionally including the current webpage as context. A blue count shows detected papers, including a single paper. Enable automatic detection per site with optional access.

Choose audio, video, reports, quizzes, flashcards, infographics, slides, mind maps, and data tables. Queue up to 20 jobs. Stop a job while keeping or deleting its notebook. Unknown request outcomes are checked without blindly repeating creation or uploads.

The interface supports ten languages and follows Chrome. Output language is separate. Keep Chrome running until generation requests are accepted. Local uploads are limited to 40 MiB. URL import is tried before downloading a PDF.

Sign in to Gemini Notebook. No developer server, ads, or analytics. Optional site access enables detection, title lookup, and PDF downloads. Independent of Google. Service changes may affect compatibility.

## 한국어

확인된 웹페이지 가져오기 실패 후 원래 탭의 본문을 같은 노트북의 텍스트 소스로 Google에 보낼 수 있습니다. 추출 전에 동의하고 해당 사이트 접근 권한을 허용해야 합니다. 로그인 후에만 보이는 내용이 포함될 수 있습니다. 전체 크기는 200 kB로 제한하며 양식, 숨겨진 내용과 프레임은 제외합니다. 본문은 로컬 메모리에만 임시 보관하며 Google 사본은 Gemini Notebook에서 삭제해야 합니다. 제공되는 연산 사용량은 안내용이며 만료된 정보는 숨깁니다. 서버 대기 후에도 결과가 불확실한 업로드는 반복하지 않습니다.

Scholar Relay는 PDF, arXiv 논문과 웹페이지를 Gemini Notebook(NotebookLM)으로 가져오고 저장된 설정으로 오디오 오버뷰와 학습 자료를 생성합니다.

원하는 논문만 선택하세요. 개별 노트북을 만들거나 소스 최대 20개를 하나로 합치고 현재 웹페이지를 배경 자료로 포함할 수 있습니다. 논문이 1개여도 파란색 숫자로 표시하며 선택 권한으로 사이트별 자동 감지를 켤 수 있습니다.

오디오, 동영상, 보고서, 퀴즈, 플래시카드, 인포그래픽, 슬라이드, 마인드맵과 데이터 표를 선택하세요. 작업 최대 20개를 대기열에 저장하고 노트북 유지 또는 삭제를 선택하여 중단할 수 있습니다. 결과가 불확실한 생성이나 업로드 요청은 무작정 반복하지 않습니다.

화면은 Chrome 언어에 따라 10개 언어를 지원하며 결과물 언어는 별도로 설정합니다. 생성 요청이 접수될 때까지 Chrome을 켜 두세요. 로컬 업로드는 40 MiB까지 지원하고 PDF 다운로드 전에 URL 가져오기를 시도합니다.

Gemini Notebook 로그인이 필요합니다. 개발자 서버, 광고와 분석 추적이 없습니다. 사이트 접근은 감지, 제목 조회와 PDF 다운로드에 선택적으로 사용합니다. Google과 무관한 독립 확장 프로그램이며 서비스 변경으로 호환성이 달라질 수 있습니다.

## 日本語

確認されたページ取り込み失敗後、元のタブの本文を同じノートブックのテキストソースとして Google に送信できます。抽出前に同意し、そのサイトへのアクセスを許可してください。ログイン後のみ閲覧できる内容が含まれる場合があります。上限は200 kBで、フォーム、非表示の内容、埋め込みフレームは除外します。本文はローカルではメモリにのみ保持します。Google側のコピーは Gemini Notebook で削除してください。計算使用量は参考情報で、期限切れの情報は非表示になります。サーバーの待機後も結果不明のアップロードは繰り返しません。

Scholar Relay は PDF、arXiv 論文、ウェブページを Gemini Notebook（NotebookLM）に取り込み、保存した設定で音声解説や学習資料を生成します。

必要な論文だけを選択し、個別のノートブックか最大20件のソースをまとめた1つのノートブックを作成できます。現在のページも背景資料として追加できます。論文が1件でも青い数字で表示し、任意のサイト権限で自動検出を有効にできます。

音声、動画、レポート、クイズ、フラッシュカード、インフォグラフィック、スライド、マインドマップ、データ表に対応。最大20件をキューに保存でき、ノートブックを残すか削除して停止できます。結果が不明な作成やアップロードを無条件に繰り返しません。

画面は Chrome に合わせて10言語に対応し、生成言語は別設定です。生成要求が受理されるまで Chrome を起動したままにしてください。ローカルアップロードは40 MiBまで。PDFのダウンロード前にURLの取り込みを試します。

Gemini Notebookへのログインが必要です。開発者サーバー、広告、分析追跡はありません。検出、タイトル取得、PDFダウンロードには任意のサイト権限を使用します。Googleとは無関係の拡張機能で、サービス変更が互換性に影響する場合があります。

## Español

Tras un fallo confirmado al importar una página, puedes enviar el texto de la pestaña original a Google como fuente de texto en el mismo cuaderno. Confirma antes de extraerlo y concede acceso al sitio. Puede incluir contenido que requiere iniciar sesión. El límite es de 200 kB y se excluyen formularios, contenido oculto y marcos incrustados. El texto solo se mantiene en memoria local. Elimina la copia de Google en Gemini Notebook. El uso de cómputo es orientativo y los datos vencidos se ocultan. Las esperas del servidor no provocan cargas repetidas de resultado incierto.

Scholar Relay importa PDF, artículos de arXiv y páginas web a Gemini Notebook (NotebookLM) y genera resúmenes de audio y materiales de estudio con tus preferencias guardadas.

Selecciona los artículos que quieras. Crea cuadernos separados o combina hasta 20 fuentes en uno, incluyendo opcionalmente la página como contexto. Un número azul muestra los artículos detectados, incluso uno solo. Activa la detección automática por sitio con acceso opcional.

Elige audio, vídeo, informes, cuestionarios, tarjetas de estudio, infografías, diapositivas, mapas mentales y tablas. Guarda hasta 20 tareas en la cola. Detén una tarea conservando o eliminando su cuaderno. Los resultados inciertos no provocan repeticiones ciegas de creación o carga.

La interfaz sigue Chrome y admite diez idiomas. El idioma de salida es independiente. Mantén Chrome abierto hasta que se acepten las solicitudes de generación. Las cargas locales tienen un límite de 40 MiB. Se intenta importar la URL antes de descargar el PDF.

Requiere iniciar sesión en Gemini Notebook. Sin servidor del desarrollador, anuncios ni analítica. El acceso opcional permite detectar artículos, buscar títulos y descargar PDF. Independiente de Google. Los cambios del servicio pueden afectar a la compatibilidad.

## Français

Après un échec confirmé d’importation, vous pouvez envoyer le texte de l’onglet d’origine à Google comme source textuelle dans le même notebook. Confirmez avant l’extraction et autorisez l’accès au site. Le texte peut inclure du contenu réservé aux utilisateurs connectés. La limite est de 200 kB, hors formulaires, contenu masqué et cadres intégrés. Le texte reste uniquement en mémoire locale. Supprimez la copie Google dans Gemini Notebook. L’utilisation du calcul est indicative et les données expirées sont masquées. L’attente serveur ne relance pas les envois au résultat incertain.

Scholar Relay importe des PDF, articles arXiv et pages web dans Gemini Notebook (NotebookLM) et génère des résumés audio et supports d’étude avec vos préférences enregistrées.

Sélectionnez les articles souhaités. Créez des notebooks séparés ou réunissez jusqu’à 20 sources dans un notebook, avec la page actuelle comme contexte facultatif. Un nombre bleu indique les articles détectés, même un seul. Activez la détection automatique par site avec une autorisation facultative.

Choisissez audio, vidéo, rapports, quiz, fiches, infographies, diapositives, cartes mentales et tableaux. Placez jusqu’à 20 tâches dans la file. Arrêtez une tâche en conservant ou supprimant son notebook. Un résultat incertain ne déclenche pas de nouvelle création ou importation à l’aveugle.

L’interface suit Chrome et prend en charge dix langues. La langue des contenus est indépendante. Gardez Chrome ouvert jusqu’à l’acceptation des demandes de génération. Les fichiers locaux sont limités à 40 MiB. L’importation par URL précède le téléchargement du PDF.

Connectez-vous à Gemini Notebook. Aucun serveur du développeur, publicité ou suivi analytique. L’accès facultatif sert à détecter les articles, rechercher leurs titres et télécharger les PDF. Indépendant de Google. Les évolutions du service peuvent affecter la compatibilité.

## Deutsch

Nach einem bestätigten Webseitenimportfehler können Sie den Text des ursprünglichen Tabs als Textquelle im selben Notizbuch an Google senden. Bestätigen Sie vor der Extraktion und erlauben Sie den Zugriff auf diese Website. Der Text kann nur nach Anmeldung zugängliche Inhalte enthalten. Es gilt ein Limit von 200 kB. Formulare, verborgene Inhalte und eingebettete Frames werden ausgeschlossen. Lokal bleibt der Text nur im Arbeitsspeicher. Löschen Sie die Google-Kopie in Gemini Notebook. Die Rechennutzung dient als Hinweis, abgelaufene Daten werden ausgeblendet. Serverwartezeiten führen nicht zur Wiederholung unbestätigter Uploads.

Scholar Relay importiert PDFs, arXiv-Artikel und Webseiten in Gemini Notebook (NotebookLM) und erstellt Audio-Zusammenfassungen und Lernmaterialien mit gespeicherten Einstellungen.

Wählen Sie die gewünschten Artikel aus. Erstellen Sie separate Notebooks oder vereinen Sie bis zu 20 Quellen in einem Notebook, optional mit der aktuellen Webseite als Kontext. Eine blaue Zahl zeigt erkannte Artikel an, auch einen einzelnen. Die automatische Erkennung lässt sich je Website mit optionalem Zugriff aktivieren.

Wählen Sie Audio, Video, Berichte, Quiz, Lernkarten, Infografiken, Folien, Mindmaps und Tabellen. Speichern Sie bis zu 20 Aufgaben in der Warteschlange. Stoppen Sie eine Aufgabe und behalten oder löschen Sie ihr Notebook. Ungewisse Ergebnisse führen nicht zum blinden Wiederholen von Erstellung oder Upload.

Die Oberfläche folgt Chrome und unterstützt zehn Sprachen. Die Ausgabesprache wird getrennt gewählt. Lassen Sie Chrome bis zur Annahme der Generierungsanfragen geöffnet. Lokale Uploads sind auf 40 MiB begrenzt. Vor einem PDF-Download wird der URL-Import versucht.

Die Anmeldung bei Gemini Notebook ist erforderlich. Kein Entwicklerserver, keine Werbung oder Analyseverfolgung. Optionaler Websitezugriff dient der Erkennung, Titelsuche und PDF-Downloads. Unabhängig von Google. Dienständerungen können die Kompatibilität beeinflussen.

## Português brasileiro

Após uma falha confirmada na importação de uma página, você pode enviar o texto da aba original ao Google como fonte de texto no mesmo notebook. Confirme antes da extração e permita o acesso ao site. O texto pode incluir conteúdo acessível apenas após login. O limite é de 200 kB, excluindo formulários, conteúdo oculto e quadros incorporados. O texto fica apenas na memória local. Exclua a cópia do Google no Gemini Notebook. O uso de computação é informativo e dados expirados são ocultados. Esperas do servidor não repetem envios com resultado incerto.

O Scholar Relay importa PDFs, artigos do arXiv e páginas da web para o Gemini Notebook (NotebookLM) e gera resumos de áudio e materiais de estudo com suas preferências salvas.

Selecione os artigos desejados. Crie notebooks separados ou reúna até 20 fontes em um notebook, incluindo opcionalmente a página atual como contexto. Um número azul mostra os artigos detectados, mesmo que seja apenas um. Ative a detecção automática por site com acesso opcional.

Escolha áudio, vídeo, relatórios, questionários, cartões de estudo, infográficos, slides, mapas mentais e tabelas. Salve até 20 tarefas na fila. Interrompa uma tarefa mantendo ou excluindo seu notebook. Resultados incertos não causam repetição indiscriminada de criação ou envio.

A interface segue o Chrome e oferece dez idiomas. O idioma dos conteúdos é independente. Mantenha o Chrome aberto até as solicitações de geração serem aceitas. Envios locais têm limite de 40 MiB. A importação por URL é tentada antes do download do PDF.

Entre no Gemini Notebook. Sem servidor do desenvolvedor, anúncios ou análise de uso. O acesso opcional permite detectar artigos, buscar títulos e baixar PDFs. Independente do Google. Mudanças no serviço podem afetar a compatibilidade.

## 简体中文

网页导入失败且原因已确认后，可将原始标签页正文作为文本来源发送给 Google 并加入同一笔记本。提取前须确认并授予该网站访问权限。正文可能包含仅登录后可见的内容。大小上限为 200 kB，排除表单、隐藏内容和嵌入框架。正文仅临时保存在本地内存中，Google 的副本需在 Gemini Notebook 中删除。计算用量仅供参考，过期信息会隐藏。服务器等待不会导致重复执行结果不确定的上传。

Scholar Relay 将 PDF、arXiv 论文和网页导入 Gemini Notebook（NotebookLM），并根据已保存的设置生成音频概览和学习资料。

选择需要的论文，分别创建笔记本，或将最多 20 个来源合并到一个笔记本中，也可将当前网页作为背景资料。蓝色数字显示检测到的论文数量，只有 1 篇也会显示。授予可选权限后，可按网站启用自动检测。

支持音频、视频、报告、测验、闪卡、信息图、幻灯片、思维导图和数据表。队列可保存最多 20 个任务。停止任务时可选择保留或删除笔记本。结果不确定时，不会盲目重复创建或上传。

界面跟随 Chrome 语言，支持十种语言。输出语言独立设置。请保持 Chrome 运行，直到生成请求被接受。本地上传限制为 40 MiB。下载 PDF 前会先尝试通过 URL 导入。

需要登录 Gemini Notebook。没有开发者服务器、广告或分析跟踪。可选网站权限用于检测论文、查询标题和下载 PDF。本扩展独立于 Google，服务变更可能影响兼容性。

## Italiano

Dopo un errore confermato di importazione di una pagina, puoi inviare il testo della scheda originale a Google come fonte di testo nello stesso notebook. Conferma prima dell’estrazione e autorizza l’accesso al sito. Il testo può includere contenuti riservati agli utenti autenticati. Il limite è di 200 kB, escludendo moduli, contenuti nascosti e frame incorporati. Il testo resta solo nella memoria locale. Elimina la copia Google in Gemini Notebook. L’utilizzo del calcolo è indicativo e i dati scaduti vengono nascosti. Le attese del server non ripetono caricamenti dall’esito incerto.

Scholar Relay importa PDF, articoli arXiv e pagine web in Gemini Notebook (NotebookLM) e genera panoramiche audio e materiali di studio con le tue preferenze salvate.

Seleziona gli articoli desiderati. Crea notebook separati o riunisci fino a 20 fonti in un notebook, includendo facoltativamente la pagina corrente come contesto. Un numero blu mostra gli articoli rilevati, anche uno solo. Attiva il rilevamento automatico per sito con accesso facoltativo.

Scegli audio, video, report, quiz, schede didattiche, infografiche, presentazioni, mappe mentali e tabelle di dati. Salva fino a 20 attività nella coda. Interrompi un’attività conservando o eliminando il notebook. I risultati incerti non causano ripetizioni indiscriminate di creazione o caricamento.

L’interfaccia segue Chrome e supporta dieci lingue. La lingua dei contenuti è indipendente. Lascia Chrome aperto finché le richieste di generazione non vengono accettate. I caricamenti locali sono limitati a 40 MiB. L’importazione tramite URL precede il download del PDF.

Accedi a Gemini Notebook. Nessun server dello sviluppatore, nessuna pubblicità né analisi dell’utilizzo. L’accesso facoltativo ai siti serve a rilevare articoli, cercare titoli e scaricare PDF. Indipendente da Google. Le modifiche al servizio possono influire sulla compatibilità.

## 繁體中文

網頁匯入失敗且原因已確認後，可將原始分頁內文作為文字來源傳送給 Google 並加入同一筆記本。擷取前須確認並授予該網站存取權限。內文可能包含僅登入後可見的內容。大小上限為 200 kB，排除表單、隱藏內容和嵌入框架。內文僅暫存於本機記憶體，Google 的副本須在 Gemini Notebook 中刪除。運算用量僅供參考，過期資訊會隱藏。伺服器等候不會導致重複執行結果不確定的上傳。

Scholar Relay 可將 PDF、arXiv 論文和網頁匯入 Gemini Notebook（NotebookLM），並依照已儲存的設定生成語音摘要和學習資料。

只選擇需要的論文，可分別建立筆記本，或將最多 20 個來源合併到一個筆記本，也能把目前的網頁納入為背景資料。偵測到的論文數量會以藍色數字顯示，只有 1 篇也會顯示。授予選用權限後，可依網站啟用自動偵測。

支援語音摘要、影片摘要、報告、測驗、學習卡、資訊圖表、簡報、心智圖和資料表。佇列最多可儲存 20 項工作。停止工作時可選擇保留或刪除筆記本。結果不確定時，不會盲目重複建立或上傳。

介面跟隨 Chrome 語言，支援十種語言。工作室內容語言可另外設定。請保持 Chrome 執行，直到生成要求被接受。本機上傳上限為 40 MiB。下載 PDF 前會先嘗試透過網址匯入。

需要登入 Gemini Notebook。沒有開發者伺服器、廣告或分析追蹤。選用的網站存取權限用於偵測論文、查詢標題和下載 PDF。本擴充功能與 Google 無關，服務變更可能影響相容性。
