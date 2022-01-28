//

'use strict';

import { WebviewMsgQueue } from './webview_msg_queue.mjs';

export class StatusProvider {
    #djs
    constructor(djs) {
        this.#djs = djs;
    }
    resolveWebviewView(view, context, _token) {
        const ui_uri = view.webview.asWebviewUri(this.#djs.uiToolkitPath);
        const status_uri = view.webview.asWebviewUri(this.#djs.statusJSPath);
        const icon_uri = view.webview.asWebviewUri(this.#djs.codIconsPath);
        view.webview.options = {
            enableScripts: true
        };
        const queue = new WebviewMsgQueue(view.webview);
        view.webview.onDidReceiveMessage((msg) => {
            // we don't really care what message it is but if we've got a message
            // then the initialization has finished...
            queue.release();
            switch (msg.command) {
                case 'iopanel:update':
                    this.#djs.postPanelMessage({ command: 'iopanel:update',
                                                 id: msg.id, value: msg.value });
                    return;
                case 'panel-cmd':
                    this.#djs.postPanelMessage({ command: msg.panel_cmd });
                    return;
            }
        });
        const listeners = [];
        listeners.push(this.#djs.tickUpdated(async (tick) => {
            queue.post({ command: 'tick', tick });
        }));
        listeners.push(this.#djs.iopanelMessage(async (message) => {
            queue.post(message);
        }));
        listeners.push(this.#djs.runStatesUpdated(async (state) => {
            queue.post({ command: 'runstate', state });
        }));
        view.onDidDispose(() => {
            for (const listener of listeners) {
                listener.dispose();
            }
        });
        const rs = this.#djs.runStates;
        const enabled = b => b ? '' : 'disabled';
        view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <script>
    window.init_view = ${JSON.stringify(this.#djs.iopanelViews)};
  </script>
  <script type="module" src="${ui_uri}"></script>
  <script type="module" src="${status_uri}"></script>
  <link href="${icon_uri}" rel="stylesheet"/>
  <style>
     vscode-button[disabled].djs-start-stop-button {
       display: none !important;
     }
     vscode-button[disabled] {
       opacity: 25%;
     }
  </style>
</head>
<body style="display:flex;flex-direction:column;height:100vh">
  <div style="flex-grow:0;flex-shrink:0;margin-bottom:4px">
    <vscode-button id="start-sim" appearance="icon"
                   class="djs-start-stop-button" ${enabled(!rs.running)}>
      <i class="codicon codicon-run"></i>
    </vscode-button>
    <vscode-button id="pause-sim" appearance="icon"
                   class="djs-start-stop-button" ${enabled(rs.running)}>
      <i class="codicon codicon-debug-pause"></i>
    </vscode-button>
    <vscode-button id="fast-forward-sim" appearance="icon" ${enabled(!rs.running)}>
      <i class="codicon codicon-run-all"></i>
    </vscode-button>
    <vscode-button id="single-step-sim" appearance="icon" ${enabled(!rs.running)}>
      <i class="codicon codicon-debug-step-over"></i>
    </vscode-button>
    <vscode-button id="next-event-sim" appearance="icon"
                   ${enabled(!rs.running && rs.pendingEvents)}>
      <i class="codicon codicon-debug-continue"></i>
    </vscode-button>
  </div>
  <div style="flex-grow:0;flex-shrink:0;;margin-bottom:2px">
    <vscode-text-field id="clock" readonly value=${this.#djs.tick}>
      <i slot="start" class="codicon codicon-clock"></i>
    </vscode-text-field>
  </div>
  <div style="flex-grow:1;flex-shrink:1;min-height:0;overflow-y:scroll">
    <table id="iopanel">
    </table>
  </div>
</body>
</html>`;
    }
}
