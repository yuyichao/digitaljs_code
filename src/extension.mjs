//

'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import { set_yosys_wasm_uri } from './requests.mjs';
import { CircuitView } from './circuit_view.mjs';
import { FilesView } from './files_view.mjs';
import { Sources } from './sources.mjs';
import { SynthProvider } from './synth_provider.mjs';
import { StatusProvider } from './status_provider.mjs';
import { WebviewMsgQueue } from './webview_msg_queue.mjs';
import { rel_compat2, read_txt_file, write_txt_file } from './utils.mjs';

export function activate(context) {
    new DigitalJS(context);
}

export function deactivate() {
}

const default_synth_options = {
    opt: false,
    transform: true,
    // lint: true,
    fsm: 'no', // (no)/yes/nomap
    fsmexpand: false
};


class DigitalJS {
    #tickUpdated
    #iopanelMessage
    #iopanelViewIndices
    #circuitChanged
    #circuitView
    #synth_result
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

        this.iopanelViews = [];
        this.#iopanelViewIndices = {};

        this.sources = new Sources();

        this.dirty = false;
        this.#synth_result = { devices: {}, connectors: [], subcircuits: {} };
        this.tick = 0;
        this.#tickUpdated = new vscode.EventEmitter();
        this.tickUpdated = this.#tickUpdated.event;
        this.extra_data = {};
        this.synth_options = { ...default_synth_options };

        this.#iopanelMessage = new vscode.EventEmitter();
        this.iopanelMessage = this.#iopanelMessage.event;
        this.#circuitChanged = new vscode.EventEmitter();
        this.circuitChanged = this.#circuitChanged.event;

        this.highlightedEditors = [];
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
        context.subscriptions.push(
            vscode.window.registerTreeDataProvider('digitaljs-proj-files', new FilesView(this)));

        context.subscriptions.push(this);

        vscode.commands.executeCommand('setContext', 'digitaljs.view_hascircuit', false);
        vscode.commands.executeCommand('setContext', 'digitaljs.view_running', false);
        vscode.commands.executeCommand('setContext', 'digitaljs.view_pendingEvents', false);
    }
    dispose() {
        this.sources.dispose();
    }
    #setTick(tick) {
        this.tick = tick;
        this.#tickUpdated.fire(tick);
    }
    #showCircuit(pause) {
        this.#setTick(0);
        this.postPanelMessage({
            command: 'showcircuit',
            circuit: this.#synth_result,
            opts: { pause }
        });
    }
    async doSynth() {
        this.#clearMarker();
        // Load a snapshot of the options up front
        const res = await this.sources.doSynth({
            optimize: this.synth_options.opt,
            fsm: this.synth_options.fsm == "no" ? "" : this.synth_options.fsm,
            fsmexpand: this.synth_options.fsmexpand,
            lint: false,
            transform: this.synth_options.transform,
        });
        if (!res)
            return;
        this.#synth_result = res.output;
        this.dirty = true;
        this.#showCircuit();
        this.#circuitView.reveal();
    }
    updateOptions(options) {
        this.synth_options = { ...options };
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
    #toJSON() {
        const [sources, has_fullpath] = this.sources.toSave();
        if (has_fullpath)
            vscode.window.showWarningMessage(`Saved project contains full path to source file.`);
        return {
            sources: sources,
            options: this.synth_options,
            ...this.#synth_result,
            ...this.extra_data
        };
    }
    #load_sources(doc_uri, data) {
        if (data.sources) {
            this.sources.load(doc_uri, data.sources);
            return;
        }
        if (data.source_map) {
            const sources = [];
            for (const name in data.source_map)
                sources.push({ ...data.source_map[name], name });
            this.sources.load(doc_uri, sources);
        }
        if (data.files) {
            for (const file of data.files) {
                this.sources.addSource(vscode.Uri.joinPath(doc_uri, '..', file));
            }
        }
    }
    #loadJSON(json, uri) {
        this.#load_sources(uri, json);
        delete json.files;
        delete json.source_map;
        delete json.sources;

        this.dirty = false;
        if ('options' in json) {
            this.synth_options = json.options;
            delete json.options;
        }
        else {
            this.synth_options = { ...default_synth_options };
        }
        this.#synth_result = { devices: {}, connectors: [], subcircuits: {} };
        for (const fld of ['devices', 'connectors', 'subcircuits']) {
            const v = json[fld];
            if (v)
                this.#synth_result[fld] = v;
            delete json[fld];
        }
        this.extra_data = json;
        this.sources.refresh();
        this.#circuitChanged.fire();
        this.#showCircuit();
    }
    async #saveJSONToFile() {
        console.assert(this.sources.doc_uri);
        const json = this.#toJSON();
        const str = JSON.stringify(json);
        await write_txt_file(this.sources.doc_uri, str);
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
        for (const file of files)
            this.sources.addSource(file);
        this.sources.refresh();
        this.dirty = true;
    }
    async #saveJSON() {
        if (!this.sources.doc_uri)
            return this.#saveAsJSON();
        try {
            await this.#saveJSONToFile();
        }
        catch (e) {
            return vscode.window.showErrorMessage(`Saving to ${this.sources.doc_uri} failed: ${e}`);
        }
        return vscode.window.showInformationMessage(`Circuit saved to ${this.sources.doc_uri}`);
    }
    async #saveAsJSON() {
        const files = await vscode.window.showOpenDialog({
            filters: {
                "Circuit JSON": ['json'],
            }
        });
        if (!files)
            return;
        const file = files[0];
        const origin_doc = this.sources.doc_uri;
        this.sources.doc_uri = file;
        try {
            await this.#saveJSONToFile();
        }
        catch (e) {
            this.sources.doc_uri = origin_doc;
            return vscode.window.showErrorMessage(`Saving as ${file} failed: ${e}`);
        }
        this.sources.refresh();
    }
    #removeSource(item) {
        this.sources.deleteSource(item.resourceUri);
        this.sources.refresh();
        this.dirty = true;
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
    #showMarker(markers) {
        const editor_map = {};
        const getEditorInfo = (name) => {
            let edit_info = editor_map[name];
            if (edit_info)
                return edit_info;
            const src_info = this.sources.findByName(name);
            if (!src_info)
                return;
            const editor = src_info.findEditor();
            if (!editor)
                return;
            this.highlightedEditors.push(editor);
            edit_info = { editor, markers: [] };
            editor_map[name] = edit_info;
            return edit_info;
        };
        for (const marker of markers) {
            const edit_info = getEditorInfo(marker.name);
            if (!edit_info)
                continue;
            edit_info.markers.push(new vscode.Range(marker.from_line, marker.from_col,
                                                    marker.to_line, marker.to_col));
        }
        for (const name in editor_map) {
            const edit_info = editor_map[name];
            edit_info.editor.setDecorations(this.highlightDecoType, edit_info.markers);
        }
    }
    #clearMarker() {
        for (const editor of this.highlightedEditors)
            editor.setDecorations(this.highlightDecoType, []);
        this.highlightedEditors.length = 0;
    }
    postPanelMessage(msg) {
        if (!this.#circuitView)
            return;
        this.#circuitView.post(msg);
    }
    processCommand(message) {
        if (message.command.startsWith('iopanel:')) {
            this.#processIOPanelMessage(message);
            return;
        }
        switch (message.command) {
            case 'updatecircuit':
                this.#synth_result = message.circuit;
                this.dirty = true;
                return;
            case 'tick':
                this.#setTick(message.tick);
                return;
            case 'runstate':
                vscode.commands.executeCommand('setContext', 'digitaljs.view_hascircuit',
                                               message.hascircuit);
                vscode.commands.executeCommand('setContext', 'digitaljs.view_running',
                                               message.running);
                vscode.commands.executeCommand('setContext', 'digitaljs.view_pendingEvents',
                                               message.hasPendingEvents);
                return;
            case 'luastarted':
                this.sources.scriptStarted(message.name);
                return;
            case 'luastop':
                this.sources.scriptStopped(message.name);
                return;
            case 'luaerror': {
                let name = message.name;
                let uri = vscode.Uri.parse(name);
                if (rel_compat2(this.sources.doc_dir_uri, uri))
                    name = path.relative(this.sources.doc_dir_uri.path, uri.path);
                vscode.window.showErrorMessage(`${name}: ${message.message}`);
                return;
            }
            case 'luaprint': {
                let name = message.name;
                let uri = vscode.Uri.parse(name);
                if (rel_compat2(this.sources.doc_dir_uri, uri))
                    name = path.relative(this.sources.doc_dir_uri.path, uri.path);
                vscode.window.showInformationMessage(`${name}: ${message.messages.join('\t')}`);
                return;
            }
            case 'showmarker':
                return this.#showMarker(message.markers);
            case 'clearmarker':
                return this.#clearMarker();
        }
    }
    #processIOPanelMessage(message) {
        // Cache the state here for the status view at initialization time.
        switch (message.command) {
            case 'iopanel:view': {
                this.#iopanelViewIndices = {};
                for (const idx in message.view)
                    this.#iopanelViewIndices[message.view[idx]] = idx;
                this.iopanelViews = message.view;
            }
            case 'iopanel:update': {
                const idx = this.#iopanelViewIndices[message.id];
                if (idx !== undefined) {
                    this.iopanelViews[idx].value = message.value;
                }
            }
        }
        this.#iopanelMessage.fire(message);
    }
    async #openViewJSON(uri) {
        await this.#createOrShowView(true);
        if (!(await this.#confirmUnsavedJSON()))
            return;
        return this.#loadJSONFile(uri);
    }
    async #openViewSource(item) {
        await this.#createOrShowView(true);
        this.sources.addSource(uri);
        this.sources.refresh();
        this.dirty = true;
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
            this.sources.addSource(uri);
            this.sources.refresh();
            this.dirty = true;
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
        this.#circuitView = new CircuitView(this, focus, column);
        this.#circuitView.onDidDispose(() => {
            // TODO: would be nice if we can try to save here
            // and maybe confirm if the user actually wants to close?
            vscode.commands.executeCommand('setContext', 'digitaljs.view_isactive', false);
            vscode.commands.executeCommand('setContext', 'digitaljs.view_isfocus', false);
            this.#circuitView = undefined;
            this.dirty = false;
            this.#synth_result = { devices: {}, connectors: [], subcircuits: {} };
            this.sources.dispose();
            this.sources = new Sources();
            this.extra_data = {};
            this.#clearMarker();
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
