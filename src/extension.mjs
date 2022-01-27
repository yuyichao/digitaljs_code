//

'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import { set_yosys_wasm_uri } from './requests.mjs';
import { EditorProvider } from './editor.mjs';
import { FilesView } from './files_view.mjs';
import { SynthProvider } from './synth_provider.mjs';
import { StatusProvider } from './status_provider.mjs';
import { read_txt_file, write_txt_file } from './utils.mjs';

export function activate(context) {
    new DigitalJS(context);
}

export function deactivate() {
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
    #synthOptionUpdated
    #circuitView
    #filesView
    #editor_markers = {}
    #untitled_tracker
    #pendingSources = []
    constructor(context) {
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
            vscode.commands.registerCommand('digitaljs.openViewJSON',
                                            (item) => this.#openViewJSON(item)));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.openViewSource',
                                            (item) => this.#openViewSource(item)));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.revealCircuit',
                                            () => this.#revealCircuit()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.pause',
                                            () => this.#pauseSim()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.start',
                                            () => this.#startSim()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.fastForward',
                                            () => this.#fastForwardSim()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.singleStep',
                                            () => this.#singleStepSim()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.nextEvent',
                                            () => this.#nextEventSim()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.newJSON',
                                            () => this.#newJSON()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.addFiles',
                                            () => this.#addFiles()));
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

        context.subscriptions.push(this);

        vscode.commands.executeCommand('setContext', 'digitaljs.view_hascircuit', false);
        vscode.commands.executeCommand('setContext', 'digitaljs.view_running', false);
        vscode.commands.executeCommand('setContext', 'digitaljs.view_pendingEvents', false);
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
    postPanelMessage(msg) {
        if (!this.#circuitView)
            return;
        this.#circuitView.post(msg);
    }
    #pauseSim() {
        this.postPanelMessage({ command: 'pausesim' });
    }
    #startSim() {
        this.postPanelMessage({ command: 'startsim' });
    }
    #fastForwardSim() {
        this.postPanelMessage({ command: 'fastforwardsim' });
    }
    #singleStepSim() {
        this.postPanelMessage({ command: 'singlestepsim' });
    }
    #nextEventSim() {
        this.postPanelMessage({ command: 'nexteventsim' });
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
            if (document !== this.#document)
                return;
            this.#processMarker(editor_markers);
        }));
        listeners.push(document.iopanelMessage((message) => {
            if (document !== this.#document)
                return;
            this.#iopanelMessage.fire(message);
        }));
        const set_runstates = (states) => {
            vscode.commands.executeCommand('setContext', 'digitaljs.view_hascircuit',
                                           states.hascircuit);
            vscode.commands.executeCommand('setContext', 'digitaljs.view_running',
                                           states.running);
            vscode.commands.executeCommand('setContext', 'digitaljs.view_pendingEvents',
                                           states.pendingEvents);
        };
        listeners.push(document.runStatesUpdated((states) => {
            if (document !== this.#document)
                return;
            set_runstates(states);
        }));

        const post_switch = () => {
            this.#sourcesUpdated.fire();
            this.#synthOptionUpdated.fire();
            this.#processMarker({});
            this.#tickUpdated.fire(this.tick);
            this.#iopanelMessage.fire({ command: 'iopanel:view', view: this.iopanelViews });
            set_runstates(this.runStates);
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
                return false;
            // v may or may not be linked in yet, check that first before unlinking.
            // v isn't the lates one so if it's linked in it must have a next.
            if (v._djs_next_view)
                unlink_view(v);
            link_view(d, v);

            post_switch();
            return true;
        };
        const on_view_state = () => {
            const panel = circuit_view.panel;
            if (panel.active) {
                if (switch_document(document, circuit_view))
                    vscode.commands.executeCommand('digitaljs-proj-files.focus');
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
            const uri = document.uri;
            if (uri.scheme === 'untitled') {
                const m = uri.path.match(/^circuit-(\d*)\.json$/);
                if (m) {
                    this.#untitled_tracker.free(parseInt(m[1]));
                }
            }
            for (const listener of listeners)
                listener.dispose();
            const was_active = this.#circuitView === circuit_view;
            unlink_view(this.#circuitView);
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

    #newJSON() {
        // The command "workbench.action.files.newUntitledFile"
        // can also be used to open a new circuit but it doesn't allow
        // adding a hint for the filename AFAICT.
        const id = this.#untitled_tracker.alloc();
        const uri_str = `untitled:circuit-${id}.json`;
        this.#openViewJSON(vscode.Uri.parse(uri_str));
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
            filters: {
                "SystemVerilog": ['sv'],
                "Verilog": ['v'],
                "Verilog HEX file": ['vh'],
                "Lua script": ['lua'],
            }
        });
        if (!files)
            return;
        document.addSources(files);
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
        const active_editor = vscode.window.activeTextEditor;
        const active_uri = active_editor ? active_editor.document.uri : undefined;
        if (uri.toString() == active_uri.toString())
            vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        vscode.commands.executeCommand("vscode.openWith", uri, EditorProvider.viewType);
    }
    #openViewSource(uri) {
        if (this.#circuitView) {
            this.#circuitView.reveal();
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
            this.#pendingSources.push({ uri, doc_uri: this.#newJSON() });
        }
    }
    async #openView() {
        const active_editor = vscode.window.activeTextEditor;
        let uri;
        if (active_editor)
            uri = active_editor.document.uri;
        const new_or_active = () => {
            if (this.#circuitView)
                return this.#circuitView.reveal();
            this.#newJSON();
        };
        // No active editor (or files of type we don't recognize, see below)
        // Switch to the latest view or open a new one.
        if (!uri)
            return new_or_active();
        // If we have this open as circuit already, switch to it.
        const exist_view = this.#findViewByURI(uri);
        if (exist_view)
            return exist_view.reveal();
        const ext = path.extname(uri.path);
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
            if (new_circuit && this.#circuitView)
                return this.#circuitView.reveal();
            return this.#newJSON();
        }
        else if (['.sv', '.v', '.vh', '.lua'].includes(ext)) {
            const res = await vscode.window.showInformationMessage(
                `Add ${uri.path} to current circuit?`, 'Yes', 'No');
            if (!res) // Cancelled
                return;
            if (res !== 'Yes')
                return new_or_active();
            this.#openViewSource(uri);
        }
        else {
            new_or_active();
        }
    }
}
