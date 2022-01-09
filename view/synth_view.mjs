//

'use strict';

const vscode = acquireVsCodeApi();

class Synth {
    #options
    constructor(options) {
        this.#options = options;
        window.addEventListener("load", () => {
            this.#initialize();
        });
    }
    #notifyOption() {
        vscode.setState(this.#options);
        vscode.postMessage({ command: "update-options", options: this.#options });
    }
    #initialize() {
        for (const opt of ['opt', 'transform', /* 'lint', */ 'fsmexpand']) {
            const ele = document.getElementById(opt);
            ele.checked = this.#options[opt];
            ele.addEventListener('change', () => {
                this.#options[opt] = ele.checked;
                this.#notifyOption();
            });
        }

        const fsm = document.getElementById("fsm");
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
}

new Synth(vscode.getState() || window.init_options);
