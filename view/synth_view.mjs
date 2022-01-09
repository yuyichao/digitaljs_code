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
        vscode.setState(this.#options);
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

new Synth(vscode.getState() || window.init_options);
