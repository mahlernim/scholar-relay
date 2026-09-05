export const DEFAULT_SETTINGS = {
    // Audio
    generateAudio: true,
    audioFormat: 'deep_dive',   // 'deep_dive'|'brief'|'critique'|'debate'
    audioLength: 'long',        // 'short'|'default'|'long'
    language: 'en',
    audioPrompt: '',
    // Video
    generateVideo: false,
    videoFormat: 'explainer',   // 'explainer'|'brief'
    videoStyle: 'auto',        // 'auto'|'custom'|'classic'|'whiteboard'|'kawaii'|'anime'|'watercolor'|'retro_print'|'heritage'|'paper_craft'
    videoPrompt: '',
    videoStylePrompt: '',
    // Report
    generateReport: false,
    reportFormat: 'study_guide', // 'briefing_doc'|'study_guide'|'blog_post'|'custom'
    reportPrompt: '',
    // Quiz
    generateQuiz: false,
    quizQuantity: 'standard',    // 'fewer'|'standard'|'more'
    quizDifficulty: 'medium',      // 'easy'|'medium'|'hard'
    quizPrompt: '',
    // Flashcards
    generateFlashcards: false,
    flashcardsQuantity: 'standard',
    flashcardsDifficulty: 'medium',
    flashcardsPrompt: '',
    // Infographic
    generateInfographic: true,
    infographicOrientation: 'landscape', // 'landscape'|'portrait'|'square'
    infographicDetail: 'standard',       // 'concise'|'standard'|'detailed'
    infographicStylePreset: 'auto',
    infographicNativeStyle: 'auto',
    infographicPrompt: '',
    // Slide deck
    generateSlideDeck: false,
    slideDeckFormat: 'detailed_deck',   // 'detailed_deck'|'presenter_slides'
    slideDeckLength: 'default',         // 'default'|'short'
    slideDeckPrompt: '',
    // Mind map
    generateMindMap: false,
    // Data table
    generateDataTable: false,
    dataTablePrompt: '',
    // UX
    notificationEnabled: true,
    chimeEnabled: true,
    autoOpenNotebook: false,
    useSourceTitleForNotebook: true,
    collectionId: '',
};
