//

'use strict';

import * as vscode from 'vscode';
import * as base64 from 'base64-arraybuffer';
import { WebviewMsgQueue } from './webview_msg_queue.mjs';

export class CircuitView {
    #panel
    #document
    #queue
    #init
    #subcircuits = {}
    constructor(djs, panel, document) {
        this.#panel = panel;
        this.#document = document;
        this.#queue = new WebviewMsgQueue(this.#panel.webview);
        this.#panel.iconPath = djs.iconPath; // currently no effect for custom editor
        this.onDidDispose = this.#panel.onDidDispose;
        this.onDidChangeViewState = this.#panel.onDidChangeViewState;
        this.#panel.webview.onDidReceiveMessage((msg) => {
            this.#queue.release();
            this.#processCommand(djs, msg);
        });
        let circuit_listener = this.#document.circuitUpdated((run) => {
            this.#showCircuit(run, false);
            this.reveal();
        });
        this.onDidDispose(() => {
            circuit_listener.dispose();
        });
        this.#init = this.#getViewContent(djs, this.#panel.webview).then(content => {
            this.#panel.webview.html = content;
            this.#showCircuit(false, true); // force pause
        });
    }
    get panel() {
        return this.#panel;
    }
    get document() {
        return this.#document;
    }
    get subcircuits() {
        return this.#subcircuits;
    }
    init() {
        return this.#init;
    }
    #processCommand(djs, msg) {
        switch (msg.command) {
            case 'subcircuits':
                this.#subcircuits = msg.subcircuits;
                return;
            case 'saveimg-error':
                return vscode.window.showErrorMessage(
                    `Unable to save image ${msg.uri}: ${msg.message}`);
            case 'saveimg': {
                const uri = vscode.Uri.parse(msg.uri);
                if (msg.base64) {
                    const data = base64.decode(msg.data);
                    return vscode.workspace.fs.writeFile(uri, new Uint8Array(data));
                }
                else {
                    return write_txt_file(uri, msg.data);
                }
            }
            case 'img-exts':
                djs.image_exts = msg.exts;
                return;
            case 'focus':
                this.reveal();
                return;
        }
        this.#document.processCommand(msg);
    }
    #showCircuit(run, pause) {
        this.post({
            command: 'showcircuit',
            circuit: this.#document.circuit,
            opts: { run, pause }
        });
    }
    async #getViewContent(djs, webview) {
        const js_uri = webview.asWebviewUri(djs.mainJSPath);
        const ui_uri = webview.asWebviewUri(djs.uiToolkitPath);
        const icon_uri = webview.asWebviewUri(djs.codIconsPath);
        const worker_script = await djs.simWorker;
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script>
    window.getImageSupport = ${!djs.image_exts_set};
    window.simWorkerUri = URL.createObjectURL(new Blob([${JSON.stringify(worker_script)}], {type: 'test/javascript'}));
  </script>
  <script type="module" src="${js_uri}"></script>
  <script type="module" src="${ui_uri}"></script>
  <link href="${icon_uri}" rel="stylesheet"/>
  <title>DigitalJS Code</title>
  <style>
    html > body, foreignObject > body {
      padding: 0 0;
    }
  </style>
</head>
<body>
<div id="grid">
  <div id="paper"></div>
  <div id="gutter_vert" class="gutter gutter-vertical"></div>
  <div id="monitorbox">
    <div style="margin-bottom:3px">
      <vscode-button appearance="icon" name="ppt_up" title="Increase pixels per tick" disabled style="vertical-align: middle;"><i class="codicon codicon-add"></i></vscode-button>
      <vscode-button appearance="icon" name="ppt_down" title="Decrease pixels per tick" disabled style="vertical-align: middle;"><i class="codicon codicon-dash"></i></vscode-button>
      <span style="color:var(--foreground);vertical-align:middle;">scale</span>
      <vscode-text-field name="scale" readonly style="vertical-align: middle;">
      </vscode-text-field>
      <vscode-button appearance="icon" name="live" title="Pause plot" disabled style="vertical-align: middle;"><i class="codicon codicon-debug-pause"></i></vscode-button>
      <vscode-button appearance="icon" name="left" title="Move left" disabled style="vertical-align: middle;"><i class="codicon codicon-arrow-small-left"></i></vscode-button>
      <vscode-button appearance="icon" name="right" title="Move right" disabled style="vertical-align: middle;"><i class="codicon codicon-arrow-small-right"></i></vscode-button>
    </div>
    <div style="margin-bottom:2px">
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
    reveal() {
        const col = this.#panel.viewColumn;
        // If viewColumn doesn't contain a valid column number,
        // vscode will attempt to show the view in the current column
        // which will create a new view for the editor and messes everything up...
        if (!col || col < 0)
            return;
        this.#panel.reveal(col);
    }
    post(msg) {
        this.#queue.post(msg);
    }
}
