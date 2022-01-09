//

'use strict';

export class StatusProvider {
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
