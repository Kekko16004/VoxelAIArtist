"""Server MCP di VoxelAIArtist: l'app intera esposta come strumenti.

Perche' il pacchetto si chiama `mcp_server` e non `mcp`: il pacchetto PyPI
ufficiale del protocollo si importa proprio come `mcp`, e una cartella `mcp/`
nella radice del repo lo OMBREGGEREBBE appena la radice entra in `sys.path`
(cosa che `main.py` fa di suo, e che fa anche l'avvio `python -m ...`). Il
sintomo sarebbe un ImportError su `mcp.server` difficile da attribuire.

Il server NON avvia la GUI e non parla col server HTTP dell'app: riusa i moduli
di `src/` (l'espansore delle ops, il client AI multi-provider, le impostazioni)
e tiene il documento in memoria. Cosi' un client MCP puo' lavorare a testa bassa
senza una finestra aperta, e i file che produce sono gli stessi che la GUI apre.
"""

__all__ = ["__version__"]

__version__ = "1.0.0"
