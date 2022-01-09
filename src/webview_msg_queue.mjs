//

'use strict';

export class WebviewMsgQueue {
    #view
    #pending
    #initialized
    constructor(view) {
        this.#view = view;
        // Preserving the order of the messages.
        this.#pending = [];
        this.#initialized = false;
    }
    release() {
        if (!this.#initialized) {
            for (const msg of this.#pending)
                this.#view.postMessage(msg);
            this.#pending = 0;
            this.#initialized = true;
        }
    }
    post(msg) {
        if (!this.#initialized) {
            this.#pending.push(msg);
        }
        else {
            this.#view.postMessage(msg);
        }
    }
}
