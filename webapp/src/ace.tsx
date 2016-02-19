import * as React from "react";
import * as pkg from "./package";
import * as core from "./core";
import * as srceditor from "./srceditor"
import * as compiler from "./compiler"
import * as sui from "./sui";
import * as data from "./data";

declare var require: any;
var ace: AceAjax.Ace = require("brace");

let SK = ts.mbit.SymbolKind;

var lf = Util.lf

require('brace/mode/typescript');
require('brace/mode/javascript');
require('brace/mode/json');
require('brace/mode/c_cpp');
require('brace/mode/text');
require('brace/mode/xml');
require('brace/mode/markdown');
require('brace/mode/assembly_armthumb');

require('brace/theme/sqlserver');
require('brace/theme/tomorrow_night_bright');

require("brace/ext/language_tools");
require("brace/ext/keybinding_menu");
require("brace/ext/searchbox");



var acequire = (ace as any).acequire;
var Range = acequire("ace/range").Range;
var HashHandler = acequire("ace/keyboard/hash_handler").HashHandler;

var placeholderChar = "◊";
var defaultImgLit = `
. . . . .
. . . . .
. . # . .
. . . . .
. . . . .
`
var maxCompleteItems = 20;

export interface CompletionEntry {
    name: string;
    symbolInfo: ts.mbit.SymbolInfo;
    lastScore: number;
    searchName: string;
    searchDesc: string;
}

export interface CompletionCache {
    apisInfo: ts.mbit.ApisInfo;
    completionInfo: ts.mbit.CompletionInfo;
    entries: CompletionEntry[];
    posTxt: string;
}

function fixupSearch(e: CompletionEntry) {
    e.searchName = (e.searchName || "").toLowerCase() + " ";
    e.searchDesc = " " + (e.searchDesc || "").toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
    return e
}

function mkSyntheticEntry(name: string, desc: string) {
    return fixupSearch({
        name: name,
        symbolInfo: {
            attributes: {
                jsDoc: desc,
            },
            name: name,
            namespace: "",
            kind: SK.None,
            parameters: null,
            retType: "",
        },
        lastScore: 0,
        searchName: name,
        searchDesc: desc,
    })
}

export class AceCompleter extends data.Component<{ parent: Editor; }, {
    visible?: boolean;
    cache?: CompletionCache;
    selectedEntry?: string;
}> {
    queryingFor: string;
    firstTime = true;
    completionRange: AceAjax.Range;
    keyHandler: any;
    entries: CompletionEntry[] = [];

    // ACE interface
    get activated() { return !!this.state.visible }
    showPopup() {
        this.setState({ visible: true })
    }
    detach() {
        this.entries = []
        if (this.state.visible)
            this.setState({
                visible: false,
                selectedEntry: null
            })
    }
    cancelContextMenu() { }

    queryCompletionAsync(pos: AceAjax.Position, posTxt: string) {
        if (this.queryingFor == posTxt) return Promise.resolve()

        this.queryingFor = posTxt
        let editor = this.props.parent.editor
        let str = editor.session.getValue()
        let lines = pos.row
        let chars = pos.column
        let i = 0;
        for (; i < str.length; ++i) {
            if (lines == 0) {
                if (chars-- == 0)
                    break;
            } else if (str[i] == '\n') lines--;
        }

        let cache: CompletionCache = {
            apisInfo: null,
            completionInfo: null,
            posTxt: posTxt,
            entries: []
        }

        return compiler.getApisInfoAsync()
            .then(info => {
                cache.apisInfo = info;
                console.log(info)
            })
            .then(() => compiler.workerOpAsync("getCompletions", {
                fileName: this.props.parent.currFile.getTypeScriptName(),
                fileContent: str,
                position: i
            }))
            .then(compl => {
                cache.completionInfo = compl;
                console.log(compl)
                let mkEntry = (q: string, si: ts.mbit.SymbolInfo) => fixupSearch({
                    name: si.isContextual ? si.name : q,
                    symbolInfo: si,
                    lastScore: 0,
                    searchDesc: q + " " + (si.attributes.jsDoc || ""),
                    searchName: si.name
                })
                if (!cache.completionInfo.isMemberCompletion)
                    Util.iterStringMap(cache.apisInfo.byQName, (k, v) => {
                        if (v.kind == SK.Method || v.kind == SK.Property) {
                            // don't know how to insert these yet
                        } else {
                            cache.entries.push(mkEntry(k, v))
                        }
                    })
                Util.iterStringMap(cache.completionInfo.entries, (k, v) => {
                    cache.entries.push(mkEntry(k, v))
                })
            })
            .then(() => this.setState({ cache: cache }))
    }

    fetchCompletionInfo(textPos: AceAjax.Position, pref: string, isTopLevel: boolean) {
        let posTxt = this.props.parent.currFile.getName() + ":" + textPos.row + ":" + textPos.column
        let cache = this.state.cache
        if (!cache || cache.posTxt != posTxt) {
            this.queryCompletionAsync(textPos, posTxt).done();
            return null;
        }

        if (cache.entries) {
            pref = pref.toLowerCase()
            let spcPref = " " + pref;
            for (let e of cache.entries) {
                e.lastScore = 0
                let idx = e.searchName.indexOf(pref)
                if (idx == 0)
                    e.lastScore += 100
                else if (idx > 0)
                    e.lastScore += 50
                else {
                    idx = e.searchDesc.indexOf(spcPref)
                    if (idx >= 0)
                        e.lastScore += 10;
                }
                let k = e.symbolInfo.kind
                if (isTopLevel) {
                    if (k == SK.Enum || k == SK.EnumMember)
                        e.lastScore *= 1e-5;
                }

                if (!e.symbolInfo.isContextual && (k == SK.Method || k == SK.Property))
                    e.lastScore *= 1e-3;

                if (e.symbolInfo.isContextual)
                    e.lastScore *= 1.1;
            }
            let res = cache.entries.filter(e => e.lastScore > 0);
            res.sort((a, b) => (b.lastScore - a.lastScore) || Util.strcmp(a.searchName, b.searchName))
            return res
        }

        return null
    }

    selectedIndex() {
        let idx = Util.indexOfMatching(this.entries, e => e.name == this.state.selectedEntry);
        if (idx < 0 && this.entries.length > 0)
            return 0;
        else
            return idx;
    }

    moveCursor(delta: number) {
        let pos = this.selectedIndex()
        pos += delta
        if (pos < 0) {
            this.detach()
        } else if (pos >= this.entries.length) {
            // do nothing
        } else {
            this.setState({ selectedEntry: this.entries[pos].name })
        }
    }

    initFirst() {
        let editor = this.props.parent.editor
        this.firstTime = false;
        editor.on("mousedown", () => this.detach())
        editor.on("mousewheel", () => this.detach())
        editor.on("change", e => {
            var cursor = (editor.selection as any).lead;
            if (this.completionRange) {
                let basePos = this.completionRange.start
                if (cursor.row != basePos.row || cursor.column < basePos.column) {
                    this.detach();
                }
            } else this.detach();
        });

        this.keyHandler = new HashHandler();
        this.keyHandler.bindKeys({
            "Up": () => this.moveCursor(-1),
            "Down": () => this.moveCursor(1),
            "Esc": () => this.detach(),
            "Return": () => this.commitAtCursorOrInsert("\n"),
            "Tab": () => this.commitAtCursorOrInsert("\t"),
        })
    }

    commitAtCursorOrInsert(s: string) {
        let editor = this.props.parent.editor
        let idx = this.selectedIndex()
        if (idx < 0) {
            editor.insert(s)
            this.detach()
        } else {
            this.commit(this.entries[idx])
        }
    }

    lookupInfo(name: string) {
        if (this.state.cache)
            return Util.lookup(this.state.cache.apisInfo.byQName, name)
        return null;
    }

    commit(e: CompletionEntry) {
        let editor = this.props.parent.editor
        if (!editor || !this.completionRange) return

        let text = e.name
        let si = e.symbolInfo

        if (si.kind == SK.None) return

        let imgLit = !!si.attributes.imageLiteral

        let defaultVal = (p: ts.mbit.ParameterDesc) => {
            if (p.initializer) return p.initializer
            if (p.defaults) return p.defaults[0]
            if (p.type == "number") return "0"
            else if (p.type == "string") {
                if (imgLit) {
                    imgLit = false
                    return "`" + defaultImgLit + "`";
                }
                return "\"\""
            }
            let si = this.lookupInfo(p.type)
            if (si && si.kind == SK.Enum) {
                let en = Util.values(this.state.cache.apisInfo.byQName).filter(e => e.namespace == p.type)[0]
                if (en)
                    return en.namespace + "." + en.name;
            }
            let m = /^\((.*)\) => (.*)$/.exec(p.type)
            if (m)
                return "(" + m[1] + ") => { }"
            return placeholderChar;
        }

        if (si.parameters) {
            text += "(" + si.parameters.map(defaultVal).join(", ") + ")"
        }

        editor.session.replace(this.completionRange, text);
        this.detach()
    }


    // React interface
    componentDidMount() {
        this.props.parent.completer = this;
    }

    componentDidUpdate() {
        core.scrollIntoView(this.child(".item.active"))
    }

    renderCore() {
        let editor = this.props.parent.editor
        if (!editor) return null

        if (this.keyHandler)
            (editor as any).keyBinding.removeKeyboardHandler(this.keyHandler);

        if (!this.state.visible) return null

        let mode = editor.session.getMode();
        if (mode.$id != "ace/mode/typescript") return null;

        if (this.firstTime)
            this.initFirst();

        (editor as any).keyBinding.addKeyboardHandler(this.keyHandler);
        let renderer: any = editor.renderer

        let textPos = editor.getCursorPosition();
        let line = editor.session.getLine(textPos.row);
        let linepref = line.slice(0, textPos.column)
        let m = /(\w*)$/.exec(linepref)
        let pref = m ? m[1] : ""
        let before = linepref.slice(0, linepref.length - pref.length).trim()
        let isTopLevel = !before || Util.endsWith(before, "{")  // }

        textPos.column -= pref.length

        let pos = renderer.$cursorLayer.getPixelPosition(textPos, false);
        pos.top -= renderer.scrollTop;
        pos.left -= renderer.scrollLeft;
        pos.top += renderer.layerConfig.lineHeight;
        pos.left += renderer.gutterWidth;

        let info = this.fetchCompletionInfo(textPos, pref, isTopLevel);

        if (!info) return null; // or Loading... ?

        let hasMore = false

        if (info.length > maxCompleteItems) {
            info = info.slice(0, maxCompleteItems)
            info.push(mkSyntheticEntry(lf("There's more!"), lf("Keep typing to explore functionality")))
            hasMore = true
        }

        this.entries = info;

        this.completionRange = new Range(textPos.row, textPos.column, textPos.row, textPos.column + pref.length);
        let idx = this.selectedIndex();

        let getArgs = (e: CompletionEntry) => {
            let si = e.symbolInfo
            let args = ""
            if (si.parameters) {
                args = "(" + si.parameters.map(p => p.name + ":" + friendlyTypeName(p.type)).join(", ") + ")"
            }
            if (si.retType && si.retType != "void")
                args += " : " + friendlyTypeName(si.retType)
            return args
        }

        return (
            <div className='ui vertical menu completer' style={{ left: pos.left + "px", top: pos.top + "px" }}>
                {info.map((e, i) =>
                    <sui.Item class={'link ' + (i == idx ? "active" : "") }
                        key={e.name}
                        onClick={() => this.commit(e) }
                        >
                        <div className="name">
                            <span className="funname">{highlight(e.name, pref) }</span>
                            <span className="args">{getArgs(e) }</span>
                        </div>
                        <div className="doc">
                            {highlight(e.symbolInfo.attributes.jsDoc || "", pref) }
                        </div>
                    </sui.Item>
                ) }
            </div>
        )
    }
}

function friendlyTypeName(tp: string) {
    if (tp == "() => void") return "Action"
    return tp.replace(/.*\./, "")
}

function highlight(text: string, str: string, limit = 100) {
    let tmp = text.toLowerCase();
    let spl: JSX.Element[] = []
    let written = 0
    while (true) {
        let idx = str ? tmp.indexOf(str) : -1
        let len = idx == 0 ? str.length :
            idx < 0 ? tmp.length : idx
        spl.push(<span key={spl.length} className={idx == 0 ? "highlight" : ""}>{text.slice(0, len) }</span>)
        text = text.slice(len)
        tmp = tmp.slice(len)
        written += len
        if (!tmp || written > limit)
            break;
    }
    return spl;
}

export class Editor extends srceditor.Editor {
    editor: AceAjax.Editor;
    currFile: pkg.File;
    completer: AceCompleter;
    isTypescript = false;

    menu() {
        return (
            <div className="item">
                <sui.DropdownMenu class="button floating" text={lf("Edit") } icon="edit">
                    <sui.Item icon="find" text={lf("Find") } onClick={() => this.editor.execCommand("find") } />
                    <sui.Item icon="wizard" text={lf("Replace") } onClick={() => this.editor.execCommand("replace") } />
                    <sui.Item icon="help circle" text={lf("Keyboard shortcuts") } onClick={() => this.editor.execCommand("showKeyboardShortcuts") } />
                </sui.DropdownMenu>
            </div>
        )
    }

    display() {
        return (
            <div>
                <div className='full-abs' id='aceEditorInner' />
                <AceCompleter parent={this} />
            </div>
        )
    }

    prepare() {
        this.editor = ace.edit("aceEditorInner");
        let langTools = acequire("ace/ext/language_tools");

        this.editor.commands.on("exec", (e: any) => {
            console.info("beforeExec", e.command.name)
        });

        let approvedCommands = {
            insertstring: 1,
            backspace: 1,
            Down: 1,
            Up: 1,
        }

        this.editor.commands.on("afterExec", (e: any) => {
            console.info("afterExec", e.command.name)
            if (this.isTypescript) {
                if (this.completer.activated) {
                    if (e.command.name == "insertstring" && !/^[\w]$/.test(e.args)) {
                        this.completer.detach();
                        if (e.args == ".")
                            this.completer.showPopup();
                    } else if (!approvedCommands.hasOwnProperty(e.command.name)) {
                        this.completer.detach();
                    } else {
                        this.completer.forceUpdate();
                    }
                } else {
                    if (e.command.name == "insertstring" && /^[a-zA-Z\.]$/.test(e.args)) {
                        this.completer.showPopup();
                    }
                }
            }

        });

        this.editor.commands.addCommand({
            name: "showKeyboardShortcuts",
            bindKey: { win: "Ctrl-Alt-h", mac: "Command-Alt-h" },
            exec: () => {
                let module = acequire("ace/ext/keybinding_menu")
                module.init(this.editor);
                (this.editor as any).showKeyboardShortcuts()
            }
        })

        let sess = this.editor.getSession()
        sess.setNewLineMode("unix");
        sess.setTabSize(4);
        sess.setUseSoftTabs(true);
        this.editor.$blockScrolling = Infinity;

        sess.on("change", () => {
            if (this.lastSet != null) {
                this.lastSet = null
            } else {
                this.changeCallback();
            }
        })

        this.isReady = true
    }

    getId() {
        return "aceEditor"
    }

    setTheme(theme: srceditor.Theme) {
        let th = theme.inverted ? 'ace/theme/tomorrow_night_bright' : 'ace/theme/sqlserver'
        if (this.editor.getTheme() != th) {
            this.editor.setTheme(th)
        }
        this.editor.setFontSize(theme.fontSize)
    }

    getViewState() {
        return this.editor.getCursorPosition()
    }

    getCurrentSource() {
        return this.editor.getValue()
    }

    acceptsFile(file: pkg.File) {
        return true
    }

    private lastSet: string;
    private setValue(v: string) {
        this.lastSet = v;
        this.editor.setValue(v, -1)
    }

    loadFile(file: pkg.File) {
        let ext = file.getExtension()
        let modeMap: any = {
            "cpp": "c_cpp",
            "json": "json",
            "md": "markdown",
            "ts": "typescript",
            "js": "javascript",
            "blocks": "xml",
            "asm": "assembly_armthumb"
        }
        let mode = "text"
        if (modeMap.hasOwnProperty(ext)) mode = modeMap[ext]
        let sess = this.editor.getSession()
        sess.setMode('ace/mode/' + mode);
        this.editor.setReadOnly(file.isReadonly());
        this.isTypescript = mode == "typescript";

        let curr = (this.editor as any).completer as AceCompleter;
        if (curr) curr.detach();
        if (this.isTypescript) {
            (this.editor as any).completer = this.completer;
            this.editor.setOptions({
                enableBasicAutocompletion: false,
                enableLiveAutocompletion: false
            });
        } else {
            (this.editor as any).completer = null;
            this.editor.setOptions({
                enableBasicAutocompletion: true,
                enableLiveAutocompletion: true
            });
        }

        this.currFile = file;
        this.setValue(file.content)
        this.setDiagnostics(file)
    }

    setDiagnostics(file: pkg.File) {
        let sess = this.editor.getSession();
        Object.keys(sess.getMarkers(true) || {}).forEach(m => sess.removeMarker(parseInt(m)))
        sess.clearAnnotations()
        let ann: AceAjax.Annotation[] = []
        if (file.diagnostics)
            for (let diagnostic of file.diagnostics) {
                const p0 = ts.getLineAndCharacterOfPosition(diagnostic.file, diagnostic.start);
                const p1 = ts.getLineAndCharacterOfPosition(diagnostic.file, diagnostic.start + diagnostic.length)
                ann.push({
                    row: p0.line,
                    column: p0.character,
                    text: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
                    type: "error"
                })
                sess.addMarker(new Range(p0.line, p0.character, p1.line, p1.character),
                    "ace_error-marker", "ts-error", true)
            }
        sess.setAnnotations(ann)
    }

    setViewState(pos: AceAjax.Position) {
        this.editor.moveCursorToPosition(pos)
        this.editor.scrollToLine(pos.row - 1, true, false, () => { })
    }
}
