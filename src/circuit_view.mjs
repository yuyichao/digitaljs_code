//

'use strict';

import * as vscode from 'vscode';
import { WebviewMsgQueue } from './webview_msg_queue.mjs';

export class CircuitView {
    #panel
    #queue
    constructor(djs, focus, column) {
        this.#panel = vscode.window.createWebviewPanel(
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
        );
        this.#queue = new WebviewMsgQueue(this.#panel.webview);
        this.#panel.iconPath = djs.iconPath;
        this.onDidDispose = this.#panel.onDidDispose;
        this.onDidChangeViewState = this.#panel.onDidChangeViewState;
        this.#panel.webview.onDidReceiveMessage((msg) => {
            this.#queue.release();
            djs.processCommand(msg);
        });
        this.#getViewContent(djs, this.#panel.webview).then(content => {
            this.#panel.webview.html = content;
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
    reveal(column) {
        this.#panel.reveal(column);
    }
    post(msg) {
        this.#queue.post(msg);
    }
}
