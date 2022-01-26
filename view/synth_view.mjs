//

'use strict';

const vscode = acquireVsCodeApi();

class Synth {
    #options
    #widgets
    #block_update = false
    constructor(options) {
        this.#options = options;
        window.addEventListener('message', event => this.#processMessage(event));
        window.addEventListener("load", () => this.#initialize());
    }
    #notifyOption() {
        vscode.setState({ ...this.#options, view_id: window.view_id });
        if (this.#block_update)
            return;
        vscode.postMessage({ command: "update-options", options: this.#options });
    }
    #initialize() {
        this.#widgets = {};
        for (const opt of ['opt', 'transform', /* 'lint', */ 'fsmexpand']) {
            const ele = document.getElementById(opt);
            this.#widgets[opt] = ele;
            ele.checked = this.#options[opt];
            ele.addEventListener('change', () => {
                this.#options[opt] = ele.checked;
                this.#notifyOption();
            });
        }

        const fsm = document.getElementById("fsm");
        this.#widgets.fsm = fsm;
        fsm.value = this.#options.fsm;
        fsm.addEventListener('change', () => {
            this.#options.fsm = fsm.value;
            this.#notifyOption();
        });

        const synth = document.getElementById("do-synth");
        synth.addEventListener("click", () => {
            vscode.postMessage({ command: "do-synth" });
        });

        vscode.postMessage({ command: 'initialized' });
        this.#notifyOption();
    }
    #setOptions(options) {
        this.#block_update = true;
        this.#options = options;
        try {
            for (const opt of ['opt', 'transform', /* 'lint', */ 'fsmexpand'])
                this.#widgets[opt].checked = this.#options[opt];
            this.#widgets.fsm.value = this.#options.fsm
        }
        finally {
            this.#block_update = false;
        }
    }
    #processMessage(event) {
        const message = event.data;
        switch (message.command) {
            case 'update-options':
                this.#setOptions(message.options);
                return;
        }
    }
}

{
    // When a new webview is recreated (i.e. a new run of resolveWebviewView)
    // it seems to inherit the state from the previous one,
    // and in this case the `window.init_options` is actually the more up-to-date one.
    // Distinguish this by keeping the view id in the state
    // and only accept states for the current view.
    // This still won't garantee we get the latest state since when the view is redrawn
    // without being destroyed there doesn't seem to be a way to recreate the state.
    // In that case, we'll use the saved state, which should be more up-to-date,
    // and there'll be another message with the lated info from the host as the reply
    // to the init message from the view.
    const state = vscode.getState();
    if (state && state.view_id == window.view_id) {
        delete state.view_id;
        new Synth(state);
    }
    else {
        new Synth(window.init_options);
    }
}
