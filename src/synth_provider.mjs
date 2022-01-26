//

'use strict';

import { WebviewMsgQueue } from './webview_msg_queue.mjs';

let view_id = 1;

export class SynthProvider {
    #djs
    constructor(djs) {
        this.#djs = djs;
    }
    #processCommand(message, view, context) {
        switch (message.command) {
            case 'do-synth':
                this.#djs.doSynth();
                return;
            case 'update-options':
                if (message.options._doc_id == this.#djs.doc_id) {
                    delete message.options._doc_id;
                    this.#djs.synth_options = message.options;
                }
                return;
        }
    }
    #extendedOptions() {
        return { ...this.#djs.synth_options, _doc_id: this.#djs.doc_id };
    }
    resolveWebviewView(view, context, _token) {
        const ui_uri = view.webview.asWebviewUri(this.#djs.uiToolkitPath);
        const synth_uri = view.webview.asWebviewUri(this.#djs.synthJSPath);
        const icon_uri = view.webview.asWebviewUri(this.#djs.codIconsPath);
        view.webview.options = {
            enableScripts: true
        };
        const queue = new WebviewMsgQueue(view.webview);
        const refresh_options = () => {
            queue.post({ command: "update-options", options: this.#extendedOptions() });
        };
        let first_init = true;
        view.webview.onDidReceiveMessage((msg) => {
            // we don't really care what message it is but if we've got a message
            // then the initialization has finished...
            queue.release();
            if (msg.command == 'init') {
                if (first_init) {
                    first_init = false;
                }
                else {
                    // If the view is reinited, it might have missed many update events.
                    // Send an update to make sure the view catches up with the changes...
                    refresh_options();
                }
                return;
            }
            this.#processCommand(msg, view.webview, context);
        });
        const option_listener = this.#djs.synthOptionUpdated(refresh_options);
        view.onDidDispose(() => {
            option_listener.dispose();
        });
        view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <script>
    window.view_id = ${view_id++}
    window.init_options = ${JSON.stringify(this.#extendedOptions())};
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
