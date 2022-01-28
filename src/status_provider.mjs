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
            }
        });
        const tick_listener = this.#djs.tickUpdated(async (tick) => {
            queue.post({ command: 'tick', tick });
        });
        const iopanel_listener = this.#djs.iopanelMessage(async (message) => {
            queue.post(message);
        });
        view.onDidDispose(() => {
            tick_listener.dispose();
            iopanel_listener.dispose();
        });
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
</head>
<body style="display:flex;flex-direction:column;height:100vh">
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
