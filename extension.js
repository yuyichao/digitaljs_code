// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const path = require('path');

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
                this.djs.synth_options = { ...context.state };
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
  <vscode-checkbox title="Enables checking for common problems using the Verilator compiler." id="lint" checked>Lint source code</vscode-checkbox>
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
        const icon_uri = this.djs.getUri(view.webview, this.djs.codIconsPath);
        view.webview.options = {
            enableScripts: true
        };
        view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <script type="module" src="${ui_uri}"></script>
  <link href="${icon_uri}" rel="stylesheet"/>
</head>
<body>
  <vscode-text-field id="clock" readonly>
    <i slot="start" class="codicon codicon-clock"></i>
  </vscode-text-field>
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
    }
}

class FilesMgr {
    constructor() {
        this.circuit = undefined;
        this.sources = new Map();
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    reset(circuit) {
        this.circuit = circuit;
        this.sources.clear();
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    addSource(uri) {
        if (this.sources.has(uri.path))
            return;
        this.sources.set(uri.path, uri);
    }
    deleteSource(uri) {
        this.sources.delete(uri.path);
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

class DigitalJS {
    constructor(context) {
        this.context = context;
        this.panel = undefined;
        const ext_uri = context.extensionUri;
        this.iconPath = vscode.Uri.joinPath(ext_uri, 'imgs', 'digitaljs.svg');
        this.mainJSPath = vscode.Uri.joinPath(ext_uri, 'dist', 'view-bundle.js');
        this.synthJSPath = vscode.Uri.joinPath(ext_uri, 'view', 'synth_view.js');
        this.uiToolkitPath = vscode.Uri.joinPath(ext_uri, "node_modules", "@vscode",
                                                 "webview-ui-toolkit", "dist", "toolkit.js");
        this.codIconsPath = vscode.Uri.joinPath(ext_uri, "node_modules", "@vscode",
                                                "codicons", "dist", "codicon.css");

        this.files = new FilesMgr();
        this.extra_data = {};

        this.synth_options = {
            opt: false,
            transform: true,
            lint: true,
            fsm: 'no', // (no)/yes/nomap
            fsmexpand: false
        };
        context.subscriptions.push(
            vscode.commands.registerCommand('digitaljs.openView',
                                            () => this.createOrShowView()));
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
            vscode.window.registerWebviewViewProvider('digitaljs-proj-synth',
                                                      new SynthProvider(this), {}));
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('digitaljs-proj-status',
                                                      new StatusProvider(this), {}));
        context.subscriptions.push(
            vscode.window.registerTreeDataProvider('digitaljs-proj-files', this.files));
    }
    getUri(webview, uri) {
        return webview.asWebviewUri(uri);
    }
    doSynth() {
        // TODO
    }
    pauseSim() {
        // TODO
    }
    startSim() {
        // TODO
    }
    fastForwardSim() {
        // TODO
    }
    singleStepSim() {
        // TODO
    }
    toJSON() {
        return {
            files: this.files.toJSON(),
            ...this.extra_data
        };
    }
    loadJSON(json, uri) {
        this.files.reset(uri);
        if ('files' in json) {
            const files = json.files;
            delete json.files;
            console.assert(uri);
            for (const file of files) {
                this.files.addSource(vscode.Uri.joinPath(uri, '..', file));
            }
        }
        // TODO
        this.extra_data = json;
        this.files.refresh();
    }
    async saveJSONToFile() {
        console.assert(this.files.circuit);
        const json = this.toJSON();
        const str = JSON.stringify(json);
        await vscode.workspace.fs.writeFile(this.files.circuit, new TextEncoder().encode(str));
    }
    async confirmUnsavedJSON() {
        // TODO: check and ask the user if the current circuit should be disgarded or saved.
        return true;
    }
    async newJSON() {
        if (!(await this.confirmUnsavedJSON()))
            return;
        this.loadJSON({});
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
        let str;
        try {
            str = new TextDecoder().decode(await vscode.workspace.fs.readFile(file[0]));
        }
        catch (e) {
            return vscode.window.showErrorMessage(`Cannot open ${file}: ${e}`);
        }
        let json;
        try {
            json = JSON.parse(str);
        }
        catch (e) {
            return vscode.window.showErrorMessage(`${file} is not a valid JSON file: ${e}`);
        }
        if (typeof json !== "object" || json === null)
            return vscode.window.showErrorMessage(`${file} is not a valid JSON object.`);
        this.loadJSON(json, file[0]);
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
    }
    async saveJSON() {
        if (!this.files.circuit)
            return this.saveAsJSON();
        try {
            await this.saveJSONToFile();
        }
        catch (e) {
            return vscode.window.showErrorMessage(`Saving to ${this.files.circuit} filed: ${e}`);
        }
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
            return vscode.window.showErrorMessage(`Saving as ${file} filed: ${e}`);
        }
        this.files.refresh();
    }
    createOrShowView() {
        const column = vscode.window.activeTextEditor ?
                       vscode.window.activeTextEditor.viewColumn : undefined;
        if (this.panel) {
            this.panel.reveal(column);
            return;
        }
        vscode.commands.executeCommand('setContext', 'digitaljs.view_isactive', true);
        vscode.commands.executeCommand('setContext', 'digitaljs.view_isfocus', true);
        this.panel = vscode.window.createWebviewPanel(
            'digitaljs-mainview',
            'DigitalJS',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        this.panel.iconPath = this.iconPath;
        this.panel.onDidDispose(() => {
            vscode.commands.executeCommand('setContext', 'digitaljs.view_isactive', false);
            this.panel = undefined;
        });
        this.panel.onDidChangeViewState((e) => {
            vscode.commands.executeCommand('setContext', 'digitaljs.view_isfocus',
                                           this.panel.active);
            if (this.panel.visible) {
                vscode.commands.executeCommand('digitaljs-proj-files.focus');
            }
        });
        this.panel.webview.html = this.getViewContent(this.panel.webview);
        vscode.commands.executeCommand('digitaljs-proj-files.focus');
    }
    getViewContent(webview) {
        const js_uri = this.getUri(webview, this.mainJSPath);
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script>
    window.acquireVsCodeApi = acquireVsCodeApi;
  </script>
  <script src="${js_uri}"></script>
  <title>DigitalJS Code</title>
</head>
<body>
<div id="grid">
  <div id="paper">
  </div>
  <div id="gutter_vert" class="gutter gutter-vertical"></div>
  <div id="monitorbox">
    <div class="btn-toolbar" role="toolbar" aria-label="Toolbar">
      <div class="symbola btn-group mr-2" role="group" aria-label="Scale control">
        <button name="ppt_up" type="button" class="btn btn-secondary" title="Increase pixels per tick" disabled="true">+</button>
        <button name="ppt_down" type="button" class="btn btn-secondary" title="Decrease pixels per tick" disabled="true">-</button>
      </div>
      <div class="input-group mr-2">
        <div class="input-group-prepend">
          <span class="input-group-text" title="Ticks per grid line">scale</span>
        </div>
        <input type="text" class="form-control" disabled="disabled" name="scale" />
      </div>
      <div class="symbola btn-group mr-2" role="group" aria-label="Time control">
        <button name="live" type="button" class="btn btn-secondary" title="Live mode" disabled="true">▶</button>
        <button name="left" type="button" class="btn btn-secondary" title="Move left" disabled="true">←</button>
        <button name="right" type="button" class="btn btn-secondary" title="Move right" disabled="true">→</button>
      </div>
      <div class="input-group mr-2">
        <div class="input-group-prepend">
          <span class="input-group-text" title="Display range">range</span>
        </div>
        <input type="text" class="form-control" disabled="disabled" name="rangel" />
        <div class="input-group-prepend input-group-append">
          <span class="input-group-text">–</span>
        </div>
        <input type="text" class="form-control" disabled="disabled" name="rangeh" />
      </div>
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
