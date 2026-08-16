// =======================================================================
//  13 - Boot
// =======================================================================

async function boot() {
    await bootI18n();
    initScene();
    wireUi();
    initEditor();
    wireDragDrop();
    // Carica la demo subito, cosi' c'e' qualcosa da vedere senza AI.
    loadDemo();
    pushHistory();
    populateModels().catch(() => {});
    // Sonda vision in background.
    probeVision().catch(() => {});
    // Settings summary
    apiGet('/api/settings').then(s => {
        appState.settings = s;
        if (s.needsCookies) {
            setStatus(t('status.needsCookies'), 'warn');
        }
    }).catch(() => {});
}

// Avvio quando il DOM e' pronto (siamo gia' a fine body, ma per sicurezza).
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}

// Chiude la IIFE aperta in 00-bootstrap-head.js
})();
