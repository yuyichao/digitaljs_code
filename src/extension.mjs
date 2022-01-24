//

'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import { set_yosys_wasm_uri } from './requests.mjs';
import { CircuitView } from './circuit_view.mjs';
import { Document } from './document.mjs';
import { FilesView } from './files_view.mjs';
import { SynthProvider } from './synth_provider.mjs';
import { StatusProvider } from './status_provider.mjs';
import { read_txt_file, write_txt_file } from './utils.mjs';

export function activate(context) {
    new DigitalJS(context);
}

export function deactivate() {
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
    constructor(context) {
        this.context = context;

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

        this.#document = new Document(undefined, {});
        this.#document.sourcesUpdated(() => {
            this.#sourcesUpdated.fire();
        });
        this.#document.synthOptionUpdated(() => {
            this.#synthOptionUpdated.fire();
        });
        this.#document.circuitUpdated(() => {
            this.#processMarker({});
            this.#circuitView.reveal();
        });
        this.#document.tickUpdated((tick) => {
            this.#tickUpdated.fire(tick);
        })
        this.#document.showMarker((editor_markers) => {
            this.#processMarker(editor_markers);
        });
        this.#document.documentEdited(() => {
            this.dirty = true;
        });
        this.#document.iopanelMessage((message) => {
            this.#iopanelMessage.fire(message);
        });
        this.#document.runStatesUpdated((states) => {
            vscode.commands.executeCommand('setContext', 'digitaljs.view_hascircuit',
                                           states.hascircuit);
            vscode.commands.executeCommand('setContext', 'digitaljs.view_running',
                                           states.running);
            vscode.commands.executeCommand('setContext', 'digitaljs.view_pendingEvents',
                                           states.pendingEvents);

        });
        this.dirty = false;
        this.#tickUpdated = new vscode.EventEmitter();
        this.tickUpdated = this.#tickUpdated.event;
        this.#sourcesUpdated = new vscode.EventEmitter();
        this.sourcesUpdated = this.#sourcesUpdated.event;

        this.#iopanelMessage = new vscode.EventEmitter();
        this.iopanelMessage = this.#iopanelMessage.event;
        this.#synthOptionUpdated = new vscode.EventEmitter();
        this.synthOptionUpdated = this.#synthOptionUpdated.event;

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
            vscode.commands.registerCommand('digitaljs.openJSON',
                                            () => this.#openJSON()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.addFiles',
                                            () => this.#addFiles()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.saveJSON',
                                            () => this.#saveJSON()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.saveAsJSON',
                                            () => this.#saveAsJSON()));
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

        context.subscriptions.push(this);

        vscode.commands.executeCommand('setContext', 'digitaljs.view_hascircuit', false);
        vscode.commands.executeCommand('setContext', 'digitaljs.view_running', false);
        vscode.commands.executeCommand('setContext', 'digitaljs.view_pendingEvents', false);
    }
    get tick() {
        return this.#document.tick;
    }
    get synth_options() {
        return this.#document.synth_options;
    }
    get scriptRunning() {
        return this.#document.sources.scriptRunning;
    }
    get scriptNotRunning() {
        return this.#document.sources.scriptNotRunning;
    }
    get doc_uri() {
        return this.#document.uri;
    }
    get doc_dir_uri() {
        return this.#document.sources.doc_dir_uri;
    }
    get sources_entries() {
        return this.#document.sources.entries();
    }
    get iopanelViews() {
        return this.#document.iopanelViews;
    }
    dispose() {
        this.#document.dispose();
        this.#filesView.dispose();
    }
    async doSynth() {
        await this.#document.doSynth();
    }
    updateOptions(options) {
        this.#document.synth_options = options;
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
    #processMarker(editor_markers) {
        for (const edit_info of Object.values(this.#editor_markers))
            edit_info.editor.setDecorations(this.highlightDecoType, []);
        for (const edit_info of Object.values(editor_markers))
            edit_info.editor.setDecorations(this.highlightDecoType, edit_info.markers);
        this.#editor_markers = editor_markers;
    }
    #loadJSON(json, uri) {
        this.#document.sources.doc_uri = uri;
        this.#document.revert(json);
        this.dirty = false;
    }
    async #confirmUnsavedJSON() {
        if (!this.dirty)
            return true;
        const res = await vscode.window.showErrorMessage(`Save current circuit?`,
                                                         'Yes', 'No', 'Cancel');
        if (!res || res == 'Cancel')
            return false;
        if (res == 'Yes')
            await this.#saveJSON();
        return true;
    }
    async #newJSON() {
        if (!(await this.#confirmUnsavedJSON()))
            return;
        this.#loadJSON({});
    }
    async #readJSONFile(file) {
        let str;
        try {
            str = await read_txt_file(file);
        }
        catch (e) {
            await vscode.window.showErrorMessage(`Cannot open ${file}: ${e}`);
            return;
        }
        let json;
        try {
            json = JSON.parse(str);
        }
        catch (e) {
            await vscode.window.showErrorMessage(`${file} is not a valid JSON file: ${e}`);
            return;
        }
        if (typeof json !== "object" || json === null) {
            await vscode.window.showErrorMessage(`${file} is not a valid JSON object.`);
            return;
        }
        return json;
    }
    async #loadJSONFile(file) {
        const json = await this.#readJSONFile(file);
        if (!json)
            return;
        this.#loadJSON(json, file);
    }
    async #openJSON() {
        if (!(await this.#confirmUnsavedJSON()))
            return;
        const file = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                "Circuit JSON": ['json'],
            }
        });
        if (!file)
            return;
        return this.#loadJSONFile(file[0]);
    }
    async #addFiles() {
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
        this.#document.addSources(files);
    }
    #saveJSON() {
        if (!this.#document.uri)
            return this.#saveAsJSON();
        return this.#document.save();
    }
    async #saveAsJSON() {
        const files = await vscode.window.showOpenDialog({
            filters: {
                "Circuit JSON": ['json'],
            }
        });
        if (!files)
            return;
        return this.#document.saveAs(files[0]);
    }
    #removeSource(item) {
        this.#document.removeSource(item.resourceUri);
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
    postPanelMessage(msg) {
        if (!this.#circuitView)
            return;
        this.#circuitView.post(msg);
    }
    async #openViewJSON(uri) {
        await this.#createOrShowView(true);
        if (!(await this.#confirmUnsavedJSON()))
            return;
        return this.#loadJSONFile(uri);
    }
    async #openViewSource(item) {
        await this.#createOrShowView(true);
        this.#document.addSources([item.resourceUri]);
    }
    async #openView() {
        const active_editor = vscode.window.activeTextEditor;
        let uri;
        if (active_editor)
            uri = active_editor.document.uri;
        await this.#createOrShowView(true);
        if (!uri)
            return;
        const ext = path.extname(uri.path);
        if (ext == '.json') {
            const res = await vscode.window.showInformationMessage(
                `Open ${uri.path} as circuit?`, 'Yes', 'No');
            if (res != 'Yes')
                return;
            if (!(await this.#confirmUnsavedJSON()))
                return;
            return this.#loadJSONFile(uri);
        }
        if (['.sv', '.v', '.vh', '.lua'].includes(ext)) {
            const res = await vscode.window.showInformationMessage(
                `Add ${uri.path} to current circuit?`, 'Yes', 'No');
            if (res != 'Yes')
                return;
            this.#document.addSources(uri);
            return;
        }
    }
    async #createOrShowView(focus, column) {
        const active = vscode.window.activeTextEditor;
        column = column || (active ? active.viewColumn : undefined);
        if (this.#circuitView) {
            if (focus)
                this.#circuitView.reveal(column);
            return;
        }
        column = column || vscode.ViewColumn.One;
        vscode.commands.executeCommand('setContext', 'digitaljs.view_isactive', true);
        vscode.commands.executeCommand('setContext', 'digitaljs.view_isfocus', true);
        this.#circuitView = new CircuitView(this, vscode.window.createWebviewPanel(
            'digitaljs-mainview',
            'DigitalJS',
            {
                // The view is still brought to the front
                // even with preserveFocus set to true...
                preserveFocus: !focus,
                viewColumn: column
            },
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        ), this.#document);
        this.#circuitView.onDidDispose(() => {
            // TODO: would be nice if we can try to save here
            // and maybe confirm if the user actually wants to close?
            vscode.commands.executeCommand('setContext', 'digitaljs.view_isactive', false);
            vscode.commands.executeCommand('setContext', 'digitaljs.view_isfocus', false);
            this.#circuitView = undefined;
            this.#processMarker({});
            this.#document.sources.doc_uri = undefined;
            this.#document.revert({});
            this.dirty = false;
        });
        this.#circuitView.onDidChangeViewState((e) => {
            const panel = e.webviewPanel;
            vscode.commands.executeCommand('setContext', 'digitaljs.view_isfocus',
                                           panel.active);
            if (panel.visible)
                vscode.commands.executeCommand('digitaljs-proj-files.focus');
        });
        if (focus) {
            vscode.commands.executeCommand('digitaljs-proj-files.focus');
        }
    }
}
