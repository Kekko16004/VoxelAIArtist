"""Tema (QSS) per la chrome PyQt6 nativa.

Ricostruisce i design token della UI HTML (vedi :root in
ui/src/index.template.html) come foglio di stile Qt, cosi' i pannelli nativi
che via via sostituiscono la webview hanno lo stesso look.

NOTA: `backdrop-filter: blur()` non esiste in QSS -> l'effetto "vetro" si
approssima con sfondi semi-trasparenti. Nessun import Qt qui: solo stringhe.
"""

# Token tema scuro (specchio di index.template.html)
DARK = {
    "bg":            "#0b0814",
    "text":          "#f3f4f6",
    "text_muted":    "#9ca3af",
    "accent":        "#475569",
    "accent_2":      "#64748b",
    "glass_border":  "rgba(255, 255, 255, 0.10)",
    "input_bg":      "rgba(0, 0, 0, 0.35)",
    "hover":         "rgba(255, 255, 255, 0.06)",
    "hover_strong":  "rgba(255, 255, 255, 0.12)",
    "danger":        "#ef4444",
}


def dark_qss():
    """Ritorna il QSS del tema scuro per QDialog/QWidget nativi."""
    t = DARK
    return f"""
    QDialog, QWidget#nativeRoot {{
        background-color: {t['bg']};
        color: {t['text']};
    }}
    QWidget {{ color: {t['text']}; font-size: 13px; }}
    QLabel#title {{ font-size: 18px; font-weight: 700; }}
    QLabel#sectionTitle {{ font-size: 11px; font-weight: 700; color: {t['text_muted']}; }}
    QLabel#muted {{ color: {t['text_muted']}; }}
    QLineEdit {{
        background: {t['input_bg']};
        border: 1px solid {t['glass_border']};
        border-radius: 2px; padding: 7px 9px; color: {t['text']};
    }}
    QLineEdit:focus {{ border-color: {t['accent_2']}; }}
    QPushButton {{
        background: {t['hover']};
        border: 1px solid {t['glass_border']};
        border-radius: 2px; padding: 8px 14px; color: {t['text']};
    }}
    QPushButton:hover {{ background: {t['hover_strong']}; }}
    QPushButton#primary {{ background: {t['accent']}; border: none; color: #ffffff; font-weight: 600; }}
    QPushButton#primary:hover {{ background: {t['accent_2']}; }}
    QFrame#sep {{ background: {t['glass_border']}; max-height: 1px; border: none; }}
    """
