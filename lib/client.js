/**
 * dsh-openrouter-imagen v2 — Client half.
 *
 * A workspace of its own, NOT a conversation surface. Two registrations:
 *
 *   1. `sidebar.panellist` — the entry, sitting with the sidebar's global panel
 *      icons (i.e. under the 插件 group). A list slot, additive, replaceRisk
 *      none.
 *   2. `main` — a keyed slot ("the central panel selected by sidebar entry
 *      id"), registered under key `imagen`. Clicking the entry selects it, and
 *      the whole central area becomes this workspace instead of the chat.
 *
 * The layout is the reviewed one: two columns with a draggable split (default
 * 60/40). Left = picture area (large current image + 5-image history strip +
 * a draggable-height parameters block, default 236px). Right = the conversation.
 *
 * Self-contained by hand, no bundler: the client module system wraps this in a
 * CJS factory and the kernel adopts `{ apply, inject }`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-openrouter-imagen-v2',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.for('Module.toStringTag'), { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const API = '/openrouter-imagen-v2/api'
    const PANEL_KEY = 'imagen'
    const HISTORY_MAX = 5

    /** The same lists the Host validates against — one source of truth per side. */
    const ASPECTS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9', '9:21']
    const RESOLUTIONS = ['auto', '512', '1K', '2K', '4K']
    const QUALITIES = ['auto', 'low', 'medium', 'high']
    const FORMATS = ['png', 'jpeg', 'webp']
    const BACKGROUNDS = ['auto', 'transparent', 'opaque']

    const CSS = `
.dsh-iv-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;background:var(--dsw-alias-bg-base)}
.dsh-iv-head{display:flex;align-items:center;gap:10px;padding:10px 16px;flex:0 0 auto;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-iv-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:0 0 auto}
.dsh-iv-dot[data-state="busy"]{background:var(--dsw-alias-state-warn-primary);animation:dsh-iv-pulse 1.1s ease-in-out infinite}
.dsh-iv-dot[data-state="ok"]{background:var(--dsw-alias-state-success-primary)}
.dsh-iv-dot[data-state="err"]{background:var(--dsw-alias-state-error-primary)}
@keyframes dsh-iv-pulse{50%{opacity:.35}}
.dsh-iv-title{font-size:14px;font-weight:650;margin:0}
.dsh-iv-meta{color:var(--dsw-alias-label-secondary);font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-iv-spacer{flex:1 1 auto}
.dsh-iv-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:999px;padding:3px 10px;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;max-width:100%;overflow:hidden}
.dsh-iv-chip b{color:var(--dsw-alias-label-primary);font-weight:600;overflow:hidden;text-overflow:ellipsis}
.dsh-iv-chip-ok{border-color:#a7e8c4;background:#f0fdf5;color:#067647}
.dsh-iv-chip-err{border-color:#fda29b;background:#fef3f2;color:#b42318}

.dsh-iv-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:999px;padding:5px 13px;font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap}
.dsh-iv-btn:hover:not([disabled]){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dsh-iv-btn[disabled]{opacity:.5;cursor:not-allowed}
.dsh-iv-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary);padding:4px 9px}
.dsh-iv-btn-ghost:hover:not([disabled]){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-iv-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;font-weight:600}
.dsh-iv-btn-primary:hover:not([disabled]){background:#0a5fe0;border-color:#0a5fe0;color:#fff}
.dsh-iv-btn-sm{padding:4px 10px;font-size:11.5px}

/* ---- two columns with a draggable split ---- */
.dsh-iv-work{flex:1 1 auto;display:flex;min-height:0;min-width:0}
.dsh-iv-left{flex:0 0 var(--dsh-iv-left,60%);width:var(--dsh-iv-left,60%);min-width:340px;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-layer-1)}
.dsh-iv-right{flex:1 1 auto;min-width:300px;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-layer-1)}
.dsh-iv-split{flex:0 0 6px;position:relative;cursor:col-resize;background:transparent;border:0;padding:0;margin:0}
.dsh-iv-split::before{content:"";position:absolute;inset:0 2px;background:var(--dsw-alias-border-l1)}
.dsh-iv-split:hover::before,.dsh-iv-split:focus-visible::before,.dsh-iv-split[data-drag="1"]::before{background:var(--dsw-alias-brand-primary)}
.dsh-iv-split::after{content:"";position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:2px;height:34px;border-radius:2px;background:var(--dsw-alias-border-l2)}
.dsh-iv-split:hover::after,.dsh-iv-split[data-drag="1"]::after{background:var(--dsw-alias-brand-primary)}
body[data-dsh-iv-resizing-x]{cursor:col-resize;user-select:none}
.dsh-iv-hsplit{flex:0 0 7px;position:relative;cursor:row-resize;background:var(--dsw-alias-bg-base);border:0;padding:0;margin:0;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-iv-hsplit::after{content:"";position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:34px;height:2px;border-radius:2px;background:var(--dsw-alias-border-l2)}
.dsh-iv-hsplit:hover::after,.dsh-iv-hsplit:focus-visible::after,.dsh-iv-hsplit[data-drag="1"]::after{background:var(--dsw-alias-brand-primary)}
body[data-dsh-iv-resizing-y]{cursor:row-resize;user-select:none}

/* ---- picture area ---- */
.dsh-iv-stage{flex:1 1 auto;display:flex;flex-direction:column;min-height:0}
.dsh-iv-stagehead{display:flex;align-items:center;gap:8px;padding:9px 14px;flex:0 0 auto;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.dsh-iv-stagebody{flex:1 1 auto;min-height:220px;padding:14px;display:grid;place-items:center;background-image:linear-gradient(45deg,rgba(0,0,0,.022) 25%,transparent 25%,transparent 75%,rgba(0,0,0,.022) 75%),linear-gradient(45deg,rgba(0,0,0,.022) 25%,transparent 25%,transparent 75%,rgba(0,0,0,.022) 75%);background-size:22px 22px;background-position:0 0,11px 11px}
.dsh-iv-figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:9px;max-width:100%;max-height:100%;min-height:0}
.dsh-iv-img{max-width:100%;max-height:100%;min-height:0;object-fit:contain;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);box-shadow:0 6px 22px rgba(15,23,42,.10);cursor:zoom-in;display:block}
.dsh-iv-cap{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center;font-size:11.5px;color:var(--dsw-alias-label-secondary);max-width:100%}
.dsh-iv-cap code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:1px 6px}
.dsh-iv-strip{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:9px 14px;overflow-x:auto;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);min-height:0}
.dsh-iv-striplabel{flex:0 0 auto;font-size:10.5px;font-weight:650;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin-right:2px}
.dsh-iv-thumb{position:relative;width:54px;height:54px;flex:0 0 auto;border-radius:8px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);padding:0;cursor:pointer;font:inherit;line-height:0;opacity:.72;transition:opacity .14s ease}
.dsh-iv-thumb:hover{opacity:1}
.dsh-iv-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.dsh-iv-thumb[aria-current="true"]{border-color:var(--dsw-alias-brand-primary);border-width:2px;opacity:1}
.dsh-iv-thumbtag{position:absolute;left:2px;bottom:2px;background:rgba(17,24,39,.75);color:#fff;border-radius:4px;padding:0 4px;font-size:9px;font-weight:600;line-height:13px}
.dsh-iv-more{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}

/* ---- parameters ---- */
.dsh-iv-params{flex:0 0 auto;height:var(--dsh-iv-params,236px);border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);display:flex;flex-direction:column;min-height:0}
.dsh-iv-panehead{display:flex;align-items:center;gap:8px;padding:8px 14px;flex:0 0 auto;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;font-weight:650;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.dsh-iv-paramsbody{flex:1 1 auto;overflow:auto;min-height:0;padding:10px 14px 12px;display:flex;flex-direction:column;gap:9px}
.dsh-iv-row{display:flex;align-items:center;gap:10px;min-width:0}
.dsh-iv-label{flex:0 0 72px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-iv-ctl{flex:1 1 auto;min-width:0;display:flex;gap:6px;align-items:center}
.dsh-iv-ratios{display:flex;flex-wrap:wrap;gap:5px}
.dsh-iv-ratio{min-width:42px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:4px 5px;font:inherit;line-height:1}
.dsh-iv-ratio:hover{border-color:var(--dsw-alias-border-l2)}
.dsh-iv-ratio[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);background:#f2f7ff}
.dsh-iv-ratio span:first-child{display:block;border:1.5px solid var(--dsw-alias-label-secondary);border-radius:2px}
.dsh-iv-ratio[aria-pressed="true"] span:first-child{border-color:var(--dsw-alias-brand-primary)}
.dsh-iv-rationum{font-size:9.5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-iv-ratio[aria-pressed="true"] .dsh-iv-rationum{color:var(--dsw-alias-brand-primary);font-weight:700}
.dsh-iv-seg{display:flex;gap:3px;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:3px;border:1px solid var(--dsw-alias-border-l1);flex:1 1 auto;min-width:0}
.dsh-iv-seg button{flex:1 1 0;border:0;background:transparent;border-radius:6px;padding:4px 6px;font:inherit;font-size:11.5px;cursor:pointer;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-iv-seg button[aria-pressed="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(15,23,42,.08)}
.dsh-iv-switch{position:relative;display:inline-block;width:38px;height:21px;flex:0 0 auto;cursor:pointer}
.dsh-iv-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.dsh-iv-track{position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-border-l2);border:1px solid var(--dsw-alias-border-l1);transition:background .18s ease,border-color .18s ease}
.dsh-iv-track::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .18s ease}
.dsh-iv-switch input:checked + .dsh-iv-track{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dsh-iv-switch input:checked + .dsh-iv-track::after{left:19px}
.dsh-iv-pfoot{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1);padding:8px 14px;display:flex;flex-direction:column;gap:5px;background:var(--dsw-alias-bg-layer-1)}
.dsh-iv-cost{font-size:11.5px;color:var(--dsw-alias-label-secondary);display:flex;justify-content:space-between;gap:8px}
.dsh-iv-cost b{color:var(--dsw-alias-label-primary);font-weight:600}

input.dsh-iv-in,select.dsh-iv-in,textarea.dsh-iv-in{width:100%;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:7px 9px;outline:none;line-height:1.5}
input.dsh-iv-in:focus,select.dsh-iv-in:focus,textarea.dsh-iv-in:focus{border-color:var(--dsw-alias-brand-primary)}
textarea.dsh-iv-in{resize:vertical;min-height:62px;font-family:inherit}
textarea.dsh-iv-in[data-mono="1"]{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.55}

/* ---- conversation column ---- */
.dsh-iv-convo{flex:1 1 auto;display:flex;flex-direction:column;min-height:0}
.dsh-iv-scroll{flex:1 1 auto;overflow:auto;min-height:0;padding:12px 14px;display:flex;flex-direction:column;gap:11px}
.dsh-iv-msg{display:flex;flex-direction:column;gap:5px;max-width:100%}
.dsh-iv-role{font-size:11px;font-weight:650;color:var(--dsw-alias-label-secondary)}
.dsh-iv-body{border:1px solid var(--dsw-alias-border-l1);border-radius:11px;padding:8px 11px;background:var(--dsw-alias-bg-base);white-space:pre-wrap;word-break:break-word;font-size:12.5px}
.dsh-iv-msg-user .dsh-iv-body{background:#eef4ff;border-color:#cfe0ff}
.dsh-iv-note{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dsh-iv-prompt{border:1px solid #cfe0ff;background:#f7faff;border-radius:11px;overflow:hidden}
.dsh-iv-prompthead{display:flex;align-items:center;gap:7px;padding:6px 11px;font-size:11.5px;font-weight:650;color:#1d4ed8;background:#eef4ff;border-bottom:1px solid #cfe0ff}
.dsh-iv-promptbody{padding:8px 11px;font-size:12px;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;line-height:1.55;max-height:260px;overflow:auto}
.dsh-iv-promptfoot{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:6px 11px;border-top:1px solid #cfe0ff;background:#f7faff}
.dsh-iv-paramsline{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-secondary);min-width:0}
.dsh-iv-tool{display:flex;align-items:center;gap:8px;padding:7px 11px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-iv-spin{width:11px;height:11px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;flex:0 0 auto;animation:dsh-iv-spin .8s linear infinite}
@keyframes dsh-iv-spin{to{transform:rotate(360deg)}}
.dsh-iv-err{border:1px solid #fda29b;background:#fef3f2;color:#b42318;border-radius:10px;padding:8px 11px;font-size:12px;white-space:pre-wrap;word-break:break-word}

.dsh-iv-compose{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1);padding:12px 12px 14px;display:flex;flex-direction:column;gap:9px;background:var(--dsw-alias-bg-base)}
.dsh-iv-tabs{display:flex;gap:4px;background:var(--dsw-alias-bg-layer-2);border-radius:9px;padding:3px;border:1px solid var(--dsw-alias-border-l1)}
.dsh-iv-tabs button{flex:1 1 0;border:0;background:transparent;border-radius:7px;padding:5px 8px;font:inherit;font-size:12px;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dsh-iv-tabs button[aria-pressed="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(15,23,42,.08)}
.dsh-iv-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.dsh-iv-fieldlabel{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsh-iv-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.45}
.dsh-iv-refs{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.dsh-iv-ref{position:relative;width:44px;height:44px;border-radius:9px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;background:var(--dsw-alias-bg-layer-2)}
.dsh-iv-ref img{width:100%;height:100%;object-fit:cover;display:block}
.dsh-iv-refx{position:absolute;top:1px;right:1px;width:15px;height:15px;border-radius:50%;border:0;background:rgba(17,24,39,.72);color:#fff;font-size:10px;line-height:15px;text-align:center;cursor:pointer;padding:0;font-family:inherit}
.dsh-iv-refadd{width:44px;height:44px;border-radius:9px;border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:17px;line-height:1;flex:0 0 auto;font-family:inherit}
.dsh-iv-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}
.dsh-iv-actions .dsh-iv-spacer{flex:1 1 auto}
/* The per-call model picker: its own row, so the generate button keeps the
   breathing space above it that the reviewed layout asked for. Prefixed
   "callmodel" because dsh-iv-modelrow is the settings catalogue's row class. */
.dsh-iv-callmodel{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}
.dsh-iv-callmodellabel{font-size:12px;color:var(--dsw-alias-label-secondary);flex:0 0 auto}
.dsh-iv-callmodelsel{flex:1 1 200px;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
.dsh-iv-callmodel + .dsh-iv-actions{margin-top:14px}
.dsh-iv-callmodelsel[data-override="1"]{border-color:var(--dsw-alias-brand-primary)}

/* ---- empty / skeleton ---- */
.dsh-iv-empty{display:grid;place-items:center;text-align:center;padding:12px;max-width:440px}
.dsh-iv-emptyin{display:flex;flex-direction:column;align-items:center;gap:10px;max-width:392px}
.dsh-iv-emptyico{width:46px;height:46px;border-radius:14px;background:var(--dsw-alias-bg-layer-2);display:grid;place-items:center;color:var(--dsw-alias-label-secondary)}
.dsh-iv-empty h3{margin:0;font-size:14px;font-weight:650}
.dsh-iv-empty p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.55}
.dsh-iv-hintrow{display:flex;flex-direction:column;gap:6px;width:100%;text-align:left}
.dsh-iv-sugg{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:7px 10px;background:var(--dsw-alias-bg-base);font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;text-align:left;font-family:inherit;width:100%}
.dsh-iv-sugg:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.dsh-iv-sugg b{color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-iv-sk{width:100%;max-width:420px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-base);display:flex;flex-direction:column}
.dsh-iv-skshot{aspect-ratio:1/1;background:linear-gradient(100deg,var(--dsw-alias-bg-layer-2) 30%,#eceef1 50%,var(--dsw-alias-bg-layer-2) 70%);background-size:220% 100%;animation:dsh-iv-shimmer 1.35s ease-in-out infinite}
@keyframes dsh-iv-shimmer{to{background-position:-120% 0}}
.dsh-iv-skcap{padding:9px 11px;font-size:12px;color:var(--dsw-alias-label-secondary)}

/* ---- lightbox ---- */
.dsh-iv-lb{position:fixed;inset:0;background:rgba(9,12,18,.82);display:none;place-items:center;z-index:60;padding:40px}
.dsh-iv-lb[data-open="1"]{display:grid}
.dsh-iv-lb img{max-width:min(1100px,92vw);max-height:80vh;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.5);background:#fff}
.dsh-iv-lbbar{margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:center}
.dsh-iv-lbbar .dsh-iv-chip{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.25);color:#e5e7eb}
.dsh-iv-lbbar .dsh-iv-chip b{color:#fff}
.dsh-iv-lbclose{position:absolute;top:18px;right:22px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.08);color:#fff;border-radius:999px;padding:6px 14px;font:inherit;font-size:12.5px;cursor:pointer}

/* ---- sidebar entry ---- */
.dsh-iv-entry{display:flex;align-items:center;gap:9px;width:100%;padding:7px 9px;border-radius:8px;border:0;background:transparent;font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left}
.dsh-iv-entry:hover{background:rgba(0,0,0,.05)}
.dsh-iv-entry[aria-current="true"]{background:#eaf2ff;color:var(--dsw-alias-brand-primary);font-weight:600}
.dsh-iv-entryicon{display:grid;place-items:center;flex:0 0 auto;color:var(--dsw-alias-label-secondary)}
.dsh-iv-entry[aria-current="true"] .dsh-iv-entryicon{color:var(--dsw-alias-brand-primary)}
.dsh-iv-entrytxt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-iv-entrybadge{margin-left:auto;font-size:10.5px;font-weight:600;border-radius:999px;padding:1px 7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}

/* ---- settings dialog ---- */
.dsh-iv-modal{position:fixed;inset:0;background:rgba(9,12,18,.42);display:none;place-items:center;z-index:70;padding:32px}
.dsh-iv-modal[data-open="1"]{display:grid}
.dsh-iv-dialog{width:min(620px,94vw);max-height:86vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:0 24px 70px rgba(15,23,42,.32);overflow:hidden}
.dsh-iv-dlghead{display:flex;align-items:center;gap:9px;padding:13px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.dsh-iv-dlghead h3{margin:0;font-size:14.5px;font-weight:650}
.dsh-iv-dlgtabs{display:flex;gap:3px;padding:9px 18px 0;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.dsh-iv-dlgtabs button{border:0;background:transparent;font:inherit;font-size:12.5px;color:var(--dsw-alias-label-secondary);padding:7px 11px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.dsh-iv-dlgtabs button[aria-pressed="true"]{color:var(--dsw-alias-brand-primary);font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary)}
.dsh-iv-dlgbody{flex:1 1 auto;overflow:auto;min-height:0;padding:16px 18px;display:flex;flex-direction:column;gap:14px}
.dsh-iv-field-h{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsh-iv-flabel{font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:7px}
.dsh-iv-fhelp{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.dsh-iv-keyrow{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.dsh-iv-keyrow input{flex:1 1 260px;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dsh-iv-badge{font-size:10.5px;font-weight:650;border-radius:999px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dsh-iv-badge-ok{border-color:#a7e8c4;background:#f0fdf5;color:#067647}
.dsh-iv-badge-err{border-color:#fda29b;background:#fef3f2;color:#b42318}
.dsh-iv-badge-warn{border-color:#fedf89;background:#fffaeb;color:#b54708}
.dsh-iv-dlgfoot{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:12px 18px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.dsh-iv-report{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:8px 11px;font-size:12px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);line-height:1.55}
.dsh-iv-report-ok{border-color:#a7e8c4;background:#f0fdf5;color:#067647}
.dsh-iv-report-err{border-color:#fda29b;background:#fef3f2;color:#b42318}
.dsh-iv-modelpick{display:flex;flex-direction:column;gap:6px;max-height:190px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:7px;background:var(--dsw-alias-bg-base)}
.dsh-iv-modelrow{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:7px;font-size:12px}
.dsh-iv-modelrow:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-iv-modelrow code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}
.dsh-iv-modelrow[data-default="1"]{background:#eef4ff}
.dsh-iv-addrow{display:flex;gap:7px;align-items:center}
.dsh-iv-addrow input{flex:1 1 auto;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dsh-iv-pal{display:flex;flex-direction:column;gap:5px}
.dsh-iv-palrow{display:flex;align-items:center;gap:8px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 9px;background:var(--dsw-alias-bg-base)}
.dsh-iv-palrow code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`

    const STYLE_ID = 'dsh-openrouter-imagen-v2/styles'

    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      let element = document.getElementById(STYLE_ID)
      if (element === null) {
        element = document.createElement('style')
        element.id = STYLE_ID
        element.textContent = CSS
        document.head.appendChild(element)
      }
      return () => {
        const found = document.getElementById(STYLE_ID)
        if (found !== null) found.remove()
      }
    }

    /* ------------------------------------------------------------------ *
     * helpers
     * ------------------------------------------------------------------ */

    function errorText(error) {
      if (error === undefined || error === null) return '未知错误'
      if (typeof error === 'string') return error
      return error.message ? String(error.message) : String(error)
    }

    async function api(action, init) {
      const response = await fetch(`${API}/${action}`, init)
      const text = await response.text()
      let parsed = null
      try {
        parsed = JSON.parse(text)
      } catch {
        // A non-JSON body from this path means the request never reached this
        // plugin's handler — something else answered. That is a MOUNT problem,
        // not a protocol problem, and saying so saves a long detour: the SPA
        // fallback answers every unmatched path with 404 (unknown) or 405 (any
        // non-GET), which is exactly what an unmounted plugin looks like.
        throw new Error(notMountedMessage(action, response.status))
      }
      return parsed ?? { ok: false, error: '空响应' }
    }

    /**
     * Explain a non-JSON answer in terms of what actually went wrong.
     *
     * 404/405 on this prefix is not a bug in the request: it is the frontend
     * static fallback replying because no route claimed the path, which means
     * this plugin's Host half never registered. The fix is a restart (plugin
     * rows mount at boot), and the message should say that rather than report a
     * status code the user has no way to act on.
     */
    function notMountedMessage(action, status) {
      if (status === 404 || status === 405) {
        return `图像生成插件的接口没有挂载（HTTP ${status}）。这通常表示插件是本次启动之后才装好的 —— `
          + `插件行只在 DSH 启动时加载，请重启 DSH 后刷新页面。`
      }
      if (status === 401) return '未通过浏览器鉴权：请从 DSH 窗口里访问这个页面，不要用外部浏览器打开。'
      if (status === 403) return '该来源不被信任：请从 DSH 窗口里访问这个页面。'
      return `接口 ${action} 返回了非 JSON 内容（HTTP ${status}）`
    }

    function fmtBytes(bytes) {
      const value = Number(bytes) || 0
      if (value >= 1048576) return `${(value / 1048576).toFixed(1)} MB`
      if (value >= 1024) return `${Math.round(value / 1024)} KB`
      return `${value} B`
    }

    const SUGGESTIONS = [
      ['产品图', '浅色木桌面上的产品照，清晨窗边自然光，保持产品外观不变'],
      ['插画', '一只戴围巾的卡通柴犬，扁平矢量风格，粗描边，暖色'],
      ['改图', '把这张照片的白天改成雨夜，霓虹反光，保持建筑结构不变'],
    ]

    /** Fit a ratio into a 20px cell so the boxes compare honestly. */
    function ratioBox(value) {
      if (value === 'auto') return { w: 18, h: 18, dashed: true }
      const [a, b] = value.split(':').map(Number)
      const scale = 20 / Math.max(a, b)
      return { w: Math.max(6, Math.round(a * scale)), h: Math.max(6, Math.round(b * scale)), dashed: false }
    }

    exports.ratioBox = ratioBox
    exports.SUGGESTIONS = SUGGESTIONS
    exports.HISTORY_MAX = HISTORY_MAX
    exports.PANEL_KEY = PANEL_KEY
    exports.ASPECTS = ASPECTS

    /* ------------------------------------------------------------------ *
     * the workspace
     * ------------------------------------------------------------------ */

    /**
     * Which slide the picture area shows. Module scope (not component state)
     * because the strip and the stage are rendered in different places and the
     * sidebar badge wants the count too.
     */
    let currentSlide = 0

    function EmptyState(props) {
      return h('div', { className: 'dsh-iv-empty' },
        h('div', { className: 'dsh-iv-emptyin' },
          h('div', { className: 'dsh-iv-emptyico' },
            h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
              h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 3 }),
              h('circle', { cx: 8.8, cy: 8.8, r: 1.7 }),
              h('path', { d: 'M21 15.5 16.2 11 7 20.2' }))),
          h('h3', null, '还没有图片'),
          h('p', null, '在右边写下你的要求，点「生成」。图片会按下面的参数出在这里，可以放大看、也可以用同样的参数再出一张。'),
          h('div', { className: 'dsh-iv-hintrow' },
            SUGGESTIONS.map(([tag, text]) => h('button', {
              key: tag,
              type: 'button',
              className: 'dsh-iv-sugg',
              onClick: () => props.onPick(text),
            }, h('b', null, tag), h('span', null, text))))))
    }

    function SkeletonStage() {
      return h('div', { className: 'dsh-iv-sk' },
        h('div', { className: 'dsh-iv-skshot' }),
        h('div', { className: 'dsh-iv-skcap' }, '正在出图…'))
    }

    /**
     * The picture area: one large current image, then the history strip.
     *
     * `items` are records from the Host's history, newest first, already
     * resolved to displayable URLs by the caller.
     */
    function Stage(props) {
      const { items, index, onSelect, onOpen, statusText } = props
      const current = items[index] ?? null
      const shown = items.slice(0, HISTORY_MAX)

      return h('div', { className: 'dsh-iv-stage' },
        h('div', { className: 'dsh-iv-stagehead' },
          h('span', { className: 'dsh-iv-chip' }, '本次 ', h('b', null, String(items.length)), ' 张'),
          h('span', { className: 'dsh-iv-spacer' }),
          h('button', { type: 'button', className: 'dsh-iv-btn dsh-iv-btn-ghost dsh-iv-btn-sm', onClick: props.onOpenFolder, disabled: current === null, title: '在文件管理器里打开保存目录' }, '打开文件夹'),
          h('button', { type: 'button', className: 'dsh-iv-btn dsh-iv-btn-ghost dsh-iv-btn-sm', onClick: () => props.onCopyPath(current), disabled: current === null }, '复制路径')),
        h('div', { className: 'dsh-iv-stagebody' },
          current === null
            ? (statusText === 'busy' ? h(SkeletonStage) : h(EmptyState, { onPick: props.onPickSuggestion }))
            : h('figure', { className: 'dsh-iv-figure' },
                h('img', {
                  className: 'dsh-iv-img',
                  src: current.url,
                  alt: current.name,
                  onClick: () => onOpen(current),
                }),
                h('div', { className: 'dsh-iv-cap' },
                  current.width !== null && current.height !== null ? h('code', null, `${current.width}×${current.height}`) : null,
                  h('code', null, fmtBytes(current.bytes)),
                  current.seed !== null ? h('code', null, `种子 ${current.seed}`) : null,
                  h('span', null, current.name),
                  h('button', { type: 'button', className: 'dsh-iv-btn dsh-iv-btn-sm', onClick: () => props.onReuse(current) }, '用同样参数再出'),
                  h('button', { type: 'button', className: 'dsh-iv-btn dsh-iv-btn-sm', onClick: () => props.onCopyPath(current) }, '复制路径')))),
        shown.length > 0
          ? h('div', { className: 'dsh-iv-strip' },
              h('span', { className: 'dsh-iv-striplabel' }, '历史'),
              shown.map((item, i) => h('button', {
                key: item.id,
                type: 'button',
                className: 'dsh-iv-thumb',
                title: item.name,
                'aria-current': i === index ? 'true' : 'false',
                onClick: () => onSelect(i),
              },
                h('img', { src: item.thumbUrl ?? item.url, alt: item.name }),
                h('span', { className: 'dsh-iv-thumbtag' }, String(i + 1)))),
              items.length > HISTORY_MAX
                ? h('span', { className: 'dsh-iv-more' }, `还有 ${items.length - HISTORY_MAX} 张在「历史」里`)
                : null)
          : null)
    }

    exports.Stage = Stage
    exports.EmptyState = EmptyState

    /* ------------------------------------------------------------------ *
     * parameters
     * ------------------------------------------------------------------ */

    function RatioPicker(props) {
      const { value, onChange } = props
      return h('span', { className: 'dsh-iv-ratios' },
        ASPECTS.map((option) => {
          const box = ratioBox(option)
          return h('button', {
            key: option,
            type: 'button',
            className: 'dsh-iv-ratio',
            title: option === 'auto' ? '交给模型（按提示词）' : `画幅 ${option}`,
            'aria-pressed': option === value ? 'true' : 'false',
            onClick: () => onChange(option),
          },
            h('span', {
              style: {
                width: `${box.w}px`,
                height: `${box.h}px`,
                borderStyle: box.dashed ? 'dashed' : 'solid',
              },
            }),
            h('span', { className: 'dsh-iv-rationum' }, option))
        }))
    }

    function Segmented(props) {
      const { options, value, onChange } = props
      return h('span', { className: 'dsh-iv-seg' },
        options.map((option) => h('button', {
          key: option,
          type: 'button',
          'aria-pressed': String(option) === String(value) ? 'true' : 'false',
          onClick: () => onChange(option),
        }, String(option))))
    }

    exports.RatioPicker = RatioPicker
    exports.Segmented = Segmented

    /* ------------------------------------------------------------------ *
     * settings dialog
     * ------------------------------------------------------------------ */

    /**
     * Configure the API key, the image model palette and the prompt model.
     *
     * WHY A DIALOG AT ALL: the workspace is its own view and cannot reach DSH's
     * settings page, so without this there is no way to get a key in — which is
     * exactly the state the first run reports ("密钥 未配置"). It is also the
     * only place that can explain the two models, which are easy to confuse:
     * the IMAGE model draws, the PROMPT model writes.
     *
     * TWO RULES THE FORM KEEPS:
     *
     *   1. **The stored key is never loaded into the box.** The Host reports
     *      only a prefix/suffix preview; leaving the box empty means "keep what
     *      is stored", typing into it means "replace". That is why an empty box
     *      with a key already configured is a valid, non-destructive state.
     *   2. **Saving is explicit.** Nothing here writes on change — the parameter
     *      block does that because it is a live control panel, but a key that
     *      half-saves while being typed is a worse experience than one button.
     */
    function SettingsDialog(props) {
      const { open, config, keyInfo, onClose, onSave, onForgetKey, onTest } = props
      // `initialTab` exists so the preview renderer can show the other two tabs;
      // the workspace never passes it, so the real dialog always opens on 密钥
      // (the tab that matters when nothing works yet).
      const [tab, setTab] = React.useState(props.initialTab ?? 'key')
      const [draftKey, setDraftKey] = React.useState('')
      const [reveal, setReveal] = React.useState(false)
      const [form, setForm] = React.useState({})
      const [busy, setBusy] = React.useState('')
      const [report, setReport] = React.useState(null)
      const [error, setError] = React.useState('')
      const [catalogue, setCatalogue] = React.useState(null)
      const [newModel, setNewModel] = React.useState('')

      // Opening the dialog is what resets it: the form is seeded from the live
      // settings each time, so a cancelled edit cannot leak into the next open.
      React.useEffect(() => {
        if (open !== true) return
        setDraftKey('')
        setReveal(false)
        setReport(null)
        setError('')
        setNewModel('')
        setCatalogue(null)
        setForm({
          model: config.model ?? '',
          promptModel: config.promptModel ?? 'google/gemini-2.5-flash',
          models: Array.isArray(config.models) ? config.models.slice() : [],
          saveDir: config.saveDir ?? 'generated-images',
          providerSort: config.providerSort ?? '',
          extraJson: config.extraJson ?? '',
        })
      }, [open, config])

      const field = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))

      const palette = Array.isArray(form.models) ? form.models : []
      const addModel = (id) => {
        const value = String(id ?? '').trim()
        if (value.length === 0 || palette.includes(value) || palette.length >= 16) return
        field('models', [...palette, value])
      }
      const dropModel = (id) => field('models', palette.filter((entry) => entry !== id))

      /** The catalogue needs a key, and the typed one counts before it is saved. */
      const loadCatalogue = React.useCallback(async () => {
        setBusy('models')
        setError('')
        try {
          const query = draftKey.trim().length > 0 ? `?key=${encodeURIComponent(draftKey.trim())}` : ''
          const res = await api(`models${query}`)
          if (res.ok === false) throw new Error(res.error ?? '拉取模型列表失败')
          setCatalogue(Array.isArray(res.models) ? res.models : [])
        } catch (err) {
          setError(errorText(err))
        } finally {
          setBusy('')
        }
      }, [draftKey])

      const testKey = React.useCallback(async () => {
        setBusy('test')
        setError('')
        setReport(null)
        try {
          const query = draftKey.trim().length > 0 ? `?key=${encodeURIComponent(draftKey.trim())}` : ''
          const res = await api(`test${query}`)
          if (res.ok === false) throw new Error(res.error ?? '校验失败')
          setReport({ ok: true, text: res.report ?? '密钥可用' })
        } catch (err) {
          setReport({ ok: false, text: errorText(err) })
        } finally {
          setBusy('')
        }
      }, [draftKey])

      const save = React.useCallback(async () => {
        setBusy('save')
        setError('')
        try {
          const patch = { ...form }
          // Only send a key when one was actually typed: an empty box means
          // "keep the stored one", and the Host ignores blanks anyway.
          if (draftKey.trim().length > 0) patch.apiKey = draftKey.trim()
          const res = await onSave(patch)
          if (res?.ok === false) throw new Error(res.error ?? '保存失败')
          setDraftKey('')
          onClose()
        } catch (err) {
          setError(errorText(err))
        } finally {
          setBusy('')
        }
      }, [form, draftKey, onSave, onClose])

      const forget = React.useCallback(async () => {
        setBusy('forget')
        setError('')
        try {
          const res = await onForgetKey()
          if (res?.ok === false) throw new Error(res.error ?? '清除失败')
          setDraftKey('')
          setReport(null)
        } catch (err) {
          setError(errorText(err))
        } finally {
          setBusy('')
        }
      }, [onForgetKey])

      if (open !== true) return null

      const hasStored = keyInfo?.hasKey === true
      const typed = draftKey.trim().length > 0
      // What the badge describes: the typed key if there is one, else the stored
      // one. A typed key that is obviously malformed is worth flagging BEFORE
      // saving, which is the whole point of showing this.
      const typedLooksWrong = typed && !draftKey.trim().startsWith('sk-or-v1-')

      const keyBadge = typed
        ? (typedLooksWrong
            ? h('span', { className: 'dsh-iv-badge dsh-iv-badge-err' }, '不像 OpenRouter 密钥')
            : h('span', { className: 'dsh-iv-badge dsh-iv-badge-warn' }, '未保存 · 待替换'))
        : hasStored
          ? h('span', { className: 'dsh-iv-badge dsh-iv-badge-ok' }, `已配置 ${keyInfo.prefix}…${keyInfo.suffix}`)
          : h('span', { className: 'dsh-iv-badge dsh-iv-badge-err' }, '未配置')

      const keyTab = h('div', { className: 'dsh-iv-dlgbody' },
        h('div', { className: 'dsh-iv-field-h' },
          h('span', { className: 'dsh-iv-flabel' }, 'OpenRouter API Key ', keyBadge),
          h('div', { className: 'dsh-iv-keyrow' },
            h('input', {
              className: 'dsh-iv-in',
              type: reveal ? 'text' : 'password',
              value: draftKey,
              spellCheck: false,
              autoComplete: 'off',
              placeholder: hasStored ? '留空 = 保留已存的密钥' : 'sk-or-v1-…',
              onChange: (e) => setDraftKey(e.target.value),
            }),
            h('button', { type: 'button', className: 'dsh-iv-btn dsh-iv-btn-sm', onClick: () => setReveal((v) => !v) }, reveal ? '隐藏' : '显示'),
            h('button', { type: 'button', className: 'dsh-iv-btn dsh-iv-btn-sm', disabled: busy !== '' || (!typed && !hasStored), onClick: () => void testKey() }, busy === 'test' ? '校验中…' : '校验')),
          h('span', { className: 'dsh-iv-fhelp' },
            '在 ', h('b', null, 'openrouter.ai/keys'), ' 生成，以 sk-or-v1- 开头。密钥只存在本机设置里，任何接口都不会把它读回来 —— 所以这里看到的是头尾预览，不是原文。'),
          hasStored
            ? h('div', null, h('button', { type: 'button', className: 'dsh-iv-btn dsh-iv-btn-sm', disabled: busy !== '', onClick: () => void forget() }, busy === 'forget' ? '清除中…' : '清除已存的密钥'))
            : null),
        report !== null
          ? h('div', { className: `dsh-iv-report ${report.ok ? 'dsh-iv-report-ok' : 'dsh-iv-report-err'}` }, report.ok ? '✓ ' : '✕ ', report.text)
          : null,
        h('div', { className: 'dsh-iv-field-h' },
          h('span', { className: 'dsh-iv-flabel' }, '不要重复输入'),
          h('span', { className: 'dsh-iv-fhelp' }, '一旦保存，密钥就不会再显示。要换一个就直接在上面的框里输入新的，保存即替换。')))

      /** The catalogue list, kept out of the tab tree so the nesting stays readable. */
      const catalogueNode = catalogue === null
        ? null
        : h('div', { className: 'dsh-iv-modelpick' },
            catalogue.length === 0
              ? h('span', { className: 'dsh-iv-fhelp' }, '目录是空的。')
              : catalogue.map((row) => h('div', {
                  key: row.id,
                  className: 'dsh-iv-modelrow',
                  'data-default': row.id === form.model ? '1' : '0',
                },
                  h('code', null, row.id),
                  palette.includes(row.id)
                    ? h('span', { className: 'dsh-iv-badge' }, '已在清单')
                    : h('button', { type: 'button', className: 'dsh-iv-btn dsh-iv-btn-sm', onClick: () => addModel(row.id) }, '加入'))))

      const modelTab = h('div', { className: 'dsh-iv-dlgbody' },
        h('div', { className: 'dsh-iv-field-h' },
          h('span', { className: 'dsh-iv-flabel' }, '图像模型（画图的那个）'),
          h('select', {
            className: 'dsh-iv-in',
            value: form.model ?? '',
            onChange: (e) => field('model', e.target.value),
          },
            (palette.length > 0 ? palette : [form.model].filter(Boolean))
              .map((id) => h('option', { key: id, value: id }, id))),
          h('span', { className: 'dsh-iv-fhelp' }, '工作台「参数」里的模型下拉读的就是下面这份清单。')),
        h('div', { className: 'dsh-iv-field-h' },
          h('span', { className: 'dsh-iv-flabel' }, '模型清单 ', h('span', { className: 'dsh-iv-badge' }, `${palette.length}/16`)),
          palette.length === 0
            ? h('span', { className: 'dsh-iv-fhelp' }, '清单是空的。加上至少一个图像模型 id，否则没图可出。')
            : h('div', { className: 'dsh-iv-pal' },
                palette.map((id) => h('div', { key: id, className: 'dsh-iv-palrow' },
                  h('code', null, id),
                  id === form.model ? h('span', { className: 'dsh-iv-badge dsh-iv-badge-ok' }, '当前') : null,
                  h('button', { type: 'button', className: 'dsh-iv-btn dsh-iv-btn-ghost dsh-iv-btn-sm', onClick: () => dropModel(id) }, '移除')))),
          h('div', { className: 'dsh-iv-addrow' },
            h('input', {
              className: 'dsh-iv-in',
              value: newModel,
              spellCheck: false,
              placeholder: '例如 google/gemini-2.5-flash-image',
              onChange: (e) => setNewModel(e.target.value),
            }),
            h('button', {
              type: 'button',
              className: 'dsh-iv-btn dsh-iv-btn-sm',
              disabled: newModel.trim().length === 0 || palette.length >= 16,
              onClick: () => { addModel(newModel); setNewModel('') },
            }, '添加'))),
        h('div', { className: 'dsh-iv-field-h' },
          h('span', { className: 'dsh-iv-flabel' }, '从线上目录挑（需要密钥）'),
          h('div', { className: 'dsh-iv-addrow' },
            h('button', { type: 'button', className: 'dsh-iv-btn dsh-iv-btn-sm', disabled: busy !== '', onClick: () => void loadCatalogue() }, busy === 'models' ? '拉取中…' : '拉取可用模型')),
          catalogueNode))

      const advancedTab = h('div', { className: 'dsh-iv-dlgbody' },
        h('div', { className: 'dsh-iv-field-h' },
          h('span', { className: 'dsh-iv-flabel' }, '写提示词的文本模型'),
          h('input', {
            className: 'dsh-iv-in',
            value: form.promptModel ?? '',
            spellCheck: false,
            placeholder: 'google/gemini-2.5-flash',
            onChange: (e) => field('promptModel', e.target.value),
          }),
          h('span', { className: 'dsh-iv-fhelp' }, '「让 AI 写提示词」用它。这是**文本**模型 —— 填成图像模型会失败。它和画图的模型是两个不同的东西。')),
        h('div', { className: 'dsh-iv-field-h' },
          h('span', { className: 'dsh-iv-flabel' }, '保存目录'),
          h('input', {
            className: 'dsh-iv-in',
            value: form.saveDir ?? '',
            spellCheck: false,
            placeholder: 'generated-images',
            onChange: (e) => field('saveDir', e.target.value),
          }),
          h('span', { className: 'dsh-iv-fhelp' }, '相对路径按会话工作目录解析；也可以填绝对路径。留空则只存进 DSH 附件，不落盘。')),
        h('div', { className: 'dsh-iv-field-h' },
          h('span', { className: 'dsh-iv-flabel' }, 'Provider 排序'),
          h('select', {
            className: 'dsh-iv-in',
            value: form.providerSort ?? '',
            onChange: (e) => field('providerSort', e.target.value),
          },
            h('option', { value: '' }, '不指定'),
            h('option', { value: 'price' }, 'price（最便宜优先）'),
            h('option', { value: 'throughput' }, 'throughput（最快优先）'),
            h('option', { value: 'latency' }, 'latency（最低延迟优先）'))),
        h('div', { className: 'dsh-iv-field-h' },
          h('span', { className: 'dsh-iv-flabel' }, '附加请求体（JSON）'),
          h('textarea', {
            className: 'dsh-iv-in',
            'data-mono': '1',
            spellCheck: false,
            value: form.extraJson ?? '',
            placeholder: '{ "some_provider_field": true }',
            onChange: (e) => field('extraJson', e.target.value),
          }),
          h('span', { className: 'dsh-iv-fhelp' }, '会被合并进发给 OpenRouter 的请求体。不能覆盖 model、prompt、input_references —— 那三个由工作台和工具决定。')))

      return h('div', {
        className: 'dsh-iv-modal',
        'data-open': '1',
        onClick: (event) => { if (event.target === event.currentTarget && busy === '') onClose() },
      },
        h('div', { className: 'dsh-iv-dialog', role: 'dialog', 'aria-label': '图像生成设置' },
          h('div', { className: 'dsh-iv-dlghead' },
            h('h3', null, '图像生成设置'),
            h('span', { className: 'dsh-iv-spacer' }),
            h('button', { type: 'button', className: 'dsh-iv-btn dsh-iv-btn-ghost dsh-iv-btn-sm', disabled: busy !== '', onClick: onClose }, '关闭')),
          h('div', { className: 'dsh-iv-dlgtabs' },
            h('button', { type: 'button', 'aria-pressed': tab === 'key' ? 'true' : 'false', onClick: () => setTab('key') }, '密钥'),
            h('button', { type: 'button', 'aria-pressed': tab === 'models' ? 'true' : 'false', onClick: () => setTab('models') }, '模型'),
            h('button', { type: 'button', 'aria-pressed': tab === 'advanced' ? 'true' : 'false', onClick: () => setTab('advanced') }, '高级')),
          tab === 'key' ? keyTab : tab === 'models' ? modelTab : advancedTab,
          error.length > 0
            ? h('div', { style: { padding: '0 18px 10px' } }, h('div', { className: 'dsh-iv-err' }, error))
            : null,
          h('div', { className: 'dsh-iv-dlgfoot' },
            h('button', { type: 'button', className: 'dsh-iv-btn dsh-iv-btn-primary', disabled: busy !== '', onClick: () => void save() }, busy === 'save' ? '保存中…' : '保存'),
            h('button', { type: 'button', className: 'dsh-iv-btn', disabled: busy !== '', onClick: onClose }, '取消'),
            h('span', { className: 'dsh-iv-spacer' }),
            h('span', { className: 'dsh-iv-hint' }, typed ? '将替换密钥' : hasStored ? '密钥保持不动' : '尚未配置密钥'))))
    }

    exports.SettingsDialog = SettingsDialog

    /* ------------------------------------------------------------------ *
     * the workspace component
     * ------------------------------------------------------------------ */

    /**
     * The full workspace. Registered into the keyed `main` slot, so this IS the
     * central panel while the user is on this plugin's entry.
     *
     * State is component-local and mirrors the Host: `config` is the live
     * settings view, `items` is the resolved history, `messages` is this
     * component's own transcript (the workspace does not read the chat's).
     */
    function Workspace() {
      const [config, setConfig] = React.useState({})
      const [records, setRecords] = React.useState([])
      const [urls, setUrls] = React.useState({})
      const [messages, setMessages] = React.useState([])
      const [draft, setDraft] = React.useState('')
      const [mode, setMode] = React.useState('refine')
      /**
       * The model for the NEXT generation only. Empty means "follow the stored
       * default", so the picker never silently diverges from 设置 until the user
       * actually picks something. Deliberately not persisted as a setting: the
       * point of the control is to try another model once without rewriting the
       * default everyone else's view is using.
       */
      const [callModel, setCallModel] = React.useState('')
      const [status, setStatus] = React.useState('idle')
      const [statusText, setStatusText] = React.useState('就绪 · 尚未生成')
      const [error, setError] = React.useState('')
      const [pendingPrompt, setPendingPrompt] = React.useState('')
      const [slide, setSlide] = React.useState(0)
      const [lightbox, setLightbox] = React.useState(null)
      const [zoom, setZoom] = React.useState(null)
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [keyInfo, setKeyInfo] = React.useState({ hasKey: false, prefix: '', suffix: '', looksValid: false })

      /** One source of truth for "is a key configured": the preview the Host sent. */
      const hasKey = keyInfo.hasKey === true
      const applyKeyInfo = (res) => setKeyInfo({
        hasKey: res?.hasKey === true,
        prefix: res?.prefix ?? '',
        suffix: res?.suffix ?? '',
        looksValid: res?.looksValid === true,
      })

      /**
       * The image models the picker offers: the configured palette, with the
       * stored default guaranteed present so the control can always show what
       * will actually be used when nothing is picked.
       */
      const modelChoices = React.useMemo(() => {
        const palette = Array.isArray(config.models) ? config.models.filter((id) => String(id ?? '').trim().length > 0) : []
        const stored = String(config.model ?? '').trim()
        const out = palette.slice()
        if (stored.length > 0 && !out.includes(stored)) out.unshift(stored)
        return out
      }, [config.models, config.model])

      /**
       * What to send as this call's model. An explicit pick wins; otherwise the
       * stored default; otherwise the first palette entry — the same precedence
       * the Host applies, so the label and the request agree.
       */
      const pickModel = React.useCallback(() => {
        const explicit = String(callModel ?? '').trim()
        if (explicit.length > 0) return explicit
        const stored = String(config.model ?? '').trim()
        if (stored.length > 0) return stored
        return modelChoices.length > 0 ? modelChoices[0] : ''
      }, [callModel, config.model, modelChoices])

      const patch = React.useCallback(async (next) => {        const res = await api('config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(next),
        })
        if (res.ok === false) throw new Error(res.error ?? '保存失败')
        if (res.config) setConfig(res.config)
        if (typeof res.hasKey === 'boolean') applyKeyInfo(res)
        return res
      }, [])

      // Initial load: settings + history. History is what the strip shows, and
      // it survives a restart because the Host persists it.
      React.useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const res = await api('config')
            if (!alive) return
            if (res.config) setConfig(res.config)
            applyKeyInfo(res)
            const hist = await api('history')
            if (!alive) return
            setRecords(Array.isArray(hist.records) ? hist.records : [])
          } catch (err) {
            if (alive) setError(errorText(err))
          }
        })()
        return () => { alive = false }
      }, [])

      /**
       * Resolve records to displayable URLs. The Host hands back attachment ids
       * and file paths, not pixels; images come from the same-origin route so
       * the browser never needs an attachment authorization the workspace
       * cannot obtain on its own.
       */
      React.useEffect(() => {
        const missing = []
        for (const record of records) {
          for (const image of record.images ?? []) {
            const key = `${record.id}:${image.name}`
            if (urls[key] === undefined) missing.push([key, record.id, image.name])
          }
        }
        if (missing.length === 0) return
        let alive = true
        void (async () => {
          const next = {}
          for (const [key, recordId, name] of missing) {
            try {
              const res = await fetch(`${API}/image?id=${encodeURIComponent(recordId)}&name=${encodeURIComponent(name)}`)
              if (!res.ok) continue
              const blob = await res.blob()
              next[key] = URL.createObjectURL(blob)
            } catch {
              /* one unreadable file must not stop the others */
            }
          }
          if (alive && Object.keys(next).length > 0) setUrls((prev) => ({ ...prev, ...next }))
        })()
        return () => { alive = false }
      }, [records, urls])

      const items = React.useMemo(() => {
        const out = []
        for (const record of records) {
          const images = Array.isArray(record.images) ? record.images : []
          images.forEach((image, i) => {
            const key = `${record.id}:${image.name}`
            out.push({
              id: `${record.id}:${i}`,
              recordId: record.id,
              name: image.name,
              bytes: image.bytes,
              width: image.width ?? null,
              height: image.height ?? null,
              filePath: image.filePath ?? null,
              outputDir: record.outputDir ?? null,
              seed: record.seed ?? null,
              prompt: record.prompt ?? '',
              params: record.params ?? {},
              url: urls[key] ?? '',
              thumbUrl: urls[key] ?? '',
            })
          })
        }
        return out
      }, [records, urls])

      const current = items[slide] ?? null

      /** Copy a generation's parameters back into the live settings. */
      const reuse = React.useCallback((item) => {
        const params = item.params ?? {}
        void patch({
          resolution: params.resolution ?? 'auto',
          aspectRatio: params.aspect_ratio ?? 'auto',
          quality: params.quality ?? 'auto',
          outputFormat: params.output_format ?? 'png',
          background: params.background ?? 'auto',
          count: params.count ?? 1,
          seed: params.seed === undefined || params.seed === null ? '' : String(params.seed),
          model: params.model ?? config.model,
        }).catch((err) => setError(errorText(err)))
        setStatusText('已套用这张的参数')
      }, [patch, config.model])

      const copyPath = React.useCallback((item) => {
        const text = item?.filePath ?? item?.outputDir ?? ''
        if (text.length === 0) return
        if (typeof navigator !== 'undefined' && navigator.clipboard) void navigator.clipboard.writeText(text)
      }, [])

      const openFolder = React.useCallback(async (item) => {
        const path = item?.outputDir ?? ''
        if (path.length === 0) return
        try {
          const apps = await (await fetch('/open-in-app/apps')).json()
          const list = Array.isArray(apps?.apps) ? apps.apps : []
          if (list.length === 0) throw new Error('主机上没有可用的目录应用')
          await fetch('/open-in-app/open', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ app: list[0].id ?? list[0].key ?? list[0].app, path }),
          })
        } catch (err) {
          setError(`打开文件夹失败：${errorText(err)}（可以改用「复制路径」）`)
        }
      }, [])

      /* ---- settings ---- */

      /**
       * Save from the dialog. Unlike `patch` (which the parameter block uses and
       * which throws), this returns the raw response so the dialog can show the
       * message inline and stay open on failure — a rejected key must not close
       * the form and lose what was typed.
       */
      const saveSettings = React.useCallback(async (next) => {
        const res = await api('config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(next),
        })
        if (res.ok === true) {
          if (res.config) setConfig(res.config)
          applyKeyInfo(res)
        }
        return res
      }, [])

      const forgetKey = React.useCallback(async () => {
        const res = await api('config/key', { method: 'DELETE' })
        if (res.ok === true) {
          if (res.config) setConfig(res.config)
          applyKeyInfo(res)
        }
        return res
      }, [])

      /* ---- generation ---- */

      const busy = status === 'busy'

      /** Direct mode: the box IS the prompt, so one call and done. */
      const generateDirect = React.useCallback(async (promptText) => {
        setStatus('busy')
        setStatusText('出图中…')
        setError('')
        try {
          const res = await api('generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // `model` travels per call. Without it the Host falls back to the
            // stored default, which is why the picker under the composer used
            // to look like it did nothing.
            body: JSON.stringify({ prompt: promptText, request: draft, model: pickModel() }),
          })
          if (res.ok === false) throw new Error(res.error ?? '出图失败')
          const hist = await api('history')
          setRecords(Array.isArray(hist.records) ? hist.records : [])
          setSlide(0)
          setStatus('ok')
          setStatusText(`完成 · ${res.images?.length ?? 0} 张 · 耗时 ${Math.round((res.elapsedMs ?? 0) / 1000)} 秒${res.cost === null || res.cost === undefined ? '' : ` · $${Number(res.cost).toFixed(4)}`}`)
          setMessages((prev) => [
            ...prev,
            { kind: 'user', text: promptText },
            { kind: 'tool', text: `openrouter_generate_imagen_v2 · ${res.images?.length ?? 0} 张 · 种子 ${res.seed}${res.seedRandom ? '（随机）' : ''}` },
          ])
        } catch (err) {
          setStatus('err')
          setStatusText('失败 · 可重试')
          setError(errorText(err))
        }
      }, [draft])

      /**
       * Refine mode. The approved design sends the request through the chat
       * model; the workspace cannot post into a conversation from the client
       * (the client `sessions` face exposes lifecycle, not message send), so
       * the Host owns that leg. Until it lands, this composes the prompt
       * locally and shows it for review — which is also exactly what the
       * "confirm before generating" switch needs.
       */
      const composePrompt = React.useCallback(async (requestText, thenGenerate) => {
        setStatus('busy')
        setStatusText('正在写提示词…')
        setError('')
        try {
          const res = await api('prompt', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ request: requestText, generate: thenGenerate === true }),
          })
          if (res.ok === false) throw new Error(res.error ?? '写提示词失败')
          if (res.generated === true) {
            const hist = await api('history')
            setRecords(Array.isArray(hist.records) ? hist.records : [])
            setSlide(0)
            setStatus('ok')
            setStatusText(`完成 · ${res.images?.length ?? 0} 张`)
            setMessages((prev) => [...prev, { kind: 'user', text: requestText }, { kind: 'prompt', text: res.prompt }, { kind: 'tool', text: 'openrouter_generate_imagen_v2 · 已完成' }])
          } else {
            setStatus('idle')
            setStatusText('提示词已就绪 · 确认后出图')
            setPendingPrompt(res.prompt ?? '')
            setMessages((prev) => [...prev, { kind: 'user', text: requestText }, { kind: 'prompt', text: res.prompt ?? '' }])
          }
        } catch (err) {
          setStatus('err')
          setStatusText('失败 · 可重试')
          setError(errorText(err))
        }
      }, [])

      const onGenerate = React.useCallback(() => {
        const text = draft.trim()
        if (text.length === 0 || busy) return
        if (mode === 'direct') return void generateDirect(text)
        return void composePrompt(text, config.confirmPrompt !== true)
      }, [draft, busy, mode, generateDirect, composePrompt, config.confirmPrompt])

      const confirmPending = React.useCallback(() => {
        const promptText = pendingPrompt
        setPendingPrompt('')
        if (promptText.length > 0) void generateDirect(promptText)
      }, [pendingPrompt, generateDirect])

      /* ---- splitters ---- */

      const rootRef = React.useRef(null)
      const leftRef = React.useRef(null)

      const onSplitStart = React.useCallback((event) => {
        event.preventDefault()
        const root = rootRef.current
        if (root === null) return
        const move = (e) => {
          const rect = root.getBoundingClientRect()
          const px = Math.min(Math.max(e.clientX - rect.left, 340), Math.max(340, rect.width - 300 - 6))
          root.style.setProperty('--dsh-iv-left', `${Math.round(px)}px`)
        }
        const up = () => {
          document.removeEventListener('pointermove', move)
          document.removeEventListener('pointerup', up)
          delete document.body.dataset.dshIvResizingX
          const rect = root.getBoundingClientRect()
          const fraction = Math.min(Math.max((root.querySelector('.dsh-iv-left')?.getBoundingClientRect().width ?? rect.width * 0.6) / rect.width, 0.2), 0.85)
          void patch({ splitRatio: Number(fraction.toFixed(3)) }).catch(() => {})
        }
        document.body.dataset.dshIvResizingX = '1'
        document.addEventListener('pointermove', move)
        document.addEventListener('pointerup', up)
      }, [patch])

      const onHSplitStart = React.useCallback((event) => {
        event.preventDefault()
        const left = leftRef.current
        if (left === null) return
        const move = (e) => {
          const rect = left.getBoundingClientRect()
          const px = Math.min(Math.max(rect.bottom - e.clientY, 120), Math.max(120, rect.height - 220 - 7))
          left.style.setProperty('--dsh-iv-params', `${Math.round(px)}px`)
        }
        const up = () => {
          document.removeEventListener('pointermove', move)
          document.removeEventListener('pointerup', up)
          delete document.body.dataset.dshIvResizingY
          const height = left.querySelector('.dsh-iv-params')?.getBoundingClientRect().height ?? 236
          void patch({ paramsHeight: Math.round(height) }).catch(() => {})
        }
        document.body.dataset.dshIvResizingY = '1'
        document.addEventListener('pointermove', move)
        document.addEventListener('pointerup', up)
      }, [patch])

      /* ---- render ---- */

      const ratio = typeof config.splitRatio === 'number' ? config.splitRatio : 0.6
      const paramsH = typeof config.paramsHeight === 'number' ? config.paramsHeight : 236
      const rootStyle = {
        '--dsh-iv-left': `${Math.round(ratio * 100)}%`,
        '--dsh-iv-params': `${Math.round(paramsH)}px`,
      }

      const convoScroll = React.useRef(null)
      React.useEffect(() => {
        const node = convoScroll.current
        if (node !== null) node.scrollTop = node.scrollHeight
      })

      /** The zoom overlay, kept out of the main tree so the nesting stays readable. */
      const lightboxNode = zoom === null ? null : h('div', {
        className: 'dsh-iv-lb',
        'data-open': '1',
        onClick: (e) => { if (e.target === e.currentTarget) setZoom(null) },
      },
        h('button', { type: 'button', className: 'dsh-iv-lbclose', onClick: () => setZoom(null) }, '关闭 Esc'),
        h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center' } },
          h('img', { src: zoom.url, alt: zoom.name }),
          h('div', { className: 'dsh-iv-lbbar' },
            h('span', { className: 'dsh-iv-chip' }, '文件名 ', h('b', null, zoom.name)),
            zoom.width === null ? null : h('span', { className: 'dsh-iv-chip' }, '尺寸 ', h('b', null, `${zoom.width}×${zoom.height}`)),
            zoom.seed === null ? null : h('span', { className: 'dsh-iv-chip' }, '种子 ', h('b', null, String(zoom.seed))),
            h('button', { type: 'button', className: 'dsh-iv-btn dsh-iv-btn-sm', onClick: () => setZoom(null) }, '关闭'))))

      return h('div', { className: 'dsh-iv-root', ref: rootRef, style: rootStyle },
        h('div', { className: 'dsh-iv-head' },
          h('span', { className: 'dsh-iv-dot', 'data-state': status === 'busy' ? 'busy' : status === 'ok' ? 'ok' : status === 'err' ? 'err' : 'idle' }),
          h('h2', { className: 'dsh-iv-title' }, '图像生成'),
          h('span', { className: 'dsh-iv-meta' }, statusText),
          h('span', { className: 'dsh-iv-spacer' }),
          // Reports the model that the NEXT call will really use — which is the
          // per-call pick when one is set, not always the stored default. An
          // override is labelled, so the header and the picker can never
          // disagree about what is about to be sent.
          h('span', { className: 'dsh-iv-chip', title: callModel.length > 0 ? `本次覆盖：${callModel}（默认 ${config.model}）` : '来自设置的默认模型' },
            callModel.length > 0 ? '模型 · 本次 ' : '模型 ',
            h('b', null, String(pickModel() || '—'))),
          hasKey
            ? h('span', { className: 'dsh-iv-chip dsh-iv-chip-ok' }, '密钥 ', h('b', null, '已配置'))
            : h('span', { className: 'dsh-iv-chip dsh-iv-chip-err' }, '密钥 ', h('b', null, '未配置')),
          // The only way to configure a key from this view: the workspace cannot
          // reach DSH's own settings page. Styled as a primary button while no
          // key exists, because until one does nothing here can work.
          h('button', {
            type: 'button',
            className: hasKey ? 'dsh-iv-btn dsh-iv-btn-sm' : 'dsh-iv-btn dsh-iv-btn-sm dsh-iv-btn-primary',
            onClick: () => setSettingsOpen(true),
            title: '配置 API 密钥、模型与高级选项',
          }, '设置')),

        h('div', { className: 'dsh-iv-work' },
          /* ---------------- left: picture → history → parameters ---------------- */
          h('div', { className: 'dsh-iv-left', ref: leftRef },
            h(Stage, {
              items,
              index: slide,
              statusText: status,
              onSelect: setSlide,
              onOpen: (item) => setZoom(item),
              onOpenFolder: () => openFolder(current),
              onCopyPath: copyPath,
              onReuse: reuse,
              onPickSuggestion: setDraft,
            }),
            h('button', {
              type: 'button',
              className: 'dsh-iv-hsplit',
              'aria-label': '调整参数区高度',
              title: '拖动调整参数区高度',
              onPointerDown: onHSplitStart,
            }),
            h('div', { className: 'dsh-iv-params' },
              h('div', { className: 'dsh-iv-panehead' }, h('span', null, '参数'), h('span', { className: 'dsh-iv-spacer' })),
              h('div', { className: 'dsh-iv-paramsbody' },
                h('div', { className: 'dsh-iv-row' },
                  h('span', { className: 'dsh-iv-label' }, '画幅'),
                  h('span', { className: 'dsh-iv-ctl' }, h(RatioPicker, { value: config.aspectRatio ?? '16:9', onChange: (v) => void patch({ aspectRatio: v }).catch(() => {}) }))),
                h('div', { className: 'dsh-iv-row' },
                  h('span', { className: 'dsh-iv-label' }, '分辨率'),
                  h('span', { className: 'dsh-iv-ctl' },
                    h('select', { className: 'dsh-iv-in', value: config.resolution ?? '1K', onChange: (e) => void patch({ resolution: e.target.value }).catch(() => {}) },
                      RESOLUTIONS.map((o) => h('option', { key: o, value: o }, o))))),
                h('div', { className: 'dsh-iv-row' },
                  h('span', { className: 'dsh-iv-label' }, '数量'),
                  h('span', { className: 'dsh-iv-ctl' },
                    h(Segmented, { options: [1, 2, 3, 4], value: config.count ?? 1, onChange: (v) => void patch({ count: Number(v) }).catch(() => {}) }))),
                h('div', { className: 'dsh-iv-row' },
                  h('span', { className: 'dsh-iv-label' }, '质量'),
                  h('span', { className: 'dsh-iv-ctl' },
                    h(Segmented, { options: QUALITIES, value: config.quality ?? 'medium', onChange: (v) => void patch({ quality: v }).catch(() => {}) }))),
                h('div', { className: 'dsh-iv-row' },
                  h('span', { className: 'dsh-iv-label' }, '格式'),
                  h('span', { className: 'dsh-iv-ctl' },
                    h('select', { className: 'dsh-iv-in', value: config.outputFormat ?? 'png', onChange: (e) => void patch({ outputFormat: e.target.value }).catch(() => {}) },
                      FORMATS.map((o) => h('option', { key: o, value: o }, o))))),
                h('div', { className: 'dsh-iv-row' },
                  h('span', { className: 'dsh-iv-label' }, '背景'),
                  h('span', { className: 'dsh-iv-ctl' },
                    h('select', { className: 'dsh-iv-in', value: config.background ?? 'auto', onChange: (e) => void patch({ background: e.target.value }).catch(() => {}) },
                      BACKGROUNDS.map((o) => h('option', { key: o, value: o }, o))))),
                h('div', { className: 'dsh-iv-row' },
                  h('span', { className: 'dsh-iv-label' }, '种子'),
                  h('span', { className: 'dsh-iv-ctl' },
                    h('input', {
                      className: 'dsh-iv-in',
                      value: config.seed ?? '',
                      placeholder: '留空 = 随机',
                      onChange: (e) => setConfig((prev) => ({ ...prev, seed: e.target.value })),
                      onBlur: (e) => void patch({ seed: e.target.value }).catch((err) => setError(errorText(err))),
                    }),
                    h('button', { type: 'button', className: 'dsh-iv-btn dsh-iv-btn-sm', onClick: () => void patch({ seed: '' }).catch(() => {}) }, '随机'))),
                h('div', { className: 'dsh-iv-row' },
                  h('span', { className: 'dsh-iv-label' }, '模型'),
                  h('span', { className: 'dsh-iv-ctl' },
                    h('select', { className: 'dsh-iv-in', value: config.model ?? '', onChange: (e) => void patch({ model: e.target.value }).catch(() => {}) },
                      (Array.isArray(config.models) && config.models.length > 0 ? config.models : [config.model].filter(Boolean))
                        .map((o) => h('option', { key: o, value: o }, o))))),
                h('div', { className: 'dsh-iv-row' },
                  h('span', { className: 'dsh-iv-label', style: { flex: '1 1 auto' } }, '写提示词后先确认再出图'),
                  h('label', { className: 'dsh-iv-switch' },
                    h('input', {
                      type: 'checkbox',
                      checked: config.confirmPrompt === true,
                      onChange: (e) => void patch({ confirmPrompt: e.target.checked }).catch(() => {}),
                    }),
                    h('span', { className: 'dsh-iv-track' })))),
              h('div', { className: 'dsh-iv-pfoot' },
                h('div', { className: 'dsh-iv-cost' }, h('span', null, '本次预计'), h('b', null, `${config.count ?? 1} 张`)),
                h('div', { className: 'dsh-iv-cost' }, h('span', null, '历史记录'), h('b', null, `${records.length} 次`))))),

          h('button', {
            type: 'button',
            className: 'dsh-iv-split',
            'aria-label': '调整两栏宽度',
            title: '拖动调整宽度',
            onPointerDown: onSplitStart,
          }),

          /* ---------------- right: conversation ---------------- */
          h('div', { className: 'dsh-iv-right' },
            h('div', { className: 'dsh-iv-convo' },
              h('div', { className: 'dsh-iv-panehead' }, h('span', null, '对话'), h('span', { className: 'dsh-iv-spacer' }),
                h('button', { type: 'button', className: 'dsh-iv-btn dsh-iv-btn-ghost dsh-iv-btn-sm', onClick: () => { setMessages([]); setError(''); setPendingPrompt('') } }, '清空')),
              h('div', { className: 'dsh-iv-scroll', ref: convoScroll },
                messages.length === 0 && error.length === 0
                  ? h('div', { className: 'dsh-iv-note' }, '还没有生成。点「生成」后会先把要求写成提示词。')
                  : null,
                messages.map((message, i) => {
                  if (message.kind === 'user') {
                    return h('div', { key: i, className: 'dsh-iv-msg dsh-iv-msg-user' },
                      h('div', { className: 'dsh-iv-role' }, '你'),
                      h('div', { className: 'dsh-iv-body' }, message.text))
                  }
                  if (message.kind === 'prompt') {
                    return h('div', { key: i, className: 'dsh-iv-prompt' },
                      h('div', { className: 'dsh-iv-prompthead' }, '✎ 提示词'),
                      h('div', { className: 'dsh-iv-promptbody' }, message.text),
                      h('div', { className: 'dsh-iv-promptfoot' },
                        h('div', { className: 'dsh-iv-paramsline' },
                          `${config.resolution} · ${config.aspectRatio} · ${config.quality} · ${config.outputFormat} · ${config.count} 张`),
                        h('span', { className: 'dsh-iv-spacer' }),
                        h('button', {
                          type: 'button',
                          className: 'dsh-iv-btn dsh-iv-btn-sm dsh-iv-btn-primary',
                          onClick: () => { setDraft(message.text); void generateDirect(message.text) },
                        }, '就这样出图'),
                        h('button', {
                          type: 'button',
                          className: 'dsh-iv-btn dsh-iv-btn-sm',
                          onClick: () => setDraft(message.text),
                        }, '编辑')))
                  }
                  if (message.kind === 'tool') {
                    return h('div', { key: i, className: 'dsh-iv-tool' }, h('span', null, '✓'), h('span', null, message.text))
                  }
                  return null
                }),
                error.length > 0
                  ? h('div', { className: 'dsh-iv-err' }, error)
                  : null,
                pendingPrompt.length > 0
                  ? h('div', { className: 'dsh-iv-actions' },
                      h('button', { type: 'button', className: 'dsh-iv-btn dsh-iv-btn-primary dsh-iv-btn-sm', onClick: confirmPending }, '就这样出图'),
                      h('button', { type: 'button', className: 'dsh-iv-btn dsh-iv-btn-sm', onClick: () => setPendingPrompt('') }, '先不出'))
                  : null),

              h('div', { className: 'dsh-iv-compose' },
                h('div', { className: 'dsh-iv-tabs' },
                  h('button', {
                    type: 'button',
                    'aria-pressed': mode === 'direct' ? 'true' : 'false',
                    title: '直接出图：输入框里的文字就是最终提示词，直接发给图像模型，不经过对话模型',
                    onClick: () => setMode('direct'),
                  }, '直接出图'),
                  h('button', {
                    type: 'button',
                    'aria-pressed': mode === 'refine' ? 'true' : 'false',
                    title: '让 AI 写提示词：先把要求交给对话模型扩写成专业提示词，提示词显示在对话里，可以改了重出',
                    onClick: () => setMode('refine'),
                  }, '让 AI 写提示词')),
                h('div', { className: 'dsh-iv-field' },
                  h('span', { className: 'dsh-iv-fieldlabel' }, mode === 'direct' ? '提示词' : '你的要求'),
                  h('textarea', {
                    className: 'dsh-iv-in',
                    'data-mono': mode === 'direct' ? '1' : '0',
                    spellCheck: false,
                    value: draft,
                    placeholder: mode === 'direct' ? '写一条提示词，直接发给图像模型' : '用日常说法就行',
                    onChange: (e) => setDraft(e.target.value),
                  })),
                h('div', { className: 'dsh-iv-refs' },
                  h('button', { type: 'button', className: 'dsh-iv-refadd', title: '添加参考图（也可以直接粘贴）' }, '+'),
                  h('span', { className: 'dsh-iv-hint' }, '参考图 0/4')),
                h('div', { className: 'dsh-iv-callmodel' },
                  h('span', { className: 'dsh-iv-callmodellabel' }, '模型'),
                  modelChoices.length > 0
                    ? h('select', {
                        className: 'dsh-iv-in dsh-iv-callmodelsel',
                        value: pickModel(),
                        'data-override': callModel.length > 0 ? '1' : '0',
                        title: '本次出图用哪个模型。只作用于这一次，不改设置里的默认值。',
                        onChange: (e) => setCallModel(e.target.value),
                      }, modelChoices.map((id) => h('option', { key: id, value: id }, id)))
                    : h('span', { className: 'dsh-iv-hint' }, '还没有可用的图像模型 —— 请到「设置 › 模型」里添加'),
                  callModel.length > 0 && callModel !== String(config.model ?? '')
                    ? h('button', {
                        type: 'button',
                        className: 'dsh-iv-btn dsh-iv-btn-ghost dsh-iv-btn-sm',
                        title: `只这一次用 ${callModel}；点这里回到默认的 ${config.model}`,
                        onClick: () => setCallModel(''),
                      }, '回到默认')
                    : null),
                h('div', { className: 'dsh-iv-actions' },
                  h('button', {
                    type: 'button',
                    className: 'dsh-iv-btn dsh-iv-btn-primary',
                    disabled: busy || draft.trim().length === 0,
                    onClick: onGenerate,
                  }, busy ? '生成中…' : '生成'),
                  mode === 'refine'
                    ? h('button', {
                        type: 'button',
                        className: 'dsh-iv-btn',
                        disabled: busy || draft.trim().length === 0,
                        onClick: () => void composePrompt(draft.trim(), false),
                      }, '仅写提示词')
                    : null,
                  h('span', { className: 'dsh-iv-spacer' }),
                  h('span', { className: 'dsh-iv-hint' }, `${config.count ?? 1} 张 · ${config.resolution} · ${config.aspectRatio}`))))),

        h(SettingsDialog, {
          open: settingsOpen,
          config,
          keyInfo,
          onClose: () => setSettingsOpen(false),
          onSave: saveSettings,
          onForgetKey: forgetKey,
        }),

        lightboxNode))
    }
    exports.Workspace = Workspace

    /* ------------------------------------------------------------------ *
     * sidebar entry + registrations
     * ------------------------------------------------------------------ */

    /** Which panel the shell is showing. The entry sets it; `main` dispatches on it. */
    let activePanel = PANEL_KEY

    /**
     * The sidebar entry. Registered into `sidebar.panellist` — the sidebar's
     * global panel-icon list — which is where the reviewed design put it.
     */
    function SidebarEntry(props) {
      const ctx = props.ctx
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        if (ctx === undefined || typeof ctx.on !== 'function') return () => {}
        return ctx.on('layout/panel', () => bump((n) => n + 1))
      }, [ctx])
      const current = activePanel === PANEL_KEY
      return h('button', {
        type: 'button',
        className: 'dsh-iv-entry',
        'aria-current': current ? 'true' : 'false',
        title: '打开图像生成工作台',
        onClick: () => {
          activePanel = PANEL_KEY
          // `layout.selectPanel` is the shell's own navigation action; using it
          // instead of poking state directly keeps the shell's history and
          // sidebar highlighting consistent.
          try {
            const layout = ctx?.get?.('layout')
            if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_KEY)
          } catch {
            /* a shell without the layout service still renders the entry */
          }
          bump((n) => n + 1)
        },
      },
        h('span', { className: 'dsh-iv-entryicon' },
          h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' },
            h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 3 }),
            h('circle', { cx: 8.8, cy: 8.8, r: 1.7 }),
            h('path', { d: 'M21 15.5 16.2 11 7 20.2' }))),
        h('span', { className: 'dsh-iv-entrytxt' }, '图像生成'))
    }

    exports.SidebarEntry = SidebarEntry

    function apply(ctx) {
      ctx.effect(installStyles, 'openrouter-imagen-v2: styles')

      // The entry. `sidebar.panellist` is a list slot with replaceRisk none, so
      // this is purely additive and cannot shadow shipped UI.
      ctx.effect(
        () => ctx.slots.inject('sidebar.panellist', function* () {
          yield ctx.slots.register({ name: 'sidebar.panellist', id: 'openrouter-imagen-v2', order: 60, label: '图像生成' }, () => h(SidebarEntry, { ctx }))
        }),
        'openrouter-imagen-v2: sidebar entry',
      )

      // The workspace itself. `main` is the keyed "central panel selected by
      // sidebar entry id" slot; registering under our own key means the chat is
      // untouched and our view appears only while our entry is selected.
      ctx.effect(
        () => ctx.slots.inject('main', function* () {
          yield ctx.slots.register({ name: 'main', key: PANEL_KEY }, Workspace)
        }),
        'openrouter-imagen-v2: main view',
      )
    }

    exports.apply = apply
    exports.inject = ['slots']

    return module.exports
  },
})
