//

'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import { set_yosys_wasm_uri } from './requests.mjs';
import { EditorProvider } from './editor.mjs';
import { FilesView } from './files_view.mjs';
import { LuaTerminal } from './lua_terminal.mjs';
import { SynthProvider } from './synth_provider.mjs';
import { StatusProvider } from './status_provider.mjs';
import { read_txt_file, write_txt_file } from './utils.mjs';
import { extension_formats } from '../lib/image_formats.mjs';

export function activate(context) {
    new DigitalJS(context);
}

export function deactivate() {
}

function active_editor_uri() {
    const active_editor = vscode.window.activeTextEditor;
    return active_editor ? active_editor.document.uri : undefined;
}

function find_workspace_uri(hint, workspaceFolders) {
    // Assume that workspaceFolders isn't empty.

    // Try to find a workspace uri best match with the hint uri.
    // Skip searching for length == 1 case
    // since we'll use the first one anyway...
    if (workspaceFolders.length > 1 && hint && hint.path) {
        for (const workdir of workspaceFolders) {
            const uri = workdir.uri;
            if (hint.scheme !== uri.scheme || hint.authority !== uri.authority || !path)
                continue;
            // check if it's a subpath
            let dir_path = uri.path;
            if (!dir_path.endsWith('/'))
                dir_path = dir_path + '/';
            if (hint.path.startsWith(dir_path)) {
                return uri;
            }
        }
    }
    // If we can't find a match, use the first one...
    return vscode.workspace.workspaceFolders[0].uri;
}

// I'm not sure how to supply a extension to untitled document
// while having vscode automatically pick up an unused document title for us
// so I think I'll need to calculate the file names myself.
// There might have been unsaved untitled document restored from the last session
// and AFAICT vscode doesn't tell us about it. We could potentially keep track of that
// in workspace storage but I'm not very confident that I can keep it up-to-date correctly...
class UntitledTracker {
    #used = {}
    alloc() {
        for (let i = 0; ; i++) {
            if (this.#used[i])
                continue;
            this.#used[i] = true;
            return i;
        }
    }
    free(i) {
        delete this.#used[i];
    }
}

class DigitalJS {
    #document
    #tickUpdated
    #sourcesUpdated
    #iopanelMessage
    #runStatesUpdated
    #synthOptionUpdated
    #circuitView
    #filesView
    #editor_markers = {}
    #untitled_tracker
    #pendingSources = []
    #image_exts_set = false
    #image_exts = ['png', 'jpg', 'jpeg']
    #global_state
    constructor(context) {
        this.#global_state = context.globalState;
        // Paths
        const ext_uri = context.extensionUri;
        this.iconPath = vscode.Uri.joinPath(ext_uri, 'imgs', 'digitaljs.svg');
        this.mainJSPath = vscode.Uri.joinPath(ext_uri, 'dist', 'view-bundle.js');
        this.synthJSPath = vscode.Uri.joinPath(ext_uri, 'dist', 'synth_view.js');
        this.statusJSPath = vscode.Uri.joinPath(ext_uri, 'dist', 'status_view.js');
        this.uiToolkitPath = vscode.Uri.joinPath(ext_uri, "node_modules", "@vscode",
                                                 "webview-ui-toolkit", "dist",
                                                 "toolkit.min.js");
        this.codIconsPath = vscode.Uri.joinPath(ext_uri, "node_modules", "@vscode",
                                                "codicons", "dist", "codicon.css");
        this.simWorker = read_txt_file(vscode.Uri.joinPath(ext_uri, 'dist',
                                                           'digitaljs-sym-worker.js'));
        set_yosys_wasm_uri(vscode.Uri.joinPath(ext_uri, "node_modules", "yosysjs",
                                               "dist", "yosys.wasm"));

        this.#tickUpdated = new vscode.EventEmitter();
        this.tickUpdated = this.#tickUpdated.event;
        this.#sourcesUpdated = new vscode.EventEmitter();
        this.sourcesUpdated = this.#sourcesUpdated.event;
        this.#iopanelMessage = new vscode.EventEmitter();
        this.iopanelMessage = this.#iopanelMessage.event;
        this.#runStatesUpdated = new vscode.EventEmitter();
        this.runStatesUpdated = this.#runStatesUpdated.event;
        this.#synthOptionUpdated = new vscode.EventEmitter();
        this.synthOptionUpdated = this.#synthOptionUpdated.event;

        this.#untitled_tracker = new UntitledTracker();

        this.highlightDecoType = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('peekViewEditor.matchHighlightBackground'),
            borderColor: new vscode.ThemeColor('peekViewEditor.matchHighlightBorder')
        });
        context.subscriptions.push(this.highlightDecoType);

        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.openView',
                                            () => this.#openView()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.showPanel',
                                            () => vscode.commands.executeCommand(
                                                'digitaljs-proj-files.focus')));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.openViewJSON',
                                            (item) => this.#openViewJSON(item)));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.addToViewSource',
                                            (item) => this.#openViewSource(item)));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.newViewSource',
                                            (item) => this.#openViewSource(item, true)));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.revealCircuit',
                                            () => this.#revealCircuit()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.pause',
                                            () => this.postPanelMessage({
                                                command: 'pausesim' })));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.start',
                                            () => this.postPanelMessage({
                                                command: 'startsim' })));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.newJSON',
                                            () => this.#newJSON(this.doc_uri, false)));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.addFiles',
                                            () => this.#addFiles()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.exportImage',
                                            () => this.#exportImage()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.showLuaTerminal',
                                            () => this.#showLuaTerminal()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.removeSource',
                                            (item) => this.#removeSource(item)));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.startScript',
                                            (item) => this.#startScript(item)));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.stopScript',
                                            (item) => this.#stopScript(item)));

        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('digitaljs-proj-synth',
                                                      new SynthProvider(this), {}));
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('digitaljs-proj-status',
                                                      new StatusProvider(this),
                                                      { webviewOptions: {
                                                          retainContextWhenHidden: true }}));
        this.#filesView = new FilesView(this);
        context.subscriptions.push(
            vscode.window.registerTreeDataProvider('digitaljs-proj-files', this.#filesView));

        context.subscriptions.push(
            vscode.window.registerCustomEditorProvider(
                EditorProvider.viewType,
                new EditorProvider(this),
                {
                    webviewOptions: { retainContextWhenHidden: true },
                    supportsMultipleEditorsPerDocument: false,
                }
        ));

        context.subscriptions.push(
            vscode.window.registerCustomEditorProvider(
                EditorProvider.viewType_json,
                new EditorProvider(this),
                {
                    webviewOptions: { retainContextWhenHidden: true },
                    supportsMultipleEditorsPerDocument: false,
                }
        ));

        context.subscriptions.push(this);

        this.runStatesUpdated((states) => {
            vscode.commands.executeCommand('setContext', 'digitaljs.view_hascircuit',
                                           states.hascircuit);
            vscode.commands.executeCommand('setContext', 'digitaljs.view_running',
                                           states.running);
        });

        vscode.commands.executeCommand('setContext', 'digitaljs.view_hascircuit', false);
        vscode.commands.executeCommand('setContext', 'digitaljs.view_running', false);
    }
    dispose() {
        this.#document.dispose();
        this.#filesView.dispose();
    }

    get doc_id() {
        if (this.#document)
            return this.#document.doc_id;
        return;
    }
    get tick() {
        if (this.#document)
            return this.#document.tick;
        return 0;
    }
    get synth_options() {
        if (this.#document)
            return this.#document.synth_options;
        return {};
    }
    set synth_options(options) {
        if (this.#document) {
            this.#document.synth_options = options;
        }
    }
    get scriptRunning() {
        if (this.#document)
            return this.#document.sources.scriptRunning;
        return [];
    }
    get scriptNotRunning() {
        if (this.#document)
            return this.#document.sources.scriptNotRunning;
        return [];
    }
    get doc_uri() {
        if (this.#document)
            return this.#document.uri;
        return;
    }
    get doc_dir_uri() {
        if (this.#document)
            return this.#document.sources.doc_dir_uri;
        return;
    }
    get sources_entries() {
        if (this.#document)
            return this.#document.sources.entries();
        return [];
    }
    get iopanelViews() {
        if (this.#document)
            return this.#document.iopanelViews;
        return [];
    }
    get runStates() {
        if (this.#document)
            return this.#document.runStates;
        return {};
    }
    async doSynth() {
        if (this.#document) {
            await this.#document.doSynth();
        }
    }
    set image_exts(exts) {
        this.#image_exts_set = true;
        this.#image_exts = ['svg', ...exts]; // SVG isn't part of the detection
    }
    get image_exts_set() {
        return this.#image_exts_set;
    }
    postPanelMessage(msg) {
        if (!this.#circuitView)
            return;
        this.#circuitView.post(msg);
    }
    async #startScript(item) {
        const uri = item.resourceUri;
        const uri_str = uri.toString();
        let script;
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.uri.toString() == uri_str) {
                script = doc.getText();
                continue;
            }
        }
        if (script === undefined)
            script = await read_txt_file(uri);
        this.postPanelMessage({
            command: 'runlua',
            name: item.resourceUri.toString(),
            script
        });
    }
    #stopScript(item) {
        this.postPanelMessage({
            command: 'stoplua',
            name: item.resourceUri.toString()
        });
    }
    #processMarker(editor_markers) {
        for (const edit_info of Object.values(this.#editor_markers))
            edit_info.editor.setDecorations(this.highlightDecoType, []);
        for (const edit_info of Object.values(editor_markers))
            edit_info.editor.setDecorations(this.highlightDecoType, edit_info.markers);
        this.#editor_markers = editor_markers;
    }

    #findViewByURI(uri) {
        const uri_str = uri.toString();
        for (let view = this.#circuitView; view; view = view._djs_prev_view) {
            if (view.document.uri.toString() == uri_str) {
                return view;
            }
        }
    }
    registerDocument(document, circuit_view) {
        vscode.commands.executeCommand('setContext', 'digitaljs.view_isactive', true);

        const listeners = [];
        listeners.push(document.sourcesUpdated(() => {
            if (document !== this.#document)
                return;
            this.#sourcesUpdated.fire();
        }));
        listeners.push(document.synthOptionUpdated(() => {
            if (document !== this.#document)
                return;
            this.#synthOptionUpdated.fire();
        }));
        listeners.push(document.circuitUpdated(() => {
            if (document !== this.#document)
                return;
            this.#processMarker({});
        }));
        listeners.push(document.tickUpdated((tick) => {
            if (document !== this.#document)
                return;
            this.#tickUpdated.fire(tick);
        }));
        listeners.push(document.showMarker((editor_markers) => {
            // No need to check if it's the current document
            // Markers from other visible but not active views should be shown as well
            // This can happen since mouse hovering doesn't switch focus by default.
            // (of course this doesn't really work if we have more than one cursor
            // but quite a few other things (like the mouse event tracking) doesn't work
            // either...)
            this.#processMarker(editor_markers);
        }));
        listeners.push(document.iopanelMessage((message) => {
            if (document !== this.#document)
                return;
            this.#iopanelMessage.fire(message);
        }));
        listeners.push(document.runStatesUpdated((states) => {
            if (document !== this.#document)
                return;
            this.#runStatesUpdated.fire(states);
        }));

        const post_switch = () => {
            this.#sourcesUpdated.fire();
            this.#synthOptionUpdated.fire();
            this.#processMarker({});
            this.#tickUpdated.fire(this.tick);
            this.#iopanelMessage.fire({ command: 'iopanel:view', view: this.iopanelViews });
            this.#runStatesUpdated.fire(this.runStates);
        };

        const link_view = (d, v) => {
            const prev = this.#circuitView;
            if (prev)
                prev._djs_next_view = v;
            this.#document = d;
            this.#circuitView = v;
            v._djs_prev_view = prev;
            v._djs_next_view = undefined;
        };
        const unlink_view = (v) => {
            const prev = v._djs_prev_view;
            const next = v._djs_next_view;
            v._djs_prev_view = undefined;
            v._djs_next_view = undefined;
            if (prev)
                prev._djs_next_view = next;
            if (next) {
                next._djs_prev_view = prev;
            }
            else {
                this.#document = prev ? prev.document : undefined;
                this.#circuitView = prev;
            }
        };
        const switch_document = (d, v) => {
            if (this.#circuitView === v)
                return;
            // v may or may not be linked in yet, check that first before unlinking.
            // v isn't the lates one so if it's linked in it must have a next.
            if (v._djs_next_view)
                unlink_view(v);
            link_view(d, v);

            post_switch();
        };
        let was_shown = false;
        const on_view_state = () => {
            const panel = circuit_view.panel;
            const active = panel.active;
            if (active) {
                switch_document(document, circuit_view);
                // Only switch to the digitaljs side panel
                // if this is the first time we show this circuit
                // or in general if the editor is shown as a result of a direct
                // interaction between the user and our extension.
                // In most cases the code that activate the editor will explicitly
                // show the side panel though we can't do that when we are opening new files
                // since the side panel might be hiden and can't be focused
                // (when first circuit is shown).
                // Therefore, we focus on our side panel on first show of the editor
                // to cover this case...
                if (!was_shown)
                    vscode.commands.executeCommand('digitaljs-proj-files.focus');
                was_shown = true;
                vscode.commands.executeCommand('setContext', 'digitaljs.view_isfocus', true);
            }
            else if (this.#document === document) {
                // Keep the last active document active in the side bars.
                vscode.commands.executeCommand('setContext', 'digitaljs.view_isfocus', false);
            }
        };
        circuit_view.onDidChangeViewState(on_view_state);
        on_view_state();
        // Make sure we links the new one in even if it's somehow hidden.
        switch_document(document, circuit_view);
        circuit_view.onDidDispose(() => {
            if (document.luaTerminal) {
                document.luaTerminal.dispose();
                document.luaTerminal = undefined;
            }
            const uri = document.uri;
            if (uri.scheme === 'untitled') {
                const m = uri.path.match(/\/circuit-(\d*)\.digitaljs$/);
                if (m) {
                    this.#untitled_tracker.free(parseInt(m[1]));
                }
            }
            for (const listener of listeners)
                listener.dispose();
            const was_active = this.#circuitView === circuit_view;
            unlink_view(circuit_view);
            if (was_active) {
                post_switch();
                vscode.commands.executeCommand('setContext', 'digitaljs.view_isfocus', false);
            }
            vscode.commands.executeCommand('setContext', 'digitaljs.view_isactive',
                                           !!this.#circuitView);
        });
        if (this.#pendingSources.length > 0) {
            const uri_str = document.uri.toString();
            const sources = [];
            for (const src of this.#pendingSources) {
                if (src.doc_uri == uri_str) {
                    sources.push(src.uri);
                }
            }
            document.addSources(sources);
            this.#pendingSources.length = 0;
        }
    }

    #newJSON(hint, use_workspace) {
        hint = hint || active_editor_uri();
        // The command "workbench.action.files.newUntitledFile"
        // can also be used to open a new circuit but it doesn't allow
        // adding a hint for the filename AFAICT.

        // When using a untitled: URI, vscode uses the components from the URI to determine
        // the default URI when saving.
        // In particular, the path will show up in the save dialog
        // and the authority will be exactly the same as the one in the untitled URI.
        // For the web version of vscode, not setting the autority correctly (or at all)
        // can make the file virtually unsavable and not setting the path can also make
        // the file difficult to save since not all paths are valid.
        // Note that text editors don't have this problem since the save function
        // for it uses FileDialogService::defaultFilePath to figure out the right URI to use
        // which takes care of this.

        // For this reason, we'll try our best to find a real URI in order to
        // make our file savable. There are other extensions which may add custom URI schemes
        // but hopefully we can either save with it or we won't run into them...
        // If we really can't find anything, we'll ignore the path/authrity and hope that
        // we'll only encounter it in a setting when we don't need them...
        // We'll also ignore the fragment and query part of the URI for now.
        // It shouldn't be needed for all the cases I'm aware of and we'll decide if
        // we need to include them or strip them when we find a real case.
        // Stripping them for now should hopefully be the least risky.
        const id = this.#untitled_tracker.alloc();
        const name = `circuit-${id}.digitaljs`;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!hint)
            use_workspace = true;
        if (!workspaceFolders || workspaceFolders.length == 0)
            use_workspace = false;

        let uri;
        if (!use_workspace && hint) {
            uri = vscode.Uri.from({ scheme: 'untitled', authority: hint.authority,
                                    path: path.join(path.dirname(hint.path), name) });
        }
        else if (use_workspace) {
            const dir_uri = find_workspace_uri(hint, workspaceFolders);
            uri = vscode.Uri.from({ scheme: 'untitled', authority: dir_uri.authority,
                                    path: path.join(dir_uri.path, name) });
        }
        else {
            // If we reached here, we know that there isn't any hint
            // (or we'd have either used that or use it to find a workspace)
            // or workspace folders (or !hint would have forced the use of it)
            // so let's just use the most minimum uri in this case...
            uri = vscode.Uri.from({ scheme: 'untitled', path: name });
        }
        const uri_str = uri.toString();;
        this.#openViewJSON(uri);
        return uri_str;
    }
    async #addFiles() {
        if (!this.#document)
            return;
        const document = this.#document;
        const files = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: true,
            openLabel: 'Add',
            title: 'Add Sources',
            filters: {
                "SystemVerilog (.sv)": ['sv'],
                "Verilog (.v)": ['v'],
                "Verilog HEX file (.vh)": ['vh'],
                "Lua script (.lua)": ['lua'],
            }
        });
        if (!files)
            return;
        document.addSources(files);
    }
    async #exportImage() {
        if (!this.#document)
            return;
        const subcircuits = this.#circuitView.subcircuits;
        let item;
        if (Object.entries(subcircuits).length > 0) {
            const items = [];
            items.push({ id: undefined, label: "toplevel" });
            for (const id in subcircuits) {
                const item = subcircuits[id];
                items.push({ id, label: item.title, description: item.type });
            }
            item = await vscode.window.showQuickPick(items, {
                title: 'Select (sub-)circuit to export'
            });
        }
        else {
            item = { id: undefined, label: "toplevel" };
        }
        if (!item)
            return;
        const default_name = item.id === undefined ? 'circuit.png' :
                             `${item.label.replaceAll(' ', '-')}.png`;
        let default_path = this.doc_dir_uri;
        if (default_path && default_path.scheme == 'untitled')
            default_path = undefined;
        if (!default_path) {
            const active = active_editor_uri();
            if (active) {
                default_path = active.with({ path: path.join(path.dirname(active.path), name) });
            }
        }
        if (!default_path)
            default_path = find_workspace_uri(undefined, vscode.workspace.workspaceFolders);
        const defaultUri = default_path ?
                           vscode.Uri.joinPath(default_path, default_name) : undefined;
        const file = await vscode.window.showSaveDialog({
            defaultUri,
            filters: {
                [`Images (.${this.#image_exts.join(', .')})`]: this.#image_exts,
            },
            openLabel: 'Export',
            title: 'Export circuit image',
        });
        if (!file)
            return;
        const ext = path.extname(file.path).toLowerCase();
        let img_type;
        if (ext === '.svg') {
            img_type = 'image/svg+xml';
        }
        else {
            img_type = extension_formats[ext];
            if (!img_type) {
                return vscode.window.showErrorMessage(
                    `Unable to save image ${message.uri}: unknown extension ${ext}`);
            }
        }
        const cmd = { command: 'exportimage',
                      type: img_type, uri: file.toString() }
        if (item.id !== undefined) {
            cmd.subcircuit = item.id;
            cmd.subcircuit_title = item.label;
        }
        this.postPanelMessage(cmd);
    }
    #showLuaTerminal() {
        const doc = this.#document;
        if (!doc)
            return;
        if (!doc.luaTerminal) {
            const pty = new LuaTerminal(this.#circuitView, this.#global_state);
            const term = vscode.window.createTerminal({
                iconPath: this.iconPath,
                name: `Lua ${path.basename(doc.uri.path)}`,
                pty: pty
            });
            doc.luaTerminal = term;
            pty.onDidDispose(() => delete doc.luaTerminal);
        }
        return doc.luaTerminal.show();
    }
    #removeSource(item) {
        if (!this.#document)
            return;
        this.#document.removeSource(item.resourceUri);
    }
    #revealCircuit() {
        if (this.#circuitView) {
            this.#circuitView.reveal();
        }
    }
    #openViewJSON(uri) {
        const active_uri = active_editor_uri();
        if (active_uri && uri.toString() == active_uri.toString())
            vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        vscode.commands.executeCommand("vscode.openWith", uri, EditorProvider.viewType);
    }
    #openViewSource(uri, force_new) {
        if (this.#circuitView && !force_new) {
            this.#circuitView.reveal();
            vscode.commands.executeCommand('digitaljs-proj-files.focus');
            this.#document.addSources([uri]);
        }
        else {
            // If we are creating a new document, we won't have the handle to the document
            // right after `#newJSON` returns.
            // Add the uri to an pending list and we'll add it
            // when the new document get registered.
            // Since the new untitled document creation isn't very reliable right now
            // and it's possible that we don't actually create a new document
            // we'll record the expected document uri as well
            // and only add it if the uri matches.
            // This way we can at least avoid action-at-a-distance kind of issues
            // where the sources that failed to be added get added later to
            // an unrelated document.
            this.#pendingSources.push({ uri, doc_uri: this.#newJSON(uri, false) });
        }
    }
    async #openView() {
        const uri = active_editor_uri();
        const new_or_active = () => {
            if (this.#circuitView) {
                vscode.commands.executeCommand('digitaljs-proj-files.focus');
                return this.#circuitView.reveal();
            }
            this.#newJSON(uri, true);
        };
        // No active editor (or files of type we don't recognize, see below)
        // Switch to the latest view or open a new one.
        if (!uri)
            return new_or_active();
        // If we have this open as circuit already, switch to it.
        const exist_view = this.#findViewByURI(uri);
        if (exist_view) {
            vscode.commands.executeCommand('digitaljs-proj-files.focus');
            return exist_view.reveal();
        }
        const ext = path.extname(uri.path);
        if (ext == '.digitaljs') {
            return this.#openViewJSON(uri);
        }
        if (ext == '.json') {
            // For json files, ask if the user want to open
            const new_circuit = !this.#circuitView;
            const res = await vscode.window.showInformationMessage(
                `Open ${uri.path} as circuit?`, 'Open',
                new_circuit ? 'New circuit' : 'Switch to last one');
            if (!res) // Cancelled
                return;
            if (res === 'Open')
                return this.#openViewJSON(uri);
            // Check circuitView again in case it was just closed
            if (new_circuit && this.#circuitView) {
                vscode.commands.executeCommand('digitaljs-proj-files.focus');
                return this.#circuitView.reveal();
            }
            return this.#newJSON(uri, false);
        }
        else if (['.sv', '.v', '.vh', '.lua'].includes(ext)) {
            // Source file already in current document.
            if (this.#document && this.#document.sources.findByURI(uri)) {
                vscode.commands.executeCommand('digitaljs-proj-files.focus');
                return this.#circuitView.reveal();
            }
            if (this.#circuitView) {
                const res = await vscode.window.showInformationMessage(
                    `Add ${uri.path} to?`, 'Current Circuit', 'New Circuit');
                if (!res) // Cancelled
                    return;
                this.#openViewSource(uri, res !== 'Add');
            }
            else {
                const res = await vscode.window.showInformationMessage(
                    `Add ${uri.path} to a new circuit?`, 'Yes', 'No');
                if (!res) // Cancelled
                    return;
                if (res !== 'Yes') {
                    // If we are not adding the source file,
                    // treat it the same as a non-source file
                    // and create a project in the workspace directory if possible.
                    this.#newJSON(uri, true);
                }
                else {
                    // Force adding to new circuit since that's what the user has confirmed.
                    this.#openViewSource(uri, true);
                }
            }
        }
        else {
            new_or_active();
        }
    }
}
