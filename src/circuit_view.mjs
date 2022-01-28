//

'use strict';

import * as vscode from 'vscode';
import { WebviewMsgQueue } from './webview_msg_queue.mjs';

export class CircuitView {
    #panel
    #document
    #queue
    #init
    constructor(djs, panel, document) {
        this.#panel = panel;
        this.#document = document;
        this.#queue = new WebviewMsgQueue(this.#panel.webview);
        this.#panel.iconPath = djs.iconPath; // currently no effect for custom editor
        this.onDidDispose = this.#panel.onDidDispose;
        this.onDidChangeViewState = this.#panel.onDidChangeViewState;
        this.#panel.webview.onDidReceiveMessage((msg) => {
            this.#queue.release();
            this.#document.processCommand(msg);
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
    init() {
        return this.#init;
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
    reveal(column) {
        this.#panel.reveal(column);
    }
    post(msg) {
        this.#queue.post(msg);
    }
}
