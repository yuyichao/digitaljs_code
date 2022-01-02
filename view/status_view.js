//

'use strict';

import $ from 'jquery';

const vscode = window.acquireVsCodeApi();

class Status {
    constructor() {
        window.addEventListener('message', event => this.processMessage(event));
        window.addEventListener("load", () => this.initialize());
    }
    initialize() {
        this.clock = document.getElementById("clock");
        // Release the messages from the main extension
        vscode.postMessage({ command: 'initialized' });
    }
    async processMessage(event) {
        const message = event.data;
        switch (message.command) {
            case 'tick':
                this.clock.value = message.tick;
                return;
        }
    }
}

new Status();
