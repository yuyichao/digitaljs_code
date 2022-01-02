//

const vscode = acquireVsCodeApi();

class Status {
    constructor() {
        this.initialized = new Promise((resolve) => {
            window.addEventListener("load", () => {
                this.initialize();
                resolve(null);
            });
        });
        window.addEventListener('message', event => this.processMessage(event));
    }
    initialize() {
        this.clock = document.getElementById("clock");
    }
    async processMessage(event) {
        const message = event.data;
        await this.initialized;
        switch (message.command) {
            case 'tick':
                this.clock.value = message.tick;
                return;
        }
    }
}

new Status();
