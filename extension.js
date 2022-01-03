//

'use strict';

// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const path = require('path');
const requests = require('./src/requests.js');

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    new DigitalJS(context);
}

// this method is called when your extension is deactivated
function deactivate() {
}

class SynthProvider {
    constructor(djs) {
        this.djs = djs;
    }
    processCommand(message, view, context) {
        switch (message.command) {
            case 'do-synth':
                this.djs.doSynth();
                return;
            case 'update-options':
                this.djs.synth_options = { ...message.options };
                return;
        }
    }
    resolveWebviewView(view, context, _token) {
        const ui_uri = this.djs.getUri(view.webview, this.djs.uiToolkitPath);
        const synth_uri = this.djs.getUri(view.webview, this.djs.synthJSPath);
        const icon_uri = this.djs.getUri(view.webview, this.djs.codIconsPath);
        view.webview.options = {
            enableScripts: true
        };
        view.webview.onDidReceiveMessage((msg) => this.processCommand(msg, view.webview,
                                                                      context));
        view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <script>
    window.init_options = ${JSON.stringify(this.djs.synth_options)};
  </script>
  <script type="module" src="${ui_uri}"></script>
  <script type="module" src="${synth_uri}"></script>
  <link href="${icon_uri}" rel="stylesheet"/>
</head>
<body>
  <vscode-checkbox title="Enables Yosys optimizations of the synthesized circuit. This might make the circuit differ significantly to its HDL specification. This corresponds to the 'opt -full' Yosys command." id="opt">Optimize in Yosys</vscode-checkbox>
  <vscode-checkbox title="Enables post-processing of Yosys output to reduce the number of components and improve readability." id="transform" checked>Simplify diagram</vscode-checkbox>
  <!-- <vscode-checkbox title="Enables checking for common problems using the Verilator compiler." id="lint" checked>Lint source code</vscode-checkbox> -->
  <vscode-dropdown title="Enables finite state machine processing in Yosys. This corresponds to the 'fsm' and 'fsm -nomap' Yosys commands." id="fsm">
    <vscode-option value="no">No FSM transform</vscode-option>
    <vscode-option value="yes">FSM transform</vscode-option>
    <vscode-option value="nomap">FSM as circuit element</vscode-option>
  </vscode-dropdown>
  <vscode-checkbox title="This corresponds to the 'fsm_expand' Yosys command." id="fsmexpand">Merge more logic into FSM</vscode-checkbox>
  <vscode-button id="do-synth"><i slot="start" class="codicon codicon-run"></i> Synthesize</vscode-button>
</body>
</html>`;
    }
}

class StatusProvider {
    constructor(djs) {
        this.djs = djs;
    }
    resolveWebviewView(view, context, _token) {
        const ui_uri = this.djs.getUri(view.webview, this.djs.uiToolkitPath);
        const status_uri = this.djs.getUri(view.webview, this.djs.statusJSPath);
        const icon_uri = this.djs.getUri(view.webview, this.djs.codIconsPath);
        view.webview.options = {
            enableScripts: true
        };
        let initialized = false;
        // Preserving the order of the messages.
        const pending_messages = [];
        view.webview.onDidReceiveMessage((msg) => {
            // we don't really care what message it is but if we've got a message
            // then the initialization has finished...
            if (!initialized) {
                for (const msg of pending_messages)
                    view.webview.postMessage(msg);
                pending_messages.length = 0;
                initialized = true;
            }
            switch (msg.command) {
                case 'iopanel:update':
                    this.djs.iopanelUpdateValue(msg.id, msg.value);
                    return;
            }
        });
        const postMessage = (msg) => {
            if (!initialized) {
                pending_messages.push(msg);
            }
            else {
                view.webview.postMessage(msg);
            }
        };
        this.djs.tickUpdated(async (tick) => {
            postMessage({ command: 'tick', tick });
        });
        this.djs.iopanelMessage(async (message) => {
            postMessage(message);
        });
        view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <script>
    window.acquireVsCodeApi = acquireVsCodeApi;
    window.init_view = ${JSON.stringify(this.djs.iopanelViews)};
  </script>
  <script type="module" src="${ui_uri}"></script>
  <script type="module" src="${status_uri}"></script>
  <link href="${icon_uri}" rel="stylesheet"/>
</head>
<body>
  <vscode-text-field id="clock" readonly value=${this.djs.tick}>
    <i slot="start" class="codicon codicon-clock"></i>
  </vscode-text-field>
  <table id="iopanel">
  </table>
</body>
</html>`;
    }
}

class CircuitFile extends vscode.TreeItem {
    constructor(uri) {
        let name = 'Unnamed circuit';
        if (uri)
            name = path.basename(uri.path);
        super(name, vscode.TreeItemCollapsibleState.Expanded);
        this.iconPath = new vscode.ThemeIcon('circuit-board');
        this.id = 'root-circuit';
        this.contextValue = 'root-circuit';
        this.resourceUri = uri;
    }
}

class SourceFile extends vscode.TreeItem {
    constructor(circuit, uri) {
        let name;
        if (circuit) {
            name = path.relative(path.dirname(circuit.path), uri.path);
        }
        else {
            name = path.basename(uri.path);
        }
        super(name, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('file');
        this.id = uri.toString();
        this.resourceUri = uri;
        this.contextValue = uri.path;
    }
}

class FilesMgr {
    constructor(djs) {
        this.djs = djs;
        this.circuit = undefined;
        this.sources = new Map();
        this.script_running = {};
        this.script_not_running = {};
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        vscode.commands.executeCommand('setContext', 'digitaljs.script_running', []);
        vscode.commands.executeCommand('setContext', 'digitaljs.script_not_running', []);
    }
    reset(circuit) {
        this.circuit = circuit;
        this.sources.clear();
        this.script_running = {};
        this.script_not_running = {};
        vscode.commands.executeCommand('setContext', 'digitaljs.script_running', []);
        vscode.commands.executeCommand('setContext', 'digitaljs.script_not_running', []);
    }
    refresh() {
        const state = { sources_uri: [] };
        if (this.circuit)
            state.circuit_uri = this.circuit.toString();
        for (let file of this.sources.values())
            state.sources_uri.push(file.toString());
        this.djs.context.workspaceState.update('digitaljs.files', state);
        this._onDidChangeTreeData.fire();
    }
    addSource(uri) {
        if (this.sources.has(uri.path))
            return;
        this.sources.set(uri.path, uri);
        if (path.extname(uri.path) == '.lua') {
            this.script_not_running[uri.path] = true;
            vscode.commands.executeCommand('setContext', 'digitaljs.script_not_running',
                                           Array.from(Object.keys(this.script_not_running)));
        }
    }
    deleteSource(uri) {
        this.sources.delete(uri.path);
        if (path.extname(uri.path) == '.lua') {
            delete this.script_not_running[uri.path];
            delete this.script_running[uri.path];
            vscode.commands.executeCommand('setContext', 'digitaljs.script_running',
                                           Array.from(Object.keys(this.script_running)));
            vscode.commands.executeCommand('setContext', 'digitaljs.script_not_running',
                                           Array.from(Object.keys(this.script_not_running)));
        }
    }
    scriptStarted(file) {
        delete this.script_not_running[file];
        this.script_running[file] = true;
        vscode.commands.executeCommand('setContext', 'digitaljs.script_running',
                                       Array.from(Object.keys(this.script_running)));
        vscode.commands.executeCommand('setContext', 'digitaljs.script_not_running',
                                       Array.from(Object.keys(this.script_not_running)));
        // The view item doesn't seem to be watching for the context change
        // to redraw the icons so we need to refresh it after updating the running state.
        this._onDidChangeTreeData.fire();
    }
    scriptStopped(file) {
        delete this.script_running[file];
        this.script_not_running[file] = true;
        vscode.commands.executeCommand('setContext', 'digitaljs.script_running',
                                       Array.from(Object.keys(this.script_running)));
        vscode.commands.executeCommand('setContext', 'digitaljs.script_not_running',
                                       Array.from(Object.keys(this.script_not_running)));
        this._onDidChangeTreeData.fire();
    }
    toJSON() {
        let res = [];
        const circuit_path = path.dirname(this.circuit.path);
        for (let file of this.sources.values())
            res.push(path.relative(circuit_path, file.path));
        return res;
    }

    getTreeItem(element) {
        return element;
    }
    async getChildren(element) {
        if (!element)
            return [new CircuitFile(this.circuit)];
        console.assert(element instanceof CircuitFile);
        let res = [];
        for (let file of this.sources.values())
            res.push(new SourceFile(this.circuit, file));
        return res;
    }
}

const default_synth_options = {
    opt: false,
    transform: true,
    // lint: true,
    fsm: 'no', // (no)/yes/nomap
    fsmexpand: false
};


class DigitalJS {
    constructor(context) {
        this.context = context;
        this.panel = undefined;
        const ext_uri = context.extensionUri;
        this.iconPath = vscode.Uri.joinPath(ext_uri, 'imgs', 'digitaljs.svg');
        this.mainJSPath = vscode.Uri.joinPath(ext_uri, 'dist', 'view-bundle.js');
        this.synthJSPath = vscode.Uri.joinPath(ext_uri, 'view', 'synth_view.js');
        this.statusJSPath = vscode.Uri.joinPath(ext_uri, 'dist', 'status_view.js');
        this.uiToolkitPath = vscode.Uri.joinPath(ext_uri, "node_modules", "@vscode",
                                                 "webview-ui-toolkit", "dist", "toolkit.js");
        this.codIconsPath = vscode.Uri.joinPath(ext_uri, "node_modules", "@vscode",
                                                "codicons", "dist", "codicon.css");
        this.simWorker = this.readSimWorker(vscode.Uri.joinPath(ext_uri, 'dist',
                                                                'digitaljs-sym-worker.js'));

        this.updateCircuitWaits = [];
        this.iopanelViews = [];
        this.iopanelViewIndices = {};

        this.files = new FilesMgr(this);
        this.dirty = false;
        this.circuit = { devices: {}, connectors: [], subcircuits: {} };
        this.tick = 0;
        this._tickUpdated = new vscode.EventEmitter();
        this.tickUpdated = this._tickUpdated.event;
        this.extra_data = {};
        this.synth_options = { ...default_synth_options };

        this._iopanelMessage = new vscode.EventEmitter();
        this.iopanelMessage = this._iopanelMessage.event;

        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.openView',
                                            () => this.openView()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.openViewJSON',
                                            (item) => this.openViewJSON(item)));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.openViewSource',
                                            (item) => this.openViewSource(item)));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.pause',
                                            () => this.pauseSim()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.start',
                                            () => this.startSim()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.fastForward',
                                            () => this.fastForwardSim()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.singleStep',
                                            () => this.singleStepSim()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.nextEvent',
                                            () => this.nextEventSim()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.newJSON',
                                            () => this.newJSON()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.openJSON',
                                            () => this.openJSON()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.addFiles',
                                            () => this.addFiles()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.saveJSON',
                                            () => this.saveJSON()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.saveAsJSON',
                                            () => this.saveAsJSON()));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.removeSource',
                                            (item) => this.removeSource(item)));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.startScript',
                                            (item) => this.startScript(item)));
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.stopScript',
                                            (item) => this.stopScript(item)));

        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('digitaljs-proj-synth',
                                                      new SynthProvider(this), {}));
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('digitaljs-proj-status',
                                                      new StatusProvider(this),
                                                      { webviewOptions: {
                                                          retainContextWhenHidden: true }}));
        context.subscriptions.push(
            vscode.window.registerTreeDataProvider('digitaljs-proj-files', this.files));

        vscode.commands.executeCommand('setContext', 'digitaljs.view_hascircuit', false);
        vscode.commands.executeCommand('setContext', 'digitaljs.view_running', false);
        vscode.commands.executeCommand('setContext', 'digitaljs.view_pendingEvents', false);
        this.restore();
    }
    async restore() {
        if (!(await this.restoreView()))
            return;
        // TODO options, extra data
        await this.restoreFiles();
        await this.restoreCircuit();
        this.showCircuit(false, true);
    }
    async restoreView() {
        const state = this.context.workspaceState.get('digitaljs.view');
        if (!state || !state.column)
            return false;
        await this.createOrShowView(state.visible, state.column);
        this.dirty = this.context.workspaceState.get('digitaljs.dirty');
        return true;
    }
    async restoreFiles() {
        const state = this.context.workspaceState.get('digitaljs.files');
        if (!state)
            return;
        if (!state.circuit_uri && (!state.sources_uri || !state.sources_uri.length))
            return;
        if (state.circuit_uri)
            this.files.circuit = vscode.Uri.parse(state.circuit_uri);
        if (state.sources_uri) {
            for (const file of state.sources_uri) {
                this.files.addSource(vscode.Uri.parse(file));
            }
        }
        this.files.refresh();
    }
    async restoreCircuit() {
        const circuit = this.context.workspaceState.get('digitaljs.circuit');
        if (circuit) {
            this.circuit = circuit;
            return;
        }
        if (this.files.circuit) {
            const json = await this.readJSONFile(this.files.circuit);
            for (const fld of ['devices', 'connectors', 'subcircuits']) {
                const v = json[fld];
                if (v)
                    this.circuit[fld] = v;
                delete json[fld];
            }
        }
    }
    setTick(tick) {
        this.tick = tick;
        this._tickUpdated.fire(tick);
    }
    async readSimWorker(file) {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
    }
    getUri(webview, uri) {
        return webview.asWebviewUri(uri);
    }
    showCircuit(transform, pause) {
        this.setTick(0);
        this.postPanelMessage({
            command: 'showcircuit',
            circuit: this.circuit,
            opts: { transform, pause }
        });
    }
    async doSynth() {
        // Compute a short version of the file name
        const basenames_map = {};
        for (let file of this.files.sources.values()) {
            if (path.extname(file.path) == '.lua')
                continue;
            let key = path.basename(file.path);
            const files = basenames_map[key];
            if (!files) {
                basenames_map[key] = [file];
            }
            else {
                files.push(file);
            }
        }
        if (Object.keys(basenames_map).length == 0)
            return vscode.window.showErrorMessage(`No source file added for synthesis.`);
        const file_map = {};
        const circuit_file = this.files.circuit;
        for (const basename in basenames_map) {
            const files = basenames_map[basename];
            if (files.length == 1) {
                file_map[basename] = files[0];
                continue;
            }
            for (const file of files) {
                let name;
                if (circuit_file) {
                    name = path.relative(path.dirname(circuit_file.path), file.path);
                }
                else {
                    name = file.path;
                }
                file_map[name] = file;
            }
        }
        const data = {};
        for (const key in file_map) {
            data[key] = new TextDecoder().decode(
                await vscode.workspace.fs.readFile(file_map[key]));
        }
        const transform = this.synth_options.transform;
        const opts = {
            optimize: this.synth_options.opt,
            fsm: this.synth_options.fsm == "no" ? "" : this.synth_options.fsm,
            fsmexpand: this.synth_options.fsmexpand,
            lint: false
        };
        let res;
        try {
            res = await requests.yosys2digitaljs({ files: data, options: opts });
        }
        catch (e) {
            // TODO yosys messages
            return vscode.window.showErrorMessage(`Synthesis error: ${e}`);
        }
        this.circuit = res.output;
        this.dirty = true;
        this.context.workspaceState.update('digitaljs.circuit', this.circuit);
        this.context.workspaceState.update('digitaljs.dirty', true);
        this.showCircuit(transform);
    }
    pauseSim() {
        this.postPanelMessage({ command: 'pausesim' });
    }
    startSim() {
        this.postPanelMessage({ command: 'startsim' });
    }
    fastForwardSim() {
        this.postPanelMessage({ command: 'fastforwardsim' });
    }
    singleStepSim() {
        this.postPanelMessage({ command: 'singlestepsim' });
    }
    nextEventSim() {
        this.postPanelMessage({ command: 'nexteventsim' });
    }
    toJSON() {
        return {
            files: this.files.toJSON(),
            options: this.synth_options,
            ...this.circuit,
            ...this.extra_data
        };
    }
    loadJSON(json, uri) {
        this.files.reset(uri);
        this.dirty = false;
        this.context.workspaceState.update('digitaljs.dirty', false);
        if ('files' in json) {
            const files = json.files;
            delete json.files;
            console.assert(uri);
            for (const file of files) {
                this.files.addSource(vscode.Uri.joinPath(uri, '..', file));
            }
        }
        if ('options' in json) {
            this.synth_options = json.options;
            delete json.options;
        }
        this.circuit = { devices: {}, connectors: [], subcircuits: {} };
        for (const fld of ['devices', 'connectors', 'subcircuits']) {
            const v = json[fld];
            if (v)
                this.circuit[fld] = v;
            delete json[fld];
        }
        this.context.workspaceState.update('digitaljs.circuit', this.circuit);
        this.extra_data = json;
        this.files.refresh();
        this.showCircuit(false);
    }
    async saveJSONToFile() {
        await new Promise((resolve) => {
            this.updateCircuitWaits.push(resolve);
            this.postPanelMessage({
                command: 'savecircuit',
            });
        });
        console.assert(this.files.circuit);
        const json = this.toJSON();
        const str = JSON.stringify(json);
        await vscode.workspace.fs.writeFile(this.files.circuit, new TextEncoder().encode(str));
        this.dirty = false;
        this.context.workspaceState.update('digitaljs.dirty', false);
    }
    async confirmUnsavedJSON() {
        if (!this.dirty)
            return true;
        const res = await vscode.window.showErrorMessage(`Save current circuit?`,
                                                         'Yes', 'No', 'Cancel');
        if (!res)
            return false;
        if (res == 'Yes')
            await this.saveJSON();
        return true;
    }
    async newJSON() {
        if (!(await this.confirmUnsavedJSON()))
            return;
        this.loadJSON({});
    }
    async readJSONFile(file) {
        let str;
        try {
            str = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
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
    async loadJSONFile(file) {
        const json = await this.readJSONFile(file);
        if (!json)
            return;
        this.loadJSON(json, file);
    }
    async openJSON() {
        if (!(await this.confirmUnsavedJSON()))
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
        return this.loadJSONFile(file[0]);
    }
    async addFiles() {
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
            this.files.addSource(file);
        this.files.refresh();
        this.dirty = true;
        this.context.workspaceState.update('digitaljs.dirty', true);
    }
    async saveJSON() {
        if (!this.files.circuit)
            return this.saveAsJSON();
        try {
            await this.saveJSONToFile();
        }
        catch (e) {
            return vscode.window.showErrorMessage(`Saving to ${this.files.circuit} failed: ${e}`);
        }
        return vscode.window.showInformationMessage(`Circuit saved to ${this.files.circuit}`);
    }
    async saveAsJSON() {
        const files = await vscode.window.showOpenDialog({
            filters: {
                "Circuit JSON": ['json'],
            }
        });
        if (!files)
            return;
        const file = files[0];
        const origin_circuit = this.files.circuit;
        this.files.circuit = file;
        try {
            await this.saveJSONToFile();
        }
        catch (e) {
            this.files.circuit = origin_circuit;
            return vscode.window.showErrorMessage(`Saving as ${file} failed: ${e}`);
        }
        this.files.refresh();
    }
    removeSource(item) {
        this.files.deleteSource(item.resourceUri);
        this.files.refresh();
    }
    async startScript(item) {
        const script = new TextDecoder().decode(await vscode.workspace.fs.readFile(item.resourceUri));
        this.postPanelMessage({
            command: 'runlua',
            name: item.resourceUri.path,
            script
        });
    }
    stopScript(item) {
        this.postPanelMessage({
            command: 'stoplua',
            name: item.resourceUri.path
        });
    }
    postPanelMessage(msg) {
        if (!this.panel)
            return;
        if (!this.panel_initialized) {
            this.panel_pending_messages.push(msg);
        }
        else {
            this.panel.webview.postMessage(msg);
        }
    }
    processCommand(message) {
        // we don't really care what message it is but if we've got a message
        // then the initialization has finished...
        if (!this.panel_initialized) {
            for (const msg of this.panel_pending_messages)
                this.panel.webview.postMessage(msg);
            this.panel_pending_messages.length = 0;
            this.panel_initialized = true;
        }
        if (message.command.startsWith('iopanel:')) {
            this.processIOPanelMessage(message);
            return;
        }
        switch (message.command) {
            case 'updatecircuit':
                this.circuit = message.circuit;
                this.dirty = true;
                this.context.workspaceState.update('digitaljs.circuit', this.circuit);
                this.context.workspaceState.update('digitaljs.dirty', true);
                let waits = this.updateCircuitWaits;
                this.updateCircuitWaits = [];
                for (const resolve of waits)
                    resolve(null);
                return;
            case 'tick':
                this.setTick(message.tick);
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
                this.files.scriptStarted(message.name);
                return;
            case 'luastop':
                this.files.scriptStopped(message.name);
                return;
            case 'luaerror': {
                let name = message.name;
                if (this.files.circuit)
                    name = path.relative(path.dirname(this.files.circuit.path), name);
                vscode.window.showErrorMessage(`${name}: ${message.message}`);
                return;
            }
            case 'luaprint': {
                let name = message.name;
                if (this.files.circuit)
                    name = path.relative(path.dirname(this.files.circuit.path), name);
                vscode.window.showInformationMessage(`${name}: ${message.messages.join('\t')}`);
                return;
            }
        }
    }
    processIOPanelMessage(message) {
        // Cache the state here for the status view at initialization time.
        switch (message.command) {
            case 'iopanel:view': {
                this.iopanelViewIndices = {};
                for (const idx in message.view)
                    this.iopanelViewIndices[message.view[idx]] = idx;
                this.iopanelViews = message.view;
            }
            case 'iopanel:update': {
                const idx = this.iopanelViewIndices[message.id];
                if (idx !== undefined) {
                    this.iopanelViews[idx].value = message.value;
                }
            }
        }
        this._iopanelMessage.fire(message);
    }
    iopanelUpdateValue(id, value) {
        this.postPanelMessage({ command: 'iopanel:update', id, value });
    }
    async openViewJSON(uri) {
        await this.createOrShowView(true);
        if (!(await this.confirmUnsavedJSON()))
            return;
        return this.loadJSONFile(uri);
    }
    async openViewSource(item) {
        await this.createOrShowView(true);
        this.files.addSource(uri);
        this.files.refresh();
        this.dirty = true;
    }
    async openView() {
        const active_editor = vscode.window.activeTextEditor;
        let uri;
        if (active_editor)
            uri = active_editor.document.uri;
        await this.createOrShowView(true);
        if (!uri)
            return;
        const ext = path.extname(uri.path);
        if (ext == '.json') {
            const res = await vscode.window.showInformationMessage(
                `Open ${uri.path} as circuit?`, 'Yes', 'No');
            if (res != 'Yes')
                return;
            if (!(await this.confirmUnsavedJSON()))
                return;
            return this.loadJSONFile(uri);
        }
        if (['.sv', '.v', '.vh', '.lua'].includes(ext)) {
            const res = await vscode.window.showInformationMessage(
                `Add ${uri.path} to current circuit?`, 'Yes', 'No');
            if (res != 'Yes')
                return;
            this.files.addSource(uri);
            this.files.refresh();
            this.dirty = true;
            return;
        }
    }
    async createOrShowView(focus, column) {
        const active = vscode.window.activeTextEditor;
        column = column || (active ? active.viewColumn : undefined);
        if (this.panel) {
            if (focus)
                this.panel.reveal(column);
            return;
        }
        vscode.commands.executeCommand('setContext', 'digitaljs.view_isactive', true);
        vscode.commands.executeCommand('setContext', 'digitaljs.view_isfocus', true);
        this.panel = vscode.window.createWebviewPanel(
            'digitaljs-mainview',
            'DigitalJS',
            {
                // The view is still brought to the front
                // even with preserveFocus set to true...
                preserveFocus: !focus,
                viewColumn: column || vscode.ViewColumn.One
            },
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        this.panel_initialized = false;
        this.panel_pending_messages = [];
        this.context.workspaceState.update('digitaljs.view',
                                           { column: this.panel.viewColumn, visible: true });
        this.panel.iconPath = this.iconPath;
        this.panel.onDidDispose(() => {
            // TODO: would be nice if we can try to save here
            // and maybe confirm if the user actually wants to close?
            vscode.commands.executeCommand('setContext', 'digitaljs.view_isactive', false);
            vscode.commands.executeCommand('setContext', 'digitaljs.view_isfocus', false);
            this.panel = undefined;
            this.files.reset();
            this.dirty = false;
            this.circuit = { devices: {}, connectors: [], subcircuits: {} };
            this.extra_data = {};
            this.context.workspaceState.update('digitaljs.view',
                                               { column: undefined, visible: false });
        });
        this.panel.onDidChangeViewState((e) => {
            vscode.commands.executeCommand('setContext', 'digitaljs.view_isfocus',
                                           this.panel.active);
            if (this.panel.visible)
                vscode.commands.executeCommand('digitaljs-proj-files.focus');
            this.context.workspaceState.update('digitaljs.view',
                                               { column: this.panel.viewColumn,
                                                 visible: this.panel.visible });
        });
        this.panel.webview.html = await this.getViewContent(this.panel.webview);
        this.panel.webview.onDidReceiveMessage((msg) => this.processCommand(msg));
        if (focus) {
            vscode.commands.executeCommand('digitaljs-proj-files.focus');
        }
    }
    async getViewContent(webview) {
        const js_uri = this.getUri(webview, this.mainJSPath);
        const ui_uri = this.getUri(webview, this.uiToolkitPath);
        const icon_uri = this.getUri(webview, this.codIconsPath);
        const worker_script = await this.simWorker;
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script>
    window.acquireVsCodeApi = acquireVsCodeApi;
    window.simWorkerUri = URL.createObjectURL(new Blob([${JSON.stringify(worker_script)}], {type: 'test/javascript'}));
  </script>
  <script type="module" src="${js_uri}"></script>
  <script type="module" src="${ui_uri}"></script>
  <link href="${icon_uri}" rel="stylesheet"/>
  <title>DigitalJS Code</title>
</head>
<body>
<div id="grid">
  <div id="paper"></div>
  <div id="gutter_vert" class="gutter gutter-vertical"></div>
  <div id="monitorbox">
    <div>
      <vscode-button name="ppt_up" title="Increase pixels per tick" disabled style="vertical-align: middle;"><i class="codicon codicon-add"></i></vscode-button>
      <vscode-button name="ppt_down" title="Decrease pixels per tick" disabled style="vertical-align: middle;"><i class="codicon codicon-dash"></i></vscode-button>
      <span style="color:var(--foreground);vertical-align:middle;">scale</span>
      <vscode-text-field name="scale" readonly style="vertical-align: middle;">
      </vscode-text-field>
      <vscode-button name="live" title="Pause plot" disabled style="vertical-align: middle;"><i class="codicon codicon-debug-pause"></i></vscode-button>
      <vscode-button name="left" title="Move left" disabled style="vertical-align: middle;"><i class="codicon codicon-arrow-small-left"></i></vscode-button>
      <vscode-button name="right" title="Move right" disabled style="vertical-align: middle;"><i class="codicon codicon-arrow-small-right"></i></vscode-button>
    </div>
    <div>
      <span style="color:var(--foreground);vertical-align:middle;">range</span>
      <vscode-text-field name="rangel" readonly style="vertical-align: middle;">
      </vscode-text-field>
      <span style="color:var(--foreground);vertical-align:middle;">-</span>
      <vscode-text-field name="rangeh" readonly style="vertical-align: middle;">
      </vscode-text-field>
    </div>
    <div id="monitor">
    </div>
  </div>
</div>
</body>
</html>`;
    }
}

module.exports = {
    activate,
    deactivate
}
